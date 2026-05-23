const { onRequest } = require("firebase-functions/https");
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { db, logger, admin } = require("./config");
const { transporter } = require("./mailer");

const sendPaymentRecieptEmailInternal = async (sessionData, userId, sessionId) => {
  try {
    const { professionalID, plan_id } = sessionData;

    let duration = "0";
    if (plan_id === "QUICK_8") duration = "8";
    else if (plan_id === "FULL_15") duration = "15";
    else if (plan_id === "EXTENDED_20") duration = "20";

    let dateObj = new Date();
    if (sessionData && sessionData.startTime) {
      if (typeof sessionData.startTime.toDate === "function") {
        dateObj = sessionData.startTime.toDate();
      } else if (sessionData.startTime instanceof Date) {
        dateObj = sessionData.startTime;
      } else if (typeof sessionData.startTime === "string" || typeof sessionData.startTime === "number") {
        dateObj = new Date(sessionData.startTime);
      }
    }
    const sessionStart = `${dateObj.getMonth() + 1}/${dateObj.getDate()} ${dateObj.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`;

    const htmlBody = `
      <p>Thank you for choosing Auto Assist LIVE. We hope your Video session was productive. Please review your Session details</p>
      
      <div style="border: 2px solid #3b00ff; border-radius: 8px; padding: 16px; max-width: 400px; font-family: sans-serif;">
        <h3 style="margin-top: 0;">Purchase Summary</h3>
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
          <tr>
            <td style="padding: 8px 0; color: #555;">User ID</td>
            <td style="padding: 8px 0; text-align: right; font-weight: bold;">${userId || "N/A"}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #555;">Pro ID</td>
            <td style="padding: 8px 0; text-align: right; font-weight: bold;">${professionalID || "N/A"}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #555;">Session ID</td>
            <td style="padding: 8px 0; text-align: right; font-weight: bold;">${sessionId || "N/A"}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #555;">Session Start</td>
            <td style="padding: 8px 0; text-align: right; font-weight: bold;">${sessionStart}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #555;">Session Duration</td>
            <td style="padding: 8px 0; text-align: right; font-weight: bold;"><em>${duration}</em> Minutes</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #555;">Session cost</td>
            <td style="padding: 8px 0; text-align: right;">
              <span style="background-color: #3b00ff; color: white; padding: 4px 8px; border-radius: 4px; font-weight: bold;">${plan_id || "N/A"}</span>
            </td>
          </tr>
        </table>
      </div>
      
      <p style="color: #555; margin-top: 24px; font-size: 14px;">
        Vehicle owners, If you would like to request a refund, please respond to this email within 24 hours and include details of your request. All refund requests are manually reviewed and can be denied. All refund requests are automatically denied 24 hours post session.
      </p>
      
      <p>We hope you enjoy the rest of your day!</p>
    `;

    const subject = "AAL26: Here are your transaction details -";
    const fromEmail = process.env.FROM_EMAIL || "support@autoassistlive.com";

    // 1. Send to User
    if (userId) {
      try {
        let userRef = null;
        let rawUserId = null;
        if (typeof userId === 'object' && userId && typeof userId.get === 'function') {
          userRef = userId;
          rawUserId = userId.id;
        } else if (typeof userId === 'string') {
          const cleanPath = userId.startsWith('/') ? userId.slice(1) : userId;
          if (cleanPath.includes('/')) {
            userRef = db.doc(cleanPath);
            const parts = cleanPath.split('/');
            rawUserId = parts[parts.length - 1];
          } else {
            userRef = db.collection("userID").doc(cleanPath);
            rawUserId = cleanPath;
          }
        }

        let userEmail = null;
        if (userRef) {
          try {
            const userDoc = await userRef.get();
            if (userDoc.exists) {
              userEmail = userDoc.data().email;
            }
          } catch (err) {
            logger.warn(`Could not get user doc for ${rawUserId || userId}, falling back to auth:`, err);
          }
        }

        if (!userEmail && rawUserId) {
          try {
            const userRecord = await admin.auth().getUser(rawUserId);
            userEmail = userRecord.email;
          } catch (authErr) {
            logger.warn(`Could not get auth user for ${rawUserId}:`, authErr);
          }
        }
        
        if (userEmail) {
          await transporter.sendMail({
            from: `"Auto Assist LIVE" <${fromEmail}>`,
            to: userEmail,
            subject: subject,
            html: htmlBody,
          });
          logger.info(`Payment receipt email sent to User: ${userEmail}`);
        } else {
          logger.error(`No email found for User ID: ${rawUserId || userId}`);
        }
      } catch (err) {
        logger.error(`Error sending receipt to User ${userId}:`, err);
      }
    }

    // 2. Send to Pro
    if (professionalID) {
      try {
        const proDoc = await db.collection("professionalID").doc(professionalID).get();
        if (proDoc.exists && proDoc.data().email) {
          const proEmail = proDoc.data().email;
          await transporter.sendMail({
            from: `"Auto Assist LIVE" <${fromEmail}>`,
            to: proEmail,
            subject: subject,
            html: htmlBody,
          });
          logger.info(`Payment receipt email sent to Pro: ${proEmail}`);
        } else {
          logger.error(`No email found for Pro ID: ${professionalID}`);
        }
      } catch (err) {
        logger.error(`Error sending receipt to Pro ${professionalID}:`, err);
      }
    }
  } catch (error) {
    logger.error("Error in sendPaymentRecieptEmailInternal:", error);
  }
};

const sendRefundEmailInternal = async (sessionData, userId, sessionId, amountRefunded) => {
  try {
    const { professionalID, plan_id } = sessionData;

    let duration = "0";
    if (plan_id === "QUICK_8") duration = "8";
    else if (plan_id === "FULL_15") duration = "15";
    else if (plan_id === "EXTENDED_20") duration = "20";

    const refundAmountFormatted = typeof amountRefunded === "number"
      ? `$${amountRefunded.toFixed(2)}`
      : `$${(sessionData.amountPaid || 0).toFixed(2)}`;

    const htmlBody = `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 550px; margin: 0 auto; padding: 20px; color: #333; background-color: #f9f9fc; border-radius: 12px; border: 1px solid #e1e1e8;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h2 style="color: #e15241; margin-bottom: 8px; font-weight: 600;">Refund Confirmation</h2>
          <p style="font-size: 16px; color: #666; margin-top: 0;">Your refund has been successfully processed.</p>
        </div>
        
        <div style="background-color: #ffffff; border-radius: 8px; padding: 20px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.02); border-left: 4px solid #e15241;">
          <h3 style="margin-top: 0; color: #333; font-size: 16px; border-bottom: 1px solid #f0f0f5; padding-bottom: 10px;">Refund Details</h3>
          <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
            <tr>
              <td style="padding: 10px 0; color: #666;">Session ID</td>
              <td style="padding: 10px 0; text-align: right; font-weight: 600; color: #111;">${sessionId || "N/A"}</td>
            </tr>
            <tr>
              <td style="padding: 10px 0; color: #666;">Refund Amount</td>
              <td style="padding: 10px 0; text-align: right; font-weight: 700; color: #e15241;">${refundAmountFormatted}</td>
            </tr>
            <tr>
              <td style="padding: 10px 0; color: #666;">Plan</td>
              <td style="padding: 10px 0; text-align: right;">
                <span style="background-color: #f0f0f8; color: #3b00ff; padding: 4px 8px; border-radius: 4px; font-weight: 600; font-size: 12px;">${plan_id || "N/A"}</span>
              </td>
            </tr>
            <tr>
              <td style="padding: 10px 0; color: #666;">Session Duration</td>
              <td style="padding: 10px 0; text-align: right; font-weight: 600; color: #111;">${duration} Minutes</td>
            </tr>
          </table>
        </div>
        
        <p style="font-size: 14px; color: #555; line-height: 1.6; margin-top: 24px;">
          The refunded amount has been sent back to your original payment method. Depending on your financial institution, it typically takes <strong>5 to 10 business days</strong> for the funds to appear in your account.
        </p>
        
        <p style="font-size: 14px; color: #555; line-height: 1.6;">
          If you have any questions or need further assistance, please feel free to reply directly to this email.
        </p>
        
        <hr style="border: 0; border-top: 1px solid #e1e1e8; margin: 24px 0;" />
        
        <div style="text-align: center; font-size: 12px; color: #999;">
          <p style="margin: 4px 0;">Auto Assist LIVE &copy; ${new Date().getFullYear()}</p>
          <p style="margin: 4px 0;">support@autoassistlive.com</p>
        </div>
      </div>
    `;

    const proHtmlBody = `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 550px; margin: 0 auto; padding: 20px; color: #333; background-color: #f9f9fc; border-radius: 12px; border: 1px solid #e1e1e8;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h2 style="color: #e15241; margin-bottom: 8px; font-weight: 600;">Session Refund Notice</h2>
          <p style="font-size: 16px; color: #666; margin-top: 0;">A session has been refunded and cancelled.</p>
        </div>
        
        <div style="background-color: #ffffff; border-radius: 8px; padding: 20px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.02); border-left: 4px solid #e15241;">
          <h3 style="margin-top: 0; color: #333; font-size: 16px; border-bottom: 1px solid #f0f0f5; padding-bottom: 10px;">Session Info</h3>
          <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
            <tr>
              <td style="padding: 10px 0; color: #666;">Session ID</td>
              <td style="padding: 10px 0; text-align: right; font-weight: 600; color: #111;">${sessionId || "N/A"}</td>
            </tr>
            <tr>
              <td style="padding: 10px 0; color: #666;">Refunded Amount</td>
              <td style="padding: 10px 0; text-align: right; font-weight: 700; color: #e15241;">${refundAmountFormatted}</td>
            </tr>
            <tr>
              <td style="padding: 10px 0; color: #666;">Plan</td>
              <td style="padding: 10px 0; text-align: right;">
                <span style="background-color: #f0f0f8; color: #3b00ff; padding: 4px 8px; border-radius: 4px; font-weight: 600; font-size: 12px;">${plan_id || "N/A"}</span>
              </td>
            </tr>
          </table>
        </div>
        
        <p style="font-size: 14px; color: #555; line-height: 1.6; margin-top: 24px;">
          Hello Professional, we are writing to let you know that the payment for Session <strong>${sessionId || "N/A"}</strong> has been refunded. This transaction is now marked as refunded and will not be eligible for payout.
        </p>
        
        <p style="font-size: 14px; color: #555; line-height: 1.6;">
          If you have any questions or feel this is an error, please reply to this email to contact support.
        </p>
        
        <hr style="border: 0; border-top: 1px solid #e1e1e8; margin: 24px 0;" />
        
        <div style="text-align: center; font-size: 12px; color: #999;">
          <p style="margin: 4px 0;">Auto Assist LIVE &copy; ${new Date().getFullYear()}</p>
          <p style="margin: 4px 0;">support@autoassistlive.com</p>
        </div>
      </div>
    `;

    const subject = `AAL26: Refund Processed for Session ${sessionId || ""}`;
    const fromEmail = process.env.FROM_EMAIL || "support@autoassistlive.com";

    // 1. Send to User
    if (userId) {
      try {
        let userRef = null;
        let rawUserId = null;
        if (typeof userId === 'object' && userId && typeof userId.get === 'function') {
          userRef = userId;
          rawUserId = userId.id;
        } else if (typeof userId === 'string') {
          const cleanPath = userId.startsWith('/') ? userId.slice(1) : userId;
          if (cleanPath.includes('/')) {
            userRef = db.doc(cleanPath);
            const parts = cleanPath.split('/');
            rawUserId = parts[parts.length - 1];
          } else {
            userRef = db.collection("userID").doc(cleanPath);
            rawUserId = cleanPath;
          }
        }

        let userEmail = null;
        if (userRef) {
          try {
            const userDoc = await userRef.get();
            if (userDoc.exists) {
              userEmail = userDoc.data().email;
            }
          } catch (err) {
            logger.warn(`Could not get user doc for ${rawUserId || userId}, falling back to auth:`, err);
          }
        }

        if (!userEmail && rawUserId) {
          try {
            const userRecord = await admin.auth().getUser(rawUserId);
            userEmail = userRecord.email;
          } catch (authErr) {
            logger.warn(`Could not get auth user for ${rawUserId}:`, authErr);
          }
        }
        
        if (userEmail) {
          await transporter.sendMail({
            from: `"Auto Assist LIVE" <${fromEmail}>`,
            to: userEmail,
            subject: subject,
            html: htmlBody,
          });
          logger.info(`Refund confirmation email sent to User: ${userEmail}`);
        } else {
          logger.error(`No email found for User ID: ${rawUserId || userId}`);
        }
      } catch (err) {
        logger.error(`Error sending refund email to User ${userId}:`, err);
      }
    }

    // 2. Send to Pro
    if (professionalID) {
      try {
        const proDoc = await db.collection("professionalID").doc(professionalID).get();
        if (proDoc.exists && proDoc.data().email) {
          const proEmail = proDoc.data().email;
          await transporter.sendMail({
            from: `"Auto Assist LIVE" <${fromEmail}>`,
            to: proEmail,
            subject: subject,
            html: proHtmlBody,
          });
          logger.info(`Refund confirmation email sent to Pro: ${proEmail}`);
        } else {
          logger.error(`No email found for Pro ID: ${professionalID}`);
        }
      } catch (err) {
        logger.error(`Error sending refund email to Pro ${professionalID}:`, err);
      }
    }
  } catch (error) {
    logger.error("Error in sendRefundEmailInternal:", error);
  }
};

