require("dotenv").config();

const { setGlobalOptions } = require("firebase-functions");
const { onRequest, onCall } = require("firebase-functions/https");
const logger = require("firebase-functions/logger");
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { onSchedule } = require("firebase-functions/scheduler");
const { RtcTokenBuilder, RtcRole } = require("agora-access-token");

setGlobalOptions({ maxInstances: 10 });

const STRIPE_SECRET = process.env.STRIPE_SECRET;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const AGORA_APP_ID = process.env.AGORA_APP_ID;
const AGORA_APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;

if (!STRIPE_SECRET) logger.error("Missing STRIPE_SECRET");
if (!STRIPE_WEBHOOK_SECRET) logger.warn("Missing STRIPE_WEBHOOK_SECRET (webhook will fail)");
const stripe = require("stripe")(STRIPE_SECRET);

if (!AGORA_APP_ID) logger.error("Missing AGORA_APP_ID");
if (!AGORA_APP_CERTIFICATE) logger.error("Missing AGORA_APP_CERTIFICATE");
admin.initializeApp();
const db = admin.firestore();


const getProfessionalPayoutAmount = (planId) => {
  switch (planId) {
    case "QUICK_8": return 12; // $12.00
    case "FULL_15": return 21; // $21.00
    case "EXTENDED_20": return 30; // $30.00
    default: return 0;
  }
};

exports.createPaymentIntent = onRequest(async (req, res) => {
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
      metadata: { userId, sessionId },
    });

    res.set("Access-Control-Allow-Origin", "*");
    res.json({ clientSecret: paymentIntent.client_secret });

  } catch (error) {
    console.error("Stripe error:", error);
    res.set("Access-Control-Allow-Origin", "*");
    res.status(500).json({ error: error.message, code: error.code || "internal_error" });
  }
});

exports.stripeWebhook = onRequest(
  { region: "us-central1", invoker: "public" },
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(req.rawBody, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      logger.error(`⚠️ Webhook signature verification failed.`, err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "payment_intent.succeeded") {
      const session = event.data.object;
      logger.info("Payment event received:", session.id);

      const sessionId = session.metadata?.sessionId;
      const transactionId = event?.id || session.id;

      if (!sessionId) {
        logger.error(`Missing sessionId in metadata for session: ${session.id}`);
        return res.status(400).send("Missing sessionId in metadata.");
      }

      try {
        const sessionRef = db.collection("sessions").doc(sessionId);

        // ── Fetch the session doc to get plan_id ──
        const sessionDoc = await sessionRef.get();

        if (!sessionDoc.exists) {
          logger.error(`Session doc not found in Firestore: ${sessionId}`);
          return res.status(404).send("Session document not found.");
        }

        const sessionData = sessionDoc.data();
        const planId = sessionData.plan_id; // e.g. "QUICK_8", "FULL_15", "EXTENDED_20"

        // ── Calculate professional amount securely on backend ──
        const professionalAmount = getProfessionalPayoutAmount(planId);

        if (professionalAmount === 0) {
          logger.warn(`Unknown plan_id "${planId}" for session ${sessionId}. professional_amount set to 0.`);
        }

        const amountPaid = session.amount / 100;

        await sessionRef.update({
          paymentstatus: true,
          status: "PAYMENT_CONFIRMED",
          transactionId: transactionId,
          stripeSessionId: session.id,
          amountPaid: amountPaid,
          professional_amount: professionalAmount, // ✅ Calculated on backend
          paymentDate: admin.firestore.FieldValue.serverTimestamp(),
        });

        logger.info(`Session ${sessionId} updated. plan_id: ${planId}, professional_amount: $${professionalAmount}`);
        res.status(200).json({ received: true });

      } catch (dbError) {
        logger.error(`Error updating Firestore document:`, dbError);
        res.status(500).send("Internal Server Error");
      }
    } else {
      res.status(200).json({ received: true });
    }
  }
);

const isTransferCapable = async (accountId) => {
  const account = await stripe.accounts.retrieve(accountId);
  const transfersActive = account.capabilities?.transfers === "active";
  const chargesEnabled = account.charges_enabled;
  const payoutsEnabled = account.payouts_enabled;
  return transfersActive && chargesEnabled && payoutsEnabled;
};

