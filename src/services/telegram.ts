import { Telegraf } from "telegraf";
import { CONFIG } from "../config";
import { createChildLogger } from "../utils/logger/logger";
import { healthState } from "./health";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const CHATS_FILE = join(import.meta.dir, "../../telegram-chats.json");

let chatIds: number[] = [];
let bot: Telegraf | null = null;

const logger = createChildLogger("Telegram");

/**
 * Load chat IDs from JSON file on disk.
 */
function loadChatIds(): number[] {
  try {
    if (existsSync(CHATS_FILE)) {
      const data = readFileSync(CHATS_FILE, "utf-8");
      const ids = JSON.parse(data);
      if (Array.isArray(ids) && ids.every((id: unknown) => typeof id === "number")) {
        logger.info({ chatIds: ids }, "Loaded Telegram chat IDs from file");
        return ids;
      }
      logger.warn({ data: ids }, "telegram-chats.json has invalid format, expected number[]");
    }
  } catch (error) {
    logger.error({ error }, "Failed to load Telegram chat IDs from file");
  }
  return [];
}

/**
 * Save chat IDs to JSON file on disk.
 */
function saveChatIds(ids: number[]): void {
  try {
    writeFileSync(CHATS_FILE, JSON.stringify(ids, null, 2), "utf-8");
    logger.debug({ chatIds: ids }, "Saved Telegram chat IDs to file");
  } catch (error) {
    logger.error({ error }, "Failed to save Telegram chat IDs to file");
  }
}

// Load persisted chat IDs on startup
chatIds = loadChatIds();

if (CONFIG.TELEGRAM_BOT_TOKEN) {
  bot = new Telegraf(CONFIG.TELEGRAM_BOT_TOKEN);

  bot.start((ctx) => {
    const id = ctx.chat.id;
    if (!chatIds.includes(id)) {
      chatIds.push(id);
      saveChatIds(chatIds);
      logger.info({ chatId: id, user: ctx.from }, "Telegram chat ID saved from /start command");
    }

    ctx.reply(
      "✅ <b>Telegram notifications enabled!</b>\n" +
      "You will now receive trading alerts for:\n" +
      "• Buy orders executed\n" +
      "• Position entries\n" +
      "• Position closed\n" +
      "• All errors and exceptions\n\n" +
      "Use <code>/stop</code> to unsubscribe.",
      { parse_mode: "HTML" }
    );
  });

  bot.command("stop", (ctx) => {
    const id = ctx.chat.id;
    chatIds = chatIds.filter((cid) => cid !== id);
    saveChatIds(chatIds);
    logger.info({ chatId: id, user: ctx.from }, "Telegram chat ID removed via /stop command");
    ctx.reply("🔕 <b>Notifications disabled.</b> You will no longer receive alerts.", { parse_mode: "HTML" });
  });

  bot.command("status", (ctx) => {
    ctx.reply(
      "📊 <b>Bot Status</b>\n" +
      `✅ Telegram notifications ${chatIds.length > 0 ? "enabled" : "disabled"}\n` +
      `👥 Subscribers: <code>${chatIds.length}</code>`,
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
 * Send a message to all subscribed Telegram chats.
 */
export async function sendTelegramMessage(text: string) {
  if (!bot || chatIds.length === 0) {
    logger.debug({ hasBot: !!bot, chatIdsLength: chatIds.length }, "Telegram not configured or no chat IDs");
    return;
  }

  for (const id of chatIds) {
    try {
      await bot.telegram.sendMessage(id, text, { parse_mode: "HTML" });
    } catch (error) {
      logger.error({ error, chatId: id }, "Error sending Telegram message");
    }
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
 * Send a formatted error alert to all subscribed Telegram chats.
 * Error messages are HTML-escaped to prevent Telegram parse errors
 */
export async function sendTelegramError(context: string, error: any) {
  const errorMessage = escapeHtml(error?.message || String(error));
  const message = `🚨 <b>ERROR</b> [${context}]\n\n${errorMessage}`;
  await sendTelegramMessage(message);
}

/**
 * Get the current chat IDs (useful for testing)
 */
export function getChatIds() {
  return chatIds;
}
