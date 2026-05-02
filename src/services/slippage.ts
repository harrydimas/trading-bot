import { getOB } from "./orderbookWS";
import { createChildLogger } from "../utils/logger/logger";

const logger = createChildLogger("Slippage");

export function checkSlippage(symbol: string, price: number) {
  const ob = getOB(symbol);
  if (!ob) {
    logger.debug({ symbol }, "No orderbook data available");
    return false;
  }

  const estAsk = ob.asks / 10;
  const diff = Math.abs(estAsk - price) / price;
  const threshold = 0.002;
  const passed = diff < threshold;

  logger.debug({ 
    symbol, 
    price, 
    estAsk, 
    diff: (diff * 100).toFixed(2) + "%",
    threshold: (threshold * 100).toFixed(2) + "%",
    passed 
  }, "Slippage check");

  return passed;
}
