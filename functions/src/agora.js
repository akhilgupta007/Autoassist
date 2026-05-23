const { onRequest } = require("firebase-functions/https");
const { RtcTokenBuilder, RtcRole } = require("agora-access-token");
const { db, logger, admin } = require("./config");

const AGORA_APP_ID = process.env.AGORA_APP_ID;
const AGORA_APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;

if (!AGORA_APP_ID) logger.error("Missing AGORA_APP_ID");
if (!AGORA_APP_CERTIFICATE) logger.error("Missing AGORA_APP_CERTIFICATE");

const generateAgoraToken = onRequest(
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
        return res.status(404).json({ "error": "Session not found: ${sessionId}" });
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

      logger.info("generateAgoraToken: TOKEN_READY for session ${sessionId}", {
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
      logger.error("generateAgoraToken: failed for session ${sessionId}", error);

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

module.exports = { generateAgoraToken };
