const { onRequest } = require("firebase-functions/https");
const { admin, db, logger } = require("./config");
const { stripe, STRIPE_WEBHOOK_SECRET } = require("./stripeConfig");
const { sendRefundEmailInternal } = require("./emails");

const getProfessionalPayoutAmount = (planId) => {
  switch (planId) {
    case "QUICK_8":
      return 12; // $12.00
    case "FULL_15":
      return 21; // $21.00
    case "EXTENDED_20":
      return 30; // $30.00
    default:
      return 0;
  }
};

const createPaymentIntent = onRequest(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Access-Control-Allow-Methods", "POST");
      res.set("Access-Control-Allow-Headers", "Content-Type");
      res.status(204).send("");
      return;
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { amount, userId, sessionId } = req.body;

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: "usd",
      automatic_payment_methods: {
        enabled: true,
      },
      metadata: { userId, sessionId },
    });

    res.set("Access-Control-Allow-Origin", "*");
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    logger.error("Stripe error:", error);
    res.set("Access-Control-Allow-Origin", "*");
    res
      .status(500)
      .json({ error: error.message, code: error.code || "internal_error" });
  }
});

const stripeWebhook = onRequest(
  { region: "us-central1", invoker: "public" },
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        sig,
        STRIPE_WEBHOOK_SECRET,
      );
    } catch (err) {
      logger.error(`⚠️ Webhook signature verification failed.`, err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "payment_intent.succeeded") {
      const session = event.data.object;
      logger.info("Payment event received:", session.id);

      const sessionId = session.metadata?.sessionId;
      const userId = session.metadata?.userId;
      const transactionId = event?.id || session.id;

      if (!sessionId) {
        logger.error(
          `Missing sessionId in metadata for session: ${session.id}`,
        );
        return res.status(400).send("Missing sessionId in metadata.");
      }

      if (!userId) {
        logger.error(
          `Missing userId in metadata for session: ${session.id}`,
        );
        return res.status(400).send("Missing userId in metadata.");
      }

      try {
        const sessionRef = db.collection("sessions").doc(sessionId);
        const sessionDoc = await sessionRef.get();

        if (!sessionDoc.exists) {
          logger.error(`Session doc not found in Firestore: ${sessionId}`);
          return res.status(404).send("Session document not found.");
        }

        const sessionData = sessionDoc.data();
        const planId = sessionData.plan_id;

        const professionalAmount = getProfessionalPayoutAmount(planId);

        if (professionalAmount === 0) {
          logger.warn(
            `Unknown plan_id "${planId}" for session ${sessionId}. professional_amount set to 0.`,
          );
        }

        const amountPaid = session.amount / 100;

        await sessionRef.update({
          paymentstatus: true,
          status: "PAYMENT_CONFIRMED",
          transactionId: transactionId,
          stripeSessionId: session.id,
          amountPaid: amountPaid,
          professional_amount: professionalAmount,
          paymentDate: admin.firestore.FieldValue.serverTimestamp(),
          eligibleForPayout: true,
        });

        logger.info(
          `Session ${sessionId} updated. plan_id: ${planId}, professional_amount: $${professionalAmount}`,
        );
        res.status(200).json({ received: true });
      } catch (dbError) {
        logger.error(`Error updating Firestore document:`, dbError);
        res.status(500).send("Internal Server Error");
      }
    } else if (event.type === "payment_intent.payment_failed") {
      const session = event.data.object;
      logger.info("Payment failed event received:", session.id);

      const sessionId = session.metadata?.sessionId;
      const transactionId = event?.id || session.id;

      if (!sessionId) {
        logger.error(
          `Missing sessionId in metadata for session: ${session.id}`,
        );
        return res.status(400).send("Missing sessionId in metadata.");
      }

      try {
        const sessionRef = db.collection("sessions").doc(sessionId);
        await sessionRef.update({
          paymentstatus: false,
          status: "PAYMENT_FAILED",
          transactionId: transactionId,
          stripeSessionId: session.id,
          paymentDate: admin.firestore.FieldValue.serverTimestamp(),
        });
        res.status(200).json({ received: true });
      } catch (dbError) {
        logger.error(`Error updating Firestore document on failure:`, dbError);
        res.status(500).send("Internal Server Error");
      }
    } else if (event.type === "charge.refunded") {
      const charge = event.data.object;
      logger.info("Charge refunded event received:", charge.id);

      const paymentIntentId = charge.payment_intent;
      if (!paymentIntentId) {
        logger.error(`Missing payment_intent in charge object: ${charge.id}`);
        return res.status(400).send("Missing payment_intent in charge.");
      }

      try {
        const sessionQuery = await db.collection("sessions")
          .where("stripeSessionId", "==", paymentIntentId)
          .get();

        if (sessionQuery.empty) {
          logger.error(`No session document found in Firestore with stripeSessionId: ${paymentIntentId}`);
          return res.status(204).send("Session document not found.");
        }

        const sessionDoc = sessionQuery.docs[0];
        const sessionId = sessionDoc.id;
        const sessionData = sessionDoc.data();

        await sessionDoc.ref.update({
          status: "REFUNDED",
          refundedAt: admin.firestore.FieldValue.serverTimestamp(),
          amountRefunded: charge.amount_refunded / 100,
          eligibleForPayout: false,
          payoutStatus: true,
        });

        logger.info(`Session ${sessionId} status updated to REFUNDED via webhook.`);

        const userId = sessionData.userid || sessionData.userId || sessionData.userID;
        await sendRefundEmailInternal(sessionData, userId, sessionId, charge.amount_refunded / 100);

        res.status(200).json({ received: true });
      } catch (dbError) {
        logger.error(`Error updating Firestore document on refund:`, dbError);
        res.status(500).send("Internal Server Error");
      }
    } else {
      res.status(200).json({ received: true });
    }
  },
);

const refundBooking = onRequest(
  { region: "us-central1", invoker: "public" },
  async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        res.set("Access-Control-Allow-Origin", "*");
        res.set("Access-Control-Allow-Methods", "POST");
        res.set("Access-Control-Allow-Headers", "Content-Type");
        res.status(204).send("");
        return;
      }

      if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
      }

      const { sessionId } = req.body || {};

      if (!sessionId) {
        return res
          .status(400)
          .json({ error: "Missing required field: sessionId" });
      }

      const sessionRef = db.collection("sessions").doc(sessionId);

      try {
        const sessionDoc = await sessionRef.get();
        if (!sessionDoc.exists) {
          return res
            .status(404)
            .json({ error: `Session not found: ${sessionId}` });
        }

        const sessionData = sessionDoc.data();
        const paymentIntent = sessionData.stripeSessionId;
        const amount = sessionData.amountPaid;

        await stripe.refunds.create({
          payment_intent: paymentIntent,
          amount: Math.round(amount * 100),
        });

        await sessionRef.update({
          status: "REFUNDED",
          refundedAt: admin.firestore.FieldValue.serverTimestamp(),
          eligibleForPayout: false,
          payoutStatus: true,
        });

        logger.info(`refundBooking: Refunded session ${sessionId}`);
        return res.status(200).json({ success: true });
      } catch (error) {
        logger.error(`refundBooking: Failed for session ${sessionId}`, error);
        return res.status(500).json({ error: error.message });
      }
    } catch (error) {
      logger.error("Stripe error:", error);
      res.set("Access-Control-Allow-Origin", "*");
      res.status(500).json({ error: error.message });
    }
  },
);

module.exports = { createPaymentIntent, stripeWebhook, refundBooking };
