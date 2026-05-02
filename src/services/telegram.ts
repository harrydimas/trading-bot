import { Telegraf } from "telegraf";
import { CONFIG } from "../config";
import { createChildLogger } from "../utils/logger/logger";

const logger = createChildLogger("Telegram");

let chatId: number | null = null;
let bot: Telegraf | null = null;

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
 * Send a formatted error alert to Telegram
 */
export async function sendTelegramError(context: string, error: any) {
  const errorMessage = error?.message || String(error);
  const message = `🚨 <b>ERROR</b> [${context}]\n\n${errorMessage}`;
  await sendTelegramMessage(message);
}

/**
 * Get the current chat ID (useful for testing)
 */
export function getChatId() {
  return chatId;
}