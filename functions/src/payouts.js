const { onRequest } = require("firebase-functions/https");
const { onSchedule } = require("firebase-functions/scheduler");
const { db, logger, admin } = require("./config");
const { stripe } = require("./stripeConfig");

const isTransferCapable = async (accountId) => {
  const account = await stripe.accounts.retrieve(accountId);
  const transfersActive = account.capabilities?.transfers === "active";
  const chargesEnabled = account.charges_enabled;
  const payoutsEnabled = account.payouts_enabled;
  return transfersActive && chargesEnabled && payoutsEnabled;
};

const monthlyBonusPayouts = onSchedule(
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

    const monthName = startOfPreviousMonth.toLocaleString("default", {
      month: "long",
    });
    const year = startOfPreviousMonth.getFullYear();
    const monthIndex = startOfPreviousMonth.getMonth();

    logger.info(`Calculating bonuses for: ${monthName} ${year}`);

    try {
      const snapshot = await db
        .collection("sessions")
        .where("paymentstatus", "==", true)
        .where(
          "paymentDate",
          ">=",
          admin.firestore.Timestamp.fromDate(startOfPreviousMonth),
        )
        .where(
          "paymentDate",
          "<=",
          admin.firestore.Timestamp.fromDate(endOfPreviousMonth),
        )
        .get();

      if (snapshot.empty) return;

      const sessionCounts = {};
      snapshot.forEach((doc) => {
        const data = doc.data();
        if (data.eligibleForPayout === false || data.status === "REFUNDED") return;
        const pid = data.professionalID;
        if (pid) sessionCounts[pid] = (sessionCounts[pid] || 0) + 1;
      });

      for (const [proId, count] of Object.entries(sessionCounts)) {
        let bonusAmount = 0;
        let bonus60Earned = false;
        let bonus60Amount = 0;
        let bonus90Earned = false;
        let bonus90Amount = 0;

        if (count >= 90) {
          bonusAmount = 30000;
          bonus60Earned = true;
          bonus60Amount = 15000;
          bonus90Earned = true;
          bonus90Amount = 15000;
        } else if (count >= 60) {
          bonusAmount = 15000;
          bonus60Earned = true;
          bonus60Amount = 15000;
        }

        if (bonusAmount === 0) continue;

        const yyyyMm = `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
        const bonusRef = db
          .collection("professionalID")
          .doc(proId)
          .collection("monthlyBonusStatus")
          .doc(yyyyMm);

        const existing = await bonusRef.get();
        if (existing.exists && existing.data().bonusPaid) {
          logger.info(
            `Bonus already paid for ${proId} - ${monthName}. Skipping.`,
          );
          continue;
        }

        await bonusRef.set({
          month: yyyyMm,
          sessionCount: count,
          bonusEligibleAmount: bonusAmount,
          bonus60Earned,
          bonus60Amount,
          bonus90Earned,
          bonus90Amount,
          evaluatedAt: admin.firestore.FieldValue.serverTimestamp(),
          bonusPaid: false,
          bonusPaidAt: null,
        });

        logger.info(
          `Queued bonus for ${proId}: $${bonusAmount / 100} (${count} sessions)`,
        );
      }
    } catch (error) {
      logger.error("monthlyBonusPayouts error", error);
    }
  },
);

const weeklyProPayouts = onSchedule(
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

    const weekIdentifier = lastSaturday.toISOString().split("T")[0];

    logger.info("Starting weekly payout run", {
      periodStart: lastSunday,
      periodEnd: lastSaturday,
    });

    try {
      const snap = await db
        .collection("sessions")
        .where("paymentstatus", "==", true)
        .where("payoutStatus", "==", false)
        .where(
          "paymentDate",
          "<=",
          admin.firestore.Timestamp.fromDate(lastSaturday),
        )
        .get();

      const bonusSnap = await db
        .collectionGroup("monthlyBonusStatus")
        .where("bonusPaid", "==", false)
        .where("bonusEligibleAmount", ">", 0)
        .get();

      const byPro = new Map();
      const ineligibleSessionRefs = [];

      snap.forEach((doc) => {
        const r = doc.data();
        if (r.eligibleForPayout === false || r.status === "REFUNDED") {
          ineligibleSessionRefs.push(doc.ref);
          return;
        }
        const proId = r.professionalID;
        const amount = r.professional_amount;

        if (!byPro.has(proId)) {
          byPro.set(proId, { total: 0, sessionDocs: [], bonusDocs: [] });
        }

        const g = byPro.get(proId);
        g.total += Math.round(amount * 100);
        g.sessionDocs.push(doc.ref);
      });

      if (ineligibleSessionRefs.length > 0) {
        logger.info(`Found ${ineligibleSessionRefs.length} ineligible/refunded sessions. Marking payoutStatus: true.`);
        for (let i = 0; i < ineligibleSessionRefs.length; i += 400) {
          const chunk = ineligibleSessionRefs.slice(i, i + 400);
          const cleanBatch = db.batch();
          chunk.forEach((ref) => {
            cleanBatch.update(ref, { payoutStatus: true });
          });
          await cleanBatch.commit();
        }
      }

      bonusSnap.forEach((doc) => {
        const proId = doc.ref.parent.parent.id;
        const { bonusEligibleAmount } = doc.data();
        if (!byPro.has(proId)) {
          byPro.set(proId, { total: 0, sessionDocs: [], bonusDocs: [] });
        }
        const g = byPro.get(proId);
        g.total += bonusEligibleAmount;
        g.bonusDocs.push(doc.ref);
      });

      if (byPro.size === 0) {
        logger.info("No payouts to process.");
        return null;
      }

      const proIdsToFetch = Array.from(byPro.keys());
      const proAccountsMap = new Map();

      await Promise.all(
        proIdsToFetch.map(async (proId) => {
          const proDoc = await db.collection("professionalID").doc(proId).get();
          if (proDoc.exists) {
            proAccountsMap.set(proId, proDoc.data().account_id || null);
          } else {
            logger.warn(`Professional not found: ${proId}.`);
          }
        }),
      );

      const batch = db.batch();

      for (const [
        proId,
        { total, sessionDocs, bonusDocs },
      ] of byPro.entries()) {
        const acct = proAccountsMap.get(proId);
        if (!acct || total <= 0) continue;

        const capable = await isTransferCapable(acct);
        if (!capable) {
          logger.warn(`Skipping ${proId} — Not transfer capable.`);
          await db.collection("payoutRuns").add({
            proId,
            proStripeAccountId: acct,
            amount: total / 100,
            periodStart: lastSunday,
            periodEnd: lastSaturday,
            status: "skipped",
            errorMessage: "Onboarding incomplete.",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          continue;
        }

        const idempotencyKey = `payout_${proId}_${weekIdentifier}`;

        try {
          const transfer = await stripe.transfers.create(
            {
              amount: total,
              currency: "usd",
              destination: acct,
              description: `Weekly payout ending ${weekIdentifier}`,
            },
            { idempotencyKey },
          );

          sessionDocs.forEach((ref) =>
            batch.update(ref, {
              payoutStatus: true,
              stripeTransferId: transfer.id,
              payoutDate: admin.firestore.FieldValue.serverTimestamp(),
            }),
          );

          let totalBonusCents = 0;
          bonusDocs.forEach((ref) => {
            const bonusDoc = bonusSnap.docs.find(
              (d) => d.ref.path === ref.path,
            );
            totalBonusCents += bonusDoc
              ? bonusDoc.data().bonusEligibleAmount
              : 0;
            batch.update(ref, {
              bonusPaid: true,
              payoutBatchId: transfer.id,
              bonusPaidAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          });

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
          logger.error(`Transfer failed for ${proId}`, {
            error: stripeError.message,
          });
          await db.collection("payoutRuns").add({
            proId,
            proStripeAccountId: acct,
            amount: total / 100,
            periodStart: lastSunday,
            periodEnd: lastSaturday,
            status: "failed",
            errorMessage: stripeError.message,
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
  },
);

const manualTestBonus = onRequest(
  { region: "us-central1" },
  async (req, res) => {
    const tier1_count = parseInt(req.query.t1) || 2;
    const tier2_count = parseInt(req.query.t2) || 5;
    const simulatedNow = req.query.date ? new Date(req.query.date) : new Date();
    const isDryRun = req.query.dryRun !== "false";

    const startOfCurrentMonth = new Date(
      simulatedNow.getFullYear(),
      simulatedNow.getMonth(),
      1,
    );
    const startOfPreviousMonth = new Date(startOfCurrentMonth);
    startOfPreviousMonth.setMonth(startOfPreviousMonth.getMonth() - 1);

    const endOfPreviousMonth = new Date(startOfCurrentMonth);
    endOfPreviousMonth.setMilliseconds(-1);

    const monthName = startOfPreviousMonth.toLocaleString("default", {
      month: "long",
    });
    const year = startOfPreviousMonth.getFullYear();

    logger.info(
      `[TEST MODE] Analyzing: ${monthName} ${year}. Thresholds: ${tier1_count}/${tier2_count}`,
    );

    try {
      const snapshot = await db
        .collection("sessions")
        .where("paymentstatus", "==", true)
        .where(
          "paymentDate",
          ">=",
          admin.firestore.Timestamp.fromDate(startOfPreviousMonth),
        )
        .where(
          "paymentDate",
          "<=",
          admin.firestore.Timestamp.fromDate(endOfPreviousMonth),
        )
        .get();

      if (snapshot.empty) {
        return res.json({
          message: "No sessions found in that date range.",
          range: { start: startOfPreviousMonth, end: endOfPreviousMonth },
        });
      }

      const sessionCounts = {};
      snapshot.forEach((doc) => {
        const data = doc.data();
        if (data.eligibleForPayout === false || data.status === "REFUNDED") return;
        const pid = data.professionalID;
        if (pid) sessionCounts[pid] = (sessionCounts[pid] || 0) + 1;
      });

      const results = [];
      const batch = db.batch();

      for (const [proId, count] of Object.entries(sessionCounts)) {
        let bonusAmount = 0;
        let tierAchieved = "None";
        let bonus60Earned = false;
        let bonus60Amount = 0;
        let bonus90Earned = false;
        let bonus90Amount = 0;

        if (count >= tier2_count) {
          bonusAmount = 30000;
          tierAchieved = `Tier 2 (${tier2_count}+)`;
          bonus60Earned = true;
          bonus60Amount = 15000;
          bonus90Earned = true;
          bonus90Amount = 15000;
        } else if (count >= tier1_count) {
          bonusAmount = 15000;
          tierAchieved = `Tier 1 (${tier1_count}+)`;
          bonus60Earned = true;
          bonus60Amount = 15000;
        }

        if (bonusAmount === 0) continue;

        const yyyyMm = `${year}-${String(startOfPreviousMonth.getMonth() + 1).padStart(2, "0")}`;
        const testDocId = `TEST_${yyyyMm}`;
        const testRef = db
          .collection("professionalID")
          .doc(proId)
          .collection("monthlyBonusStatus")
          .doc(testDocId);

        const logData = {
          month: yyyyMm,
          sessionCount: count,
          bonusEligibleAmount: bonusAmount,
          bonus60Earned,
          bonus60Amount,
          bonus90Earned,
          bonus90Amount,
          evaluatedAt: admin.firestore.FieldValue.serverTimestamp(),
          bonusPaid: !isDryRun,
          bonusPaidAt: isDryRun
            ? null
            : admin.firestore.FieldValue.serverTimestamp(),
          status: isDryRun ? "SIMULATED" : "PAID_VIA_TEST",
          tierAchieved,
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

              logData.payoutBatchId = transfer.id;
              results.push({ ...logData, success: true });
              batch.set(testRef, logData);
            } catch (e) {
              results.push({ ...logData, error: e.message });
              batch.set(testRef, {
                ...logData,
                status: "FAILED",
                error: e.message,
              });
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
        payouts_generated: results,
      });
    } catch (error) {
      logger.error("Test function error", error);
      res.status(500).json({ error: error.message });
    }
  },
);

module.exports = {
  monthlyBonusPayouts,
  weeklyProPayouts,
  manualTestBonus,
};