const sendPaymentRecieptEmail = onRequest(
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

    const { sessionId, userId } = req.body || {};

    if (!sessionId) {
      return res.status(400).json({
        error: "Missing required field: sessionId",
      });
    }

    try {
      const sessionDoc = await db.collection("sessions").doc(sessionId).get();
      if (!sessionDoc.exists) {
        return res.status(404).json({
          error: `Session ${sessionId} not found.`,
        });
      }

      const sessionData = sessionDoc.data();
      const finalUserId = userId || sessionData.userid || sessionData.userId || sessionData.userID;
      console.log("finalUserId:", finalUserId);
      console.log("sessionData:", sessionData);
      await sendPaymentRecieptEmailInternal(sessionData, finalUserId, sessionId);

      return res.status(200).json({ success: true });
    } catch (error) {
      logger.error("Error in sendPaymentRecieptEmail request:", error);
      return res.status(500).json({
        error: error.message || "Internal error sending email.",
      });
    }
  }
);

const onSessionCompleted = onDocumentUpdated(
  {
    document: "sessions/{sessionId}",
    region: "us-central1"
  },
  async (event) => {
    const newValue = event.data.after.data();
    const previousValue = event.data.before ? event.data.before.data() : null;
    
    const is_completed = newValue ? newValue.is_completed : null;
    const previous_is_completed = previousValue ? previousValue.is_completed : null;
    
    if (is_completed && !previous_is_completed) {
      const sessionId = event.params.sessionId;
      const userId = newValue.userid || newValue.userId || newValue.userID;
      
      logger.info(`Session ${sessionId} completed. Triggering receipt email automatically.`);
      await sendPaymentRecieptEmailInternal(newValue, userId, sessionId);
    }
  }
);

module.exports = {
  sendPaymentRecieptEmailInternal,
  sendRefundEmailInternal,
  sendPaymentRecieptEmail,
  onSessionCompleted,
};
