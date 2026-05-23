const logger = require("firebase-functions/logger");

const STRIPE_SECRET = process.env.STRIPE_SECRET;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

if (!STRIPE_SECRET) logger.error("Missing STRIPE_SECRET");
if (!STRIPE_WEBHOOK_SECRET)
  logger.warn("Missing STRIPE_WEBHOOK_SECRET (webhook will fail)");

const stripe = require("stripe")(STRIPE_SECRET);

module.exports = { stripe, STRIPE_WEBHOOK_SECRET };
