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
        // success_url: `https://autoassistlive-prod.web.app/?type=checkout&status=success`,
        // cancel_url: `https://autoassistlive-prod.web.app/?type=checkout&status=cancel`,
        success_url: 'https://autoassistlive-prod.web.app/U7userFOUNDpaywall',
        cancel_url: 'https://autoassistlive-prod.web.app/U7userFOUNDpaywall',
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


      // const return_url = `https://autoassistlive-prod.web.app/?uid=${uid}&type=return`;
      // const refresh_url = `https://autoassistlive-prod.web.app/?uid=${uid}&type=refresh`;

      const return_url = 'https://autoassistlive-prod.web.app/A7PROPaymentpageDRAWER';
      const refresh_url = 'https://autoassistlive-prod.web.app/A7PROPaymentpageDRAWER';


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

        if (r.payoutStatus === true) {
          return;
        }

        const proId = r.professionalID; // Use the professionalID field from the document
        const plan = r.plan;
        const professionalPayoutAmount = r.professional_amount

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

exports.monthlyBonusPayouts = onSchedule(
  {
    schedule: "0 10 1 * *", // 1st of every month at 10 AM
    timeZone: "UTC",
    region: "us-central1",
    timeoutSeconds: 540, // Increased timeout for safety
  },
  async (event) => {
    const now = new Date();

    // 1. Date Logic (Previous Month)
    const startOfCurrentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfPreviousMonth = new Date(startOfCurrentMonth);
    startOfPreviousMonth.setMonth(startOfPreviousMonth.getMonth() - 1);

    const endOfPreviousMonth = new Date(startOfCurrentMonth);
    endOfPreviousMonth.setMilliseconds(-1);

    const monthName = startOfPreviousMonth.toLocaleString('default', { month: 'long' });
    const year = startOfPreviousMonth.getFullYear();
    const monthIndex = startOfPreviousMonth.getMonth(); // 0-11

    logger.info(`Starting Bonus Run for: ${monthName} ${year}`);

    try {
      // 2. Get Sessions
      const snapshot = await db.collection("sessions")
        .where("paymentstatus", "==", true)
        .where("paymentDate", ">=", admin.firestore.Timestamp.fromDate(startOfPreviousMonth))
        .where("paymentDate", "<=", admin.firestore.Timestamp.fromDate(endOfPreviousMonth))
        .get();

      if (snapshot.empty) return;

      const sessionCounts = {};
      snapshot.forEach(doc => {
        const pid = doc.data().professionalID;
        if (pid) sessionCounts[pid] = (sessionCounts[pid] || 0) + 1;
      });

      // 3. Process Bonuses with Safety Checks
      const batch = db.batch();

      // We process sequentially (for loop) instead of parallel (Promise.all) 
      // to avoid hitting Stripe rate limits if you have many users.
      for (const [proId, count] of Object.entries(sessionCounts)) {

        // --- Calculate Amount ---
        let bonusAmount = 0;
        if (count >= 90) bonusAmount = 30000;      // $300.00
        else if (count >= 60) bonusAmount = 15000; // $150.00

        if (bonusAmount === 0) continue;

        // --- THE SAFETY CHECK (Idempotency) ---
        // We create a custom ID. This ID is unique to this User + This Month.
        const bonusDocId = `bonus_${proId}_${monthIndex}_${year}`;
        const bonusRef = db.collection("payoutRuns").doc(bonusDocId);

        const existingDoc = await bonusRef.get();

        // If we already paid this successfully, SKIP IT.
        if (existingDoc.exists && existingDoc.data().status === "success") {
          logger.info(`Skipping ${proId}, already paid for ${monthName}.`);
          continue;
        }

        // --- Get Stripe Account ---
        const proDoc = await db.collection("professionalID").doc(proId).get();
        const stripeAccountId = proDoc.exists ? proDoc.data().account_id : null;

        if (!stripeAccountId) {
          // Log failure to DB so you can fix it later
          await bonusRef.set({
            proId,
            status: "failed",
            error: "No Stripe Account Linked",
            amount: bonusAmount / 100,
            month: monthIndex,
            year: year,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
          logger.error(`No Stripe ID for ${proId}`);
          continue;
        }

        // --- Attempt Transfer ---
        try {
          const transfer = await stripe.transfers.create({
            amount: bonusAmount,
            currency: "usd",
            destination: stripeAccountId,
            description: `${monthName} Volume Bonus (${count} sessions)`,
            metadata: { type: "monthly_bonus", month: monthName, year: year }
          });

          // SUCCESS: Write "success" to DB
          // Use .set() to create or overwrite if it failed previously
          await bonusRef.set({
            proId,
            stripeAccountId,
            amount: bonusAmount / 100,
            status: "success", // <--- IMPORTANT
            transferId: transfer.id,
            sessionsCount: count,
            month: monthIndex,
            year: year,
            type: "monthly_bonus",
            paidAt: admin.firestore.FieldValue.serverTimestamp()
          });

          logger.info(`Paid ${proId} $${bonusAmount / 100}`);

        } catch (stripeError) {
          // FAILURE: Write "failed" to DB
          logger.error(`Stripe Fail for ${proId}: ${stripeError.message}`);

          await bonusRef.set({
            proId,
            stripeAccountId,
            amount: bonusAmount / 100,
            status: "failed", // <--- IMPORTANT
            error: stripeError.message, // e.g., "Insufficient Funds"
            code: stripeError.code,
            month: monthIndex,
            year: year,
            type: "monthly_bonus",
            lastAttempt: admin.firestore.FieldValue.serverTimestamp()
          });
        }
      }

    } catch (error) {
      logger.error("Critical System Error", error);
    }
  }
);

exports.manualTestBonus = onRequest(
  { region: "us-central1" },
  async (req, res) => {
    // --- 1. CONFIGURATION FROM URL ---
    // Example: ?t1=2&t2=5&date=2023-11-01&dryRun=true

    // Lower thresholds for testing (Default: 2 sessions = $150, 5 sessions = $300)
    const tier1_count = parseInt(req.query.t1) || 2;
    const tier2_count = parseInt(req.query.t2) || 5;

    // Allow simulating "Today" to test different months
    const simulatedNow = req.query.date ? new Date(req.query.date) : new Date();

    // SAFETY: Default to TRUE. Pass ?dryRun=false to actually send money.
    const isDryRun = req.query.dryRun !== "false";

    // --- 2. EXACT DATE LOGIC (SAME AS PROD) ---
    const startOfCurrentMonth = new Date(simulatedNow.getFullYear(), simulatedNow.getMonth(), 1);
    const startOfPreviousMonth = new Date(startOfCurrentMonth);
    startOfPreviousMonth.setMonth(startOfPreviousMonth.getMonth() - 1);

    const endOfPreviousMonth = new Date(startOfCurrentMonth);
    endOfPreviousMonth.setMilliseconds(-1);

    const monthName = startOfPreviousMonth.toLocaleString('default', { month: 'long' });
    const year = startOfPreviousMonth.getFullYear();

    logger.info(`[TEST MODE] Analyzing: ${monthName} ${year}. Thresholds: ${tier1_count}/${tier2_count}`);

    try {
      // --- 3. FETCH SESSIONS ---
      const snapshot = await db.collection("sessions")
        .where("paymentstatus", "==", true)
        .where("paymentDate", ">=", admin.firestore.Timestamp.fromDate(startOfPreviousMonth))
        .where("paymentDate", "<=", admin.firestore.Timestamp.fromDate(endOfPreviousMonth))
        .get();

      if (snapshot.empty) {
        return res.json({ message: "No sessions found in that date range.", range: { start: startOfPreviousMonth, end: endOfPreviousMonth } });
      }

      // Count sessions
      const sessionCounts = {};
      snapshot.forEach(doc => {
        const pid = doc.data().professionalID;
        if (pid) sessionCounts[pid] = (sessionCounts[pid] || 0) + 1;
      });

      const results = [];
      const batch = db.batch();

      // --- 4. CALCULATE (modified thresholds) ---
      for (const [proId, count] of Object.entries(sessionCounts)) {

        let bonusAmount = 0;
        let tierAchieved = "None";

        // Use the TEST thresholds (t1/t2)
        if (count >= tier2_count) {
          bonusAmount = 30000; // $300
          tierAchieved = `Tier 2 (${tier2_count}+)`;
        } else if (count >= tier1_count) {
          bonusAmount = 15000; // $150
          tierAchieved = `Tier 1 (${tier1_count}+)`;
        }

        if (bonusAmount === 0) continue;

        // --- 5. ISOLATED LOGGING ---
        // We use a DIFFERENT collection so we don't pollute the real records
        const testDocId = `TEST_bonus_${proId}_${monthName}_${year}`;
        const testRef = db.collection("test_payoutRuns").doc(testDocId);

        const logData = {
          proId,
          count,
          tierAchieved,
          amount: bonusAmount / 100,
          status: isDryRun ? "SIMULATED" : "PAID_VIA_TEST",
          month: monthName,
          testedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        // --- 6. ACTION (Dry Run vs Real) ---
        if (isDryRun) {
          // Just Log, Don't Pay
          results.push({ ...logData, note: "Dry Run - No Money Sent" });
          batch.set(testRef, logData);
        } else {
          // !!! DANGER: SENDING REAL MONEY !!!
          const proDoc = await db.collection("professionalID").doc(proId).get();
          const acct = proDoc.data()?.account_id;

          if (acct) {
            try {
              const transfer = await stripe.transfers.create({
                amount: bonusAmount,
                currency: "usd",
                destination: acct,
                description: `TEST PAYMENT: Volume Bonus (${count} sessions)`,
              });

              logData.transferId = transfer.id;
              results.push({ ...logData, success: true });
              batch.set(testRef, logData);
            } catch (e) {
              results.push({ ...logData, error: e.message });
              batch.set(testRef, { ...logData, status: "FAILED", error: e.message });
            }
          } else {
            results.push({ ...logData, error: "No Stripe Account" });
          }
        }
      }

      await batch.commit();

      res.json({
        success: true,
        mode: isDryRun ? "DRY RUN (Safe)" : "LIVE (Money Sent)",
        analyzed_month: `${monthName} ${year}`,
        thresholds_used: { tier1: tier1_count, tier2: tier2_count },
        payouts_generated: results
      });

    } catch (error) {
      logger.error("Test function error", error);
      res.status(500).json({ error: error.message });
    }
  }
);