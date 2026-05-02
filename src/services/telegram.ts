import { Telegraf } from "telegraf";
import { CONFIG } from "../config";
import { createChildLogger } from "../utils/logger/logger";
import { healthState } from "./health";

let chatId: number | null = null;
let bot: Telegraf | null = null;

const logger = createChildLogger("Telegram");

if (CONFIG.TELEGRAM_BOT_TOKEN) {
  bot = new Telegraf(CONFIG.TELEGRAM_BOT_TOKEN);
  
  bot.start((ctx) => {
    chatId = ctx.chat.id;
    logger.info({ chatId, user: ctx.from }, "Telegram chat ID saved from /start command");
    
    ctx.reply(
      "✅ <b>Telegram notifications enabled!</b>\n" +
      "You will now receive trading alerts for:\n" +
      "• Buy orders executed\n" +
      "• Position entries\n" +
      "• Position closed\n" +
      "• All errors and exceptions",
      { parse_mode: "HTML" }
    );
  });
  
  bot.command("status", (ctx) => {
    ctx.reply(
      "📊 <b>Bot Status</b>\n" +
      `✅ Telegram notifications ${chatId ? "enabled" : "disabled"}`,
      { parse_mode: "HTML" }
    );
  });

  bot.command("health", (ctx) => {
    const uptimeMs = Date.now() - healthState.startedAt;
    const lastTickAge = Date.now() - healthState.lastTickAt;
    const UPTIME_HOURS = Math.floor(uptimeMs / 3600000);
    const UPTIME_MINUTES = Math.floor((uptimeMs % 3600000) / 60000);
    const isHealthy = lastTickAge < CONFIG.CHECK_INTERVAL * 3;

    ctx.reply(
      `🏥 <b>Bot Health</b>\n` +
      `Status: <code>${isHealthy ? "✅ OK" : "⚠️ STALE"}</code>\n` +
      `Uptime: <code>${UPTIME_HOURS}h ${UPTIME_MINUTES}m</code>\n` +
      `Last Tick: <code>${lastTickAge < 1000 ? `${Math.floor(lastTickAge)}ms ago` : `${Math.floor(lastTickAge / 1000)}s ago`}</code>\n` +
      `WS (User): <code>${healthState.userWsConnected ? "✅" : "❌"}</code> | ` +
      `OB: <code>${healthState.orderbookWsConnected ? "✅" : "❌"}</code>\n` +
      `Open Positions: <code>${healthState.openPositions}</code>\n` +
      `Symbols: <code>${CONFIG.SYMBOLS.join(", ")}</code>\n` +
      `Time: <code>${new Date().toISOString()}</code>`,
      { parse_mode: "HTML" }
    );
  });

  bot.launch().catch((error) => {
    logger.error({ error }, "Failed to launch Telegram bot");
  });

  // Graceful shutdown
  process.once("SIGINT", () => bot?.stop("SIGINT"));
  process.once("SIGTERM", () => bot?.stop("SIGTERM"));
} else {
  logger.info("Telegram bot token not configured, skipping Telegram integration");
}

/**
 * Send a message to Telegram
 */
export async function sendTelegramMessage(text: string) {
  if (!bot || !chatId) {
    logger.debug({ hasBot: !!bot, hasChatId: !!chatId }, "Telegram not configured or chat ID not set");
    return;
  }

  try {
    await bot.telegram.sendMessage(chatId, text, { parse_mode: "HTML" });
  } catch (error) {
    logger.error({ error }, "Error sending Telegram message");
  }
}

/**
 * Escape HTML entities to prevent Telegram parse errors
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Send a formatted error alert to Telegram
 * Error messages are HTML-escaped to prevent Telegram parse errors
 */
export async function sendTelegramError(context: string, error: any) {
  const errorMessage = escapeHtml(error?.message || String(error));
  const message = `🚨 <b>ERROR</b> [${context}]\n\n${errorMessage}`;
  await sendTelegramMessage(message);
}

/**
 * Get the current chat ID (useful for testing)
 */
export function getChatId() {
  return chatId;
}