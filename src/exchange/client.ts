import ccxt from "ccxt";
import { CONFIG } from "../config";
import { createChildLogger } from "../utils/logger/logger";

const logger = createChildLogger("Exchange");

const baseExchange = new ccxt.binance({
  apiKey: CONFIG.API_KEY,
  secret: CONFIG.SECRET,

  enableRateLimit: true,
  timeout: 60000, // Increased from 30s to 60s for better reliability

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

export async function getUSDTBalance(): Promise<number> {
  const balance = await exchange.fetchBalance();
  return (balance.free as any)?.USDT ?? 0;
}

logger.info("Exchange client initialized");