exports.checkStripeAccountStatus = onRequest(
  { region: "us-central1", cors: true },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");

    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Methods", "GET, POST");
      res.set("Access-Control-Allow-Headers", "Content-Type");
      return res.status(204).send("");
    }

    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const proid = req.body?.proid;
    if (!proid) return res.status(400).json({ error: "Missing proid" });

    try {
      const proDoc = await db.collection("professionalID").doc(proid).get();
      if (!proDoc.exists) {
        return res.status(404).json({ ready: false, reason: "No account found. Please complete onboarding." });
      }

      const accountId = proDoc.data().account_id;
      if (!accountId) {
        return res.status(404).json({ ready: false, reason: "No Stripe account ID linked to this professional." });
      }

      const account = await stripe.accounts.retrieve(accountId);

      const transfersActive = account.capabilities?.transfers === "active";
      const chargesEnabled = account.charges_enabled;
      const payoutsEnabled = account.payouts_enabled;
      const detailsSubmitted = account.details_submitted;
      const ready = transfersActive && chargesEnabled && payoutsEnabled;

      logger.info(`Stripe account status for ${proid}`, {
        accountId,
        transfersActive,
        chargesEnabled,
        payoutsEnabled,
        detailsSubmitted,
        ready,
      });

      return res.status(200).json({
        ready,
        accountId,
        transfersActive,
        chargesEnabled,
        payoutsEnabled,
        detailsSubmitted,
        reason: ready
          ? "Account is fully set up and ready for payouts."
          : "Stripe onboarding is incomplete. Please finish setting up your account.",
      });

    } catch (error) {
      logger.error("checkStripeAccountStatus error", error);
      return res.status(500).json({ error: error.message });
    }
  }
);

