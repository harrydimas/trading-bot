import WebSocket from "ws";
import { CONFIG } from "../config";
import * as crypto from "crypto";
import { createChildLogger } from "../utils/logger/logger";
import { sendTelegramError } from "./telegram";

const logger = createChildLogger("UserWS");

export async function startUserWS(onMsg: any) {
  logger.info("Connecting to user data WebSocket");
  
  const ws = new WebSocket("wss://ws-api.binance.com:443/ws-api/v3");

  ws.on("open", () => {
    logger.info("User WebSocket opened");
    const timestamp = Date.now();
    const payload = `apiKey=${CONFIG.API_KEY}&timestamp=${timestamp}`;

    // Sign with your secret key (HMAC-SHA256)
    const signature = crypto
      .createHmac("sha256", CONFIG.SECRET)
      .update(payload)
      .digest("hex");

    const authMessage = {
      id: crypto.randomUUID(),
      method: "userDataStream.subscribe.signature",
      params: {
        apiKey: CONFIG.API_KEY,
        signature,
        timestamp,
      },
    };
    
    ws.send(JSON.stringify(authMessage));
    logger.debug("Sent authentication message");
  });

  let messageCount = 0;
  
  ws.on("message", (m) => {
    const msg = JSON.parse(m.toString());

    // Skip subscription confirmation responses
    if ("result" in msg || "status" in msg) {
      logger.debug({ msg }, "Received subscription confirmation");
      return;
    }

    messageCount++;
    logger.debug({ 
      eventType: msg.e,
      messageCount 
    }, "Received WebSocket message");
    
    onMsg(msg.event ?? msg);
    
    if (messageCount % 10 === 0) {
      logger.info({ messageCount }, "User WebSocket messages received");
    }
  });

  ws.on("close", () => {
    logger.warn("User WebSocket closed, reconnecting in 5s...");
    sendTelegramError("USER WS CLOSED", new Error("User WebSocket closed unexpectedly"));
    setTimeout(() => startUserWS(onMsg), 5000);
  });

  ws.on("error", (err) => {
    logger.error({ error: err }, "User WebSocket error");
    sendTelegramError("USER WS ERROR", err);
    ws.close();
  });
}
