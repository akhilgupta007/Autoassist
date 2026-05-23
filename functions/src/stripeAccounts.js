const { onRequest } = require("firebase-functions/https");
const { db, logger, admin } = require("./config");
const { stripe } = require("./stripeConfig");

const checkStripeAccountStatus = onRequest(
  { region: "us-central1", cors: true },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");

    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Methods", "GET, POST");
      res.set("Access-Control-Allow-Headers", "Content-Type");
      return res.status(204).send("");
    }

    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });

    const proid = req.body?.proid;
    if (!proid) return res.status(400).json({ error: "Missing proid" });

    try {
      const proDoc = await db.collection("professionalID").doc(proid).get();
      if (!proDoc.exists) {
        return res
          .status(404)
          .json({
            ready: false,
            reason: "No account found. Please complete onboarding.",
          });
      }

      const accountId = proDoc.data().account_id;
      if (!accountId) {
        return res
          .status(404)
          .json({
            ready: false,
            reason: "No Stripe account ID linked to this professional.",
          });
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
  },
);

const getStripeOnboardingLink = onRequest(
  { region: "us-central1", cors: true },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");

    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Methods", "GET, POST");
      res.set("Access-Control-Allow-Headers", "Content-Type");
      return res.status(204).send("");
    }

    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });

    const proid = req.body?.proid;
    if (!proid) return res.status(400).json({ error: "Missing proid" });

    try {
      const proDoc = await db.collection("professionalID").doc(proid).get();
      if (!proDoc.exists) {
        return res
          .status(404)
          .json({ error: "No account found for this professional." });
      }

      const accountId = proDoc.data().account_id;
      if (!accountId) {
        return res
          .status(404)
          .json({ error: "No Stripe account ID linked to this professional." });
      }

      const accountLink = await stripe.accountLinks.create({
        account: accountId,
        type: "account_onboarding",
        return_url:
          "https://autoassistlive-prod.web.app/A7PROPaymentpageDRAWER",
        refresh_url:
          "https://autoassistlive-prod.web.app/A7PROPaymentpageDRAWER",
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
  },
);

const createExpressAccount = onRequest(
  { region: "us-central1", cors: true },
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

      const return_url =
        "https://autoassistlive-prod.web.app/A7PROPaymentpageDRAWER";
      const refresh_url =
        "https://autoassistlive-prod.web.app/A7PROPaymentpageDRAWER";

      const existingDoc = await db
        .collection("professionalID")
        .doc(proid)
        .get();
      if (existingDoc.exists && existingDoc.data().account_id) {
        const existingAccountId = existingDoc.data().account_id;
        logger.info("Account already exists, returning fresh onboarding link", {
          existingAccountId,
          proid,
        });

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
          product_description:
            "Independent mechanic offering live automotive repair consultations via video chat on the Auto Assist LIVE platform.",
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

      await db.collection("professionalID").doc(proid).set(
        {
          account_id: account.id,
          email,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

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
  },
);

module.exports = {
  checkStripeAccountStatus,
  getStripeOnboardingLink,
  createExpressAccount,
};
