require("dotenv").config();

const { setGlobalOptions } = require("firebase-functions");
setGlobalOptions({ maxInstances: 10 });

module.exports = {
  ...require("./src/payments"),
  ...require("./src/stripeAccounts"),
  ...require("./src/payouts"),
  ...require("./src/agora"),
  ...require("./src/emails"),
};
