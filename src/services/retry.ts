import { createChildLogger } from "../utils/logger/logger";
import { sendTelegramError } from "./telegram";

const logger = createChildLogger("Retry");

export async function retry(fn: any, retries = 5) {
  let err;

  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      err = e;
      const delay = 1000 * 2 ** i;
      logger.warn({ attempt: i + 1, maxRetries: retries, delay }, "Retry attempt failed, waiting...");
      await new Promise(r => setTimeout(r, delay));
    }
  }

  logger.error({ error: err }, "All retry attempts exhausted");
  sendTelegramError("Retry Exhausted", err);
  throw err;
}
