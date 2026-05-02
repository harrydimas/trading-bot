import ccxt from "ccxt";
import { CONFIG } from "../config";
import { createChildLogger } from "../utils/logger/logger";

const logger = createChildLogger("Exchange");

const baseExchange = new ccxt.binance({
  apiKey: CONFIG.API_KEY,
  secret: CONFIG.SECRET,

  enableRateLimit: true,
  timeout: 10000, // shorter default; individual ops can override

  options: {
    defaultType: "spot",
    fetchCurrencies: false,
    adjustForTimeDifference: true,
  },
});

// Wrap exchange methods with logging
export const exchange = new Proxy(baseExchange, {
  get(target, prop) {
    const originalMethod = target[prop as keyof typeof target];
    
    if (typeof originalMethod === 'function') {
      return async function (...args: any[]) {
        const methodName = String(prop);
        
        try {
          logger.debug({ method: methodName, args: args.length }, "Exchange API call");
          const result = await originalMethod.apply(target, args);
          logger.debug({ method: methodName }, "Exchange API call successful");
          return result;
        } catch (error) {
          logger.error({ method: methodName, error }, "Exchange API call failed");
          throw error;
        }
      };
    }
    
    return originalMethod;
  }
});

/**
 * Fast price fetch with aggressive timeout.
 * Uses the lightweight ticker/price endpoint instead of ticker/24hr.
 * Falls back to normal fetchTicker if this fails.
 */
export async function fetchPrice(symbol: string, timeoutMs = 8000): Promise<number | null> {
  try {
    const result = await Promise.race([
      exchange.fetchTicker(symbol),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`fetchPrice timeout after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
    return (result as any).last ?? null;
  } catch (error) {
    logger.warn({ symbol, error }, "fetchPrice failed");
    return null;
  }
}

export async function getUSDTBalance(): Promise<number> {
  const balance = await exchange.fetchBalance();
  return (balance.free as any)?.USDT ?? 0;
}

logger.info("Exchange client initialized");