exports.getStripeOnboardingLink = onRequest(
  { region: "us-central1", cors: true },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");

    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Methods", "GET, POST");
      res.set("Access-Control-Allow-Headers", "Content-Type");
      return res.status(204).send("");
    }

    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const proid = req.body?.proid;
    if (!proid) return res.status(400).json({ error: "Missing proid" });

    try {
      const proDoc = await db.collection("professionalID").doc(proid).get();
      if (!proDoc.exists) {
        return res.status(404).json({ error: "No account found for this professional." });
      }

      const accountId = proDoc.data().account_id;
      if (!accountId) {
        return res.status(404).json({ error: "No Stripe account ID linked to this professional." });
      }

      const accountLink = await stripe.accountLinks.create({
        account: accountId,
        type: "account_onboarding",
        return_url: "https://autoassistlive-prod.web.app/A7PROPaymentpageDRAWER",
        refresh_url: "https://autoassistlive-prod.web.app/A7PROPaymentpageDRAWER",
        collect: "eventually_due",
      });

      logger.info(`Generated onboarding link for ${proid}`, { accountId });

      return res.status(200).json({
        success: true,
        onboardingUrl: accountLink.url,
      });

    } catch (error) {
      logger.error("getStripeOnboardingLink error", error);
      return res.status(500).json({ error: error.message });
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

      const { email, proid } = req.body || {};
      if (!email) return res.status(400).json({ error: "Missing email" });
      if (!proid) return res.status(400).json({ error: "Missing proid" });

      const return_url = 'https://autoassistlive-prod.web.app/A7PROPaymentpageDRAWER';
      const refresh_url = 'https://autoassistlive-prod.web.app/A7PROPaymentpageDRAWER';

      // ── If account already exists, just return a fresh onboarding link ──
      const existingDoc = await db.collection("professionalID").doc(proid).get();
      if (existingDoc.exists && existingDoc.data().account_id) {
        const existingAccountId = existingDoc.data().account_id;
        logger.info("Account already exists, returning fresh onboarding link", { existingAccountId, proid });

        const accountLink = await stripe.accountLinks.create({
          account: existingAccountId,
          type: "account_onboarding",
          return_url,
          refresh_url,
          collect: "eventually_due",
        });

        return res.status(200).json({
          success: true,
          accountId: existingAccountId,
          accountLink: accountLink.url,
        });
      }

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
      logger.info("Account created", { accountId: account.id, proid });

      const accountLink = await stripe.accountLinks.create({
        account: account.id,
        type: "account_onboarding",
        return_url,
        refresh_url,
        collect: "eventually_due",
      });

      await db.collection("professionalID").doc(proid).set({
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

exports.monthlyBonusPayouts = onSchedule(
  {
    schedule: "0 0 1 * *",
    timeZone: "America/Los_Angeles",
    region: "us-central1",
    timeoutSeconds: 540,
  },
  async (event) => {
    const now = new Date();

    const startOfCurrentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfPreviousMonth = new Date(startOfCurrentMonth);
    startOfPreviousMonth.setMonth(startOfPreviousMonth.getMonth() - 1);

    const endOfPreviousMonth = new Date(startOfCurrentMonth);
    endOfPreviousMonth.setMilliseconds(-1);

    const monthName = startOfPreviousMonth.toLocaleString('default', { month: 'long' });
    const year = startOfPreviousMonth.getFullYear();
    const monthIndex = startOfPreviousMonth.getMonth();

    logger.info(`Calculating bonuses for: ${monthName} ${year}`);

    try {
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

      for (const [proId, count] of Object.entries(sessionCounts)) {
        let bonusAmount = 0;
        if (count >= 90) bonusAmount = 30000;
        else if (count >= 60) bonusAmount = 15000;

        if (bonusAmount === 0) continue;

        const bonusDocId = `bonus_${proId}_${monthIndex}_${year}`;
        const bonusRef = db.collection("pendingBonuses").doc(bonusDocId);

        const existing = await bonusRef.get();
        if (existing.exists) {
          logger.info(`Bonus already queued/paid for ${proId} - ${monthName}. Skipping.`);
          continue;
        }

        await bonusRef.set({
          proId,
          bonusAmount,
          sessionsCount: count,
          month: monthIndex,
          year,
          monthName,
          type: "monthly_bonus",
          status: "pending",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        logger.info(`Queued bonus for ${proId}: $${bonusAmount / 100} (${count} sessions)`);
      }

    } catch (error) {
      logger.error("monthlyBonusPayouts error", error);
    }
  }
);

exports.weeklyProPayouts = onSchedule(
  {
    schedule: "0 0 * * 5",
    timeZone: "America/Los_Angeles",
    region: "us-central1",
    timeoutSeconds: 540,
  },
  async (event) => {
    const now = new Date();
    const d = new Date(now);
    const day = d.getDay();

    const lastSaturday = new Date(d);
    lastSaturday.setDate(d.getDate() - ((day + 1) % 7));
    lastSaturday.setHours(23, 59, 59, 999);

    const lastSunday = new Date(lastSaturday);
    lastSunday.setDate(lastSaturday.getDate() - 6);
    lastSunday.setHours(0, 0, 0, 0);

    const weekIdentifier = lastSaturday.toISOString().split('T')[0];

    logger.info("Starting weekly payout run", { periodStart: lastSunday, periodEnd: lastSaturday });

    try {
      const snap = await db.collection("sessions")
        .where("paymentstatus", "==", true)
        .where("payoutStatus", "==", false)
        .where("paymentDate", "<=", admin.firestore.Timestamp.fromDate(lastSaturday))
        .get();

      const bonusSnap = await db.collection("pendingBonuses")
        .where("status", "==", "pending")
        .get();

      const byPro = new Map();

      snap.forEach(doc => {
        const r = doc.data();
        const proId = r.professionalID;
        const amount = r.professional_amount;

        if (!byPro.has(proId)) {
          byPro.set(proId, { total: 0, sessionDocs: [], bonusDocs: [] });
        }

        const g = byPro.get(proId);
        g.total += Math.round(amount * 100);
        g.sessionDocs.push(doc.ref);
      });

      bonusSnap.forEach(doc => {
        const { proId, bonusAmount } = doc.data();
        if (!byPro.has(proId)) {
          byPro.set(proId, { total: 0, sessionDocs: [], bonusDocs: [] });
        }
        const g = byPro.get(proId);
        g.total += bonusAmount;
        g.bonusDocs.push(doc.ref);
      });

      if (byPro.size === 0) {
        logger.info("No payouts to process.");
        return null;
      }

      const proIdsToFetch = Array.from(byPro.keys());
      const proAccountsMap = new Map();

      await Promise.all(proIdsToFetch.map(async proId => {
        const proDoc = await db.collection("professionalID").doc(proId).get();
        if (proDoc.exists) {
          proAccountsMap.set(proId, proDoc.data().account_id || null);
        } else {
          logger.warn(`Professional not found: ${proId}.`);
        }
      }));

      const batch = db.batch();

      for (const [proId, { total, sessionDocs, bonusDocs }] of byPro.entries()) {
        const acct = proAccountsMap.get(proId);
        if (!acct || total <= 0) continue;

        const capable = await isTransferCapable(acct);
        if (!capable) {
          logger.warn(`Skipping ${proId} — Not transfer capable.`);
          await db.collection("payoutRuns").add({
            proId, proStripeAccountId: acct, amount: total / 100,
            periodStart: lastSunday, periodEnd: lastSaturday,
            status: "skipped", errorMessage: "Onboarding incomplete.",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          continue;
        }

        const idempotencyKey = `payout_${proId}_${weekIdentifier}`;

        try {
          // STRIPE CALL WITH IDEMPOTENCY
          const transfer = await stripe.transfers.create({
            amount: total,
            currency: "usd",
            destination: acct,
            description: `Weekly payout ending ${weekIdentifier}`,
          }, { idempotencyKey });

          // UPDATE SESSIONS
          sessionDocs.forEach(ref =>
            batch.update(ref, {
              payoutStatus: true,
              stripeTransferId: transfer.id,
              payoutDate: admin.firestore.FieldValue.serverTimestamp()
            })
          );

          // UPDATE BONUSES
          let totalBonusCents = 0;
          bonusDocs.forEach(ref => {
            const bonusDoc = bonusSnap.docs.find(d => d.ref.path === ref.path);
            totalBonusCents += bonusDoc ? bonusDoc.data().bonusAmount : 0;
            batch.update(ref, {
              status: "paid",
              stripeTransferId: transfer.id,
              paidAt: admin.firestore.FieldValue.serverTimestamp()
            });
          });

          // LOG SUCCESSFUL RUN
          await db.collection("payoutRuns").add({
            proId,
            proStripeAccountId: acct,
            stripeTransferId: transfer.id,
            amount: total / 100,
            sessionAmount: (total - totalBonusCents) / 100,
            bonusAmount: totalBonusCents / 100,
            periodStart: lastSunday,
            periodEnd: lastSaturday,
            idempotencyKey,
            status: "paid",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });

        } catch (stripeError) {
          logger.error(`Transfer failed for ${proId}`, { error: stripeError.message });
          await db.collection("payoutRuns").add({
            proId, proStripeAccountId: acct, amount: total / 100,
            periodStart: lastSunday, periodEnd: lastSaturday,
            status: "failed", errorMessage: stripeError.message,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }

      await batch.commit();
      logger.info("Payout run completed.");
      return null;

    } catch (error) {
      logger.error("Global payout error", error);
      return null;
    }
  }
);

exports.manualTestBonus = onRequest(
  { region: "us-central1" },
  async (req, res) => {
    const tier1_count = parseInt(req.query.t1) || 2;
    const tier2_count = parseInt(req.query.t2) || 5;
    const simulatedNow = req.query.date ? new Date(req.query.date) : new Date();
    const isDryRun = req.query.dryRun !== "false";

    const startOfCurrentMonth = new Date(simulatedNow.getFullYear(), simulatedNow.getMonth(), 1);
    const startOfPreviousMonth = new Date(startOfCurrentMonth);
    startOfPreviousMonth.setMonth(startOfPreviousMonth.getMonth() - 1);

    const endOfPreviousMonth = new Date(startOfCurrentMonth);
    endOfPreviousMonth.setMilliseconds(-1);

    const monthName = startOfPreviousMonth.toLocaleString('default', { month: 'long' });
    const year = startOfPreviousMonth.getFullYear();

    logger.info(`[TEST MODE] Analyzing: ${monthName} ${year}. Thresholds: ${tier1_count}/${tier2_count}`);

    try {
      const snapshot = await db.collection("sessions")
        .where("paymentstatus", "==", true)
        .where("paymentDate", ">=", admin.firestore.Timestamp.fromDate(startOfPreviousMonth))
        .where("paymentDate", "<=", admin.firestore.Timestamp.fromDate(endOfPreviousMonth))
        .get();

      if (snapshot.empty) {
        return res.json({ message: "No sessions found in that date range.", range: { start: startOfPreviousMonth, end: endOfPreviousMonth } });
      }

      const sessionCounts = {};
      snapshot.forEach(doc => {
        const pid = doc.data().professionalID;
        if (pid) sessionCounts[pid] = (sessionCounts[pid] || 0) + 1;
      });

      const results = [];
      const batch = db.batch();

      for (const [proId, count] of Object.entries(sessionCounts)) {
        let bonusAmount = 0;
        let tierAchieved = "None";

        if (count >= tier2_count) {
          bonusAmount = 30000;
          tierAchieved = `Tier 2 (${tier2_count}+)`;
        } else if (count >= tier1_count) {
          bonusAmount = 15000;
          tierAchieved = `Tier 1 (${tier1_count}+)`;
        }

        if (bonusAmount === 0) continue;

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

        if (isDryRun) {
          results.push({ ...logData, note: "Dry Run - No Money Sent" });
          batch.set(testRef, logData);
        } else {
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

exports.generateAgoraToken = onRequest(
  { region: "us-central1", cors: true },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");

    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Methods", "POST");
      res.set("Access-Control-Allow-Headers", "Content-Type");
      return res.status(204).send("");
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { sessionId } = req.body || {};

    if (!sessionId) {
      return res.status(400).json({ error: "Missing required field: sessionId" });
    }

    const sessionRef = db.collection("sessions").doc(sessionId);

    try {
      // ── Validate session exists ──
      const sessionDoc = await sessionRef.get();
      if (!sessionDoc.exists) {
        return res.status(404).json({ error: `Session not found: ${sessionId}` });
      }

      // ── Build RTC token ──
      const channelName = sessionId;
      const uid = 0;                // wildcard — any participant can join
      const role = RtcRole.PUBLISHER;
      const expireSeconds = 3600;             // 1 hour
      const currentTs = Math.floor(Date.now() / 1000);
      const privilegeExpireTs = currentTs + expireSeconds;

      const token = RtcTokenBuilder.buildTokenWithUid(
        AGORA_APP_ID,
        AGORA_APP_CERTIFICATE,
        channelName,
        uid,
        role,
        privilegeExpireTs
      );

      const agoraTokenExpiry = admin.firestore.Timestamp.fromDate(
        new Date((currentTs + expireSeconds) * 1000)
      );

      // ── Write token + TOKEN_READY into session doc ──
      await sessionRef.update({
        status: "TOKEN_READY",
        agoraToken: token,
        agoraChannel: channelName,
        agoraAppId: AGORA_APP_ID,
        agoraTokenExpiry: agoraTokenExpiry,
        tokenIssuedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      logger.info(`generateAgoraToken: TOKEN_READY for session ${sessionId}`, {
        channelName,
        expiresAt: agoraTokenExpiry.toDate().toISOString(),
      });

      return res.status(200).json({
        success: true,
        agoraToken: token,
        agoraChannel: channelName,
        agoraAppId: AGORA_APP_ID,
        expiresAt: agoraTokenExpiry.toDate().toISOString(),
      });

    } catch (error) {
      logger.error(`generateAgoraToken: failed for session ${sessionId}`, error);

      // ── Let the app know token generation failed ──
      await sessionRef.update({
        status: "TOKEN_FAILED",
        tokenError: error.message,
        tokenIssuedAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(e => logger.error("Failed to write TOKEN_FAILED status", e));

      return res.status(500).json({ error: error.message });
    }
  }
);