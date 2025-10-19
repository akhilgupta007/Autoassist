require("dotenv").config();

const { setGlobalOptions } = require("firebase-functions");
const { onRequest, onCall } = require("firebase-functions/https");
const logger = require("firebase-functions/logger");
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { onSchedule } = require("firebase-functions/scheduler");

setGlobalOptions({ maxInstances: 10 });

const STRIPE_SECRET = process.env.STRIPE_SECRET;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
if (!STRIPE_SECRET) logger.error("Missing STRIPE_SECRET");
if (!STRIPE_WEBHOOK_SECRET) logger.warn("Missing STRIPE_WEBHOOK_SECRET (webhook will fail)");
const stripe = require("stripe")(STRIPE_SECRET);

// Initialize Firebase Admin if needed
admin.initializeApp();
const db = admin.firestore()
// Use onRequest instead of onCall for HTTP POST requests

// A simple function to calculate the split.
const calculateSplit = (totalAmount, professionalPercentage) => {
  const professionalAmount = totalAmount * (professionalPercentage / 100);
  const ourAmount = totalAmount - professionalAmount;
  return {
    professionalAmount: parseFloat(professionalAmount.toFixed(2)),
    ourAmount: parseFloat(ourAmount.toFixed(2)),
  };
};

const getProfessionalPayoutAmount = (plan) => {
  switch (plan) {
    case "Quick Assist (8 Min) - $19.99":
      return 12;
    case "Full Assist (15 Min) - $29.99":
      return 21;
    case "Extended Assist (20 Min) - $39.99":
      return 30;
    default:
      return 0;
  }
};

exports.createCheckoutSession = onRequest(
  { region: "us-central1", cors: true },
  async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        logger.info("Hello")
        res.set("Access-Control-Allow-Origin", "*");
        res.set("Access-Control-Allow-Methods", "POST");
        res.set("Access-Control-Allow-Headers", "Content-Type");
        res.status(204).send("");
        return;
      }

      // Only allow POST requests
      if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
      }

      logger.info("Request body:", req.body);
      const { price, userId, sessionId } = req.body;

      if (!price || !userId || !sessionId) {
        return res.status(400).json({
          error: "Missing required parameters: price and userId"
        });
      }

      // Create a Stripe Price object first, then use its ID
      const stripePrice = await stripe.prices.create({
        unit_amount: Math.round(price * 100), // Convert to cents
        currency: 'usd',
        product_data: {
          name: 'AutoAssist Service',
        },
      });

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price: stripePrice.id,
            quantity: 1,
          },
        ],
        mode: 'payment',
        success_url: `autoassistliveprod://autoassistliveprod.com/U7userFOUNDpaywall`,
        cancel_url: 'autoassistliveprod://autoassistliveprod.com/U7userFOUNDpaywall',
        metadata: {
          userId: userId,
          sessionId: sessionId
        }
      });

      res.set("Access-Control-Allow-Origin", "*");
      res.json({ url: session.url });

    } catch (error) {
      console.error("Stripe error:", error);
      res.set("Access-Control-Allow-Origin", "*");
      res.status(500).json({
        error: error.message,
        code: error.code || "internal_error"
      });
    }
  }
);

exports.stripeWebhook = onRequest(
  { region: "us-central1", invoker: "public" },
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        sig,
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      logger.error(`⚠️ Webhook signature verification failed.`, err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      logger.info("Checkout session completed:", session.id);

      // Extract metadata
      const sessionId = session.metadata.sessionId;
      const transactionId = event?.id || session.id;

      if (!sessionId) {
        logger.error(`Missing sessionId in metadata for session: ${session.id}`);
        return res.status(400).send("Missing sessionId in metadata.");
      }

      try {
        // Reference the document in the 'sessions' collection using the sessionId
        const sessionRef = admin.firestore().collection("sessions").doc(sessionId);

        // Update the session document with payment details
        await sessionRef.update({
          paymentstatus: true,
          transactionId: transactionId,
          stripeSessionId: session.id, // Good practice to store the Stripe session ID
          amountPaid: session.amount_total / 100,
          paymentDate: admin.firestore.FieldValue.serverTimestamp(),
          // You can add more fields here like 'currency', 'customerId', etc.
        });

        logger.info(
          `Successfully updated session ${sessionId} with payment status 'paid'.`
        );
        res.status(200).json({ received: true });
      } catch (dbError) {
        logger.error(`Error updating Firestore document:`, dbError);
        res.status(500).send("Internal Server Error");
      }
    } else {
      // Return a response for other event types
      res.status(200).json({ received: true });
    }
  }
);

