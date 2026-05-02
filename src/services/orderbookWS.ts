import WebSocket from "ws";
import { createChildLogger } from "../utils/logger/logger";
import { sendTelegramError } from "./telegram";
import { healthState } from "./health";

const ob: any = {};
const midPrice: Record<string, number> = {};
const logger = createChildLogger("OrderbookWS");

export function startOB(symbol: string) {
  const stream = symbol.replace("/", "").toLowerCase() + "@depth";
  
  logger.info({ symbol, stream }, "Starting orderbook stream");

  const ws = new WebSocket(`wss://stream.binance.com/ws/${stream}`);

  ws.on("open", () => {
    logger.info({ symbol }, "Orderbook WebSocket opened");
    healthState.orderbookWsConnected = true;
    healthState.wsConnected = healthState.orderbookWsConnected && healthState.userWsConnected;
  });

  let messageCount = 0;
  
  ws.on("message", (m) => {
    const d = JSON.parse(m.toString());

    let bids = 0, asks = 0;

    for (const b of d.b.slice(0, 10)) bids += parseFloat(b[1]);
    for (const a of d.a.slice(0, 10)) asks += parseFloat(a[1]);
    
    const bestBid = parseFloat(d.b[0]?.[0] || "0");
    const bestAsk = parseFloat(d.a[0]?.[0] || "0");

    ob[symbol] = { bids, asks, bestAsk, bestBid };
    
    // Hitung mid price dari best bid & best ask
    if (bestBid > 0 && bestAsk > 0) {
      midPrice[symbol] = (bestBid + bestAsk) / 2;
    }

    messageCount++;
    if (messageCount % 100 === 0) {
      logger.debug({ 
        symbol, 
        messages: messageCount,
        bids: bids.toFixed(4),
        asks: asks.toFixed(4)
      }, "Orderbook update");
    }
  });

  ws.on("close", () => {
    logger.warn({ symbol }, "Orderbook WebSocket closed, reconnecting...");
    healthState.orderbookWsConnected = false;
    healthState.wsConnected = false;
    sendTelegramError(`ORDERBOOK WS CLOSED [${symbol}]`, new Error(`Orderbook WebSocket disconnected`));
    setTimeout(() => startOB(symbol), 5000);
  });

  ws.on("error", (err) => {
    logger.error({ error: err, symbol }, "Orderbook WebSocket error");
    sendTelegramError(`ORDERBOOK WS ERROR [${symbol}]`, err);
  });
}

export const getOB = (s: string) => ob[s];

export const getMidPrice = (s: string): number | null => midPrice[s] ?? null;
