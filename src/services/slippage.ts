import { getOB } from "./orderbookWS";
import { createChildLogger } from "../utils/logger/logger";
import { sendTelegramMessage } from "./telegram";

const logger = createChildLogger("Slippage");

export function checkSlippage(symbol: string, price: number) {
  const ob = getOB(symbol);
  if (!ob) {
    logger.debug({ symbol }, "No orderbook data available");
    return false;
  }

  const estAsk = ob.bestAsk || price;
  const diff = Math.abs(estAsk - price) / price;
  const threshold = 0.002;
  const passed = diff < threshold;

  logger.info({ 
    symbol, 
    price, 
    estAsk, 
    diff: (diff * 100).toFixed(2) + "%",
    threshold: (threshold * 100).toFixed(2) + "%",
    passed 
  }, "Slippage check");

  sendTelegramMessage(
    `${passed ? "✅" : "⚠️"} <b>SLIPPAGE CHECK</b> ${symbol}\n` +
    `Status: <code>${passed ? "PASS" : "FAIL"}</code>\n` +
    `Price: <code>${price}</code> | Est Ask: <code>${estAsk}</code>\n` +
    `Diff: <code>${(diff * 100).toFixed(2)}%</code> (threshold: <code>${(threshold * 100).toFixed(2)}%</code>)`
  );

  return passed;
}