exports.createExpressAccount = onRequest({ region: "us-central1", cors: true },
  async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        res.set("Access-Control-Allow-Origin", "*");
        res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
        res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
        return res.status(204).send("");
      }

      res.set("Access-Control-Allow-Origin", "*");
      if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
      }

      const { email, uid } = req.body || {};
      if (!email) return res.status(400).json({ error: "Missing email" });
      if (!uid) return res.status(400).json({ error: "Missing uid" });


      const return_url = "autoassistliveprod://autoassistliveprod.com/A7PROPaymentpageDRAWER";
      const refresh_url = "autoassistliveprod://autoassistliveprod.com/A7PROPaymentpageDRAWER";


      // 1) Create (or reuse) a Connect account
      const account = await stripe.accounts.create({
        country: "US",
        type: "express",
        email,
        business_type: "individual",
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_profile: {
          mcc: "7392",
          url: "https://autoassistlive.com",
          product_description: "Independent mechanic offering live automotive repair consultations via video chat on the Auto Assist LIVE platform.",
        },
      });
      logger.info("Account created", { accountId: account.id, uid });

      // 2) Create onboarding link with valid https return/refresh URLs
      const accountLink = await stripe.accountLinks.create({
        account: account.id,
        type: "account_onboarding",
        return_url,
        refresh_url,
        collect: "eventually_due",
      });
      logger.info("Account Link", { url: accountLink.url });

      // 3) Persist mapping (idempotent)
      await db.collection("professionalID").doc(uid).set({
        account_id: account.id,
        email,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      return res.status(200).json({
        success: true,
        accountId: account.id,
        accountLink: accountLink.url,
      });

    } catch (error) {
      logger.error("Stripe error", error);
      res.set("Access-Control-Allow-Origin", "*");
      return res.status(500).json({
        error: error.message,
        code: error.code || "internal_error",
        param: error.param,
      });
    }
  }
);

exports.weeklyProPayouts = onSchedule(
  {
    schedule: "0 0 * * 5",
    timeZone: "UTC",
    region: "us-central1"
  },
  async (req, res) => {
    const now = new Date();
    const d = new Date(now);
    const day = d.getDay();
    const lastSunday = new Date(d.setDate(d.getDate() - day));
    lastSunday.setHours(23, 59, 59, 999);
    const lastMonday = new Date(lastSunday);
    lastMonday.setDate(lastMonday.getDate() - 6);
    lastMonday.setHours(0, 0, 0, 0);

    logger.info("Starting weekly payout run", { periodStart: lastMonday, periodEnd: lastSunday });

    try {
      const snap = await db.collection("sessions")
        .where("paymentstatus", "==", true)
        .where("payoutStatus", "==", false)
        .where("paymentDate", ">=", admin.firestore.Timestamp.fromDate(lastMonday))
        .where("paymentDate", "<=", admin.firestore.Timestamp.fromDate(lastSunday))
        .get();

      if (snap.empty) {
        logger.info("No eligible sessions found for this payout period.");
        return null;
      }

      // Step 1: Group sessions by professional ID and calculate total owed
      const byPro = new Map();
      snap.forEach(doc => {
        const r = doc.data();
        const proId = r.professionalID; // Use the professionalID field from the document
        const plan = r.plan;
        const professionalPayoutAmount = getProfessionalPayoutAmount(plan);

        if (!byPro.has(proId)) {
          byPro.set(proId, { proId: proId, total: 0, docs: [] });
        }

        const g = byPro.get(proId);
        g.total += Math.round(professionalPayoutAmount * 100); // sum owed amounts in cents
        g.docs.push(doc.ref);
      });

      // Step 2: Fetch all professional Stripe account IDs in a single batch
      const proIdsToFetch = Array.from(byPro.keys());
      const proAccountsMap = new Map();
      const proPromises = proIdsToFetch.map(async proId => {
        const proDoc = await db.collection("professionalID").doc(proId).get();
        if (proDoc.exists) {
          proAccountsMap.set(proId, proDoc.data().account_id || null);
        } else {
          logger.warn(`Professional document not found for ID: ${proId}. Skipping payout.`);
        }
      });
      await Promise.all(proPromises);

      const batch = db.batch();

      // Step 3: Iterate through the grouped data, fetch the Stripe account ID, and create transfers
      for (const [proId, { total, docs }] of byPro.entries()) {
        const acct = proAccountsMap.get(proId);
        if (!acct || total <= 0) {
          logger.warn("Skipping payout for professional with invalid account or zero total amount", { proId, total });
          continue;
        }

        logger.info("Processing payout for professional", { proId, accountId: acct, amount: total });

        try {
          await stripe.transfers.create({
            amount: total,
            currency: "usd",
            destination: acct,
            description: "Weekly session payouts",

          });

          // If transfer is successful, update all related sessions in the batch
          docs.forEach(ref => batch.update(ref, { payoutStatus: true, payoutDate: admin.firestore.FieldValue.serverTimestamp() }));

          // Log the successful payout run
          await db.collection("payoutRuns").add({
            proId,
            proStripeAccountId: acct,
            amount: total / 100,
            periodStart: lastMonday,
            periodEnd: lastSunday,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            status: "paid"
          });

        } catch (stripeError) {
          logger.error(`Stripe transfer failed for proId: ${proId}`, {
            error: stripeError.message,
            code: stripeError.code,
          });

          // Do NOT update the documents in the batch, so they are not marked as settled.
          // They will be picked up in the next scheduled run.
          await db.collection("payoutRuns").add({
            proId,
            proStripeAccountId: acct,
            amount: total / 100,
            periodStart: lastMonday,
            periodEnd: lastSunday,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            status: "failed",
            errorMessage: stripeError.message,
          });
        }
      }

      await batch.commit();
      logger.info("Weekly payout run completed successfully.");

      return null;

    } catch (error) {
      logger.error("Weekly payout error", error);
      return null;
    }
  });
