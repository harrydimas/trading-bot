import { Bot } from "./core/bot";
import { CONFIG } from "./config";
import { startOB } from "./services/orderbookWS";
import { startUserWS } from "./services/ws";
import { initDB } from "./db/init";
import { initPriceCache } from "./strategies/aiFilter";
import { logger } from "./utils/logger/logger";
import { sendTelegramError, sendTelegramMessage } from "./services/telegram";
import { healthState } from "./services/health";
import { createServer } from "http";

const bots: Bot[] = CONFIG.SYMBOLS.map((s: string) => new Bot(s));

logger.info({ symbols: CONFIG.SYMBOLS }, "Initialized bots for symbols");

function routeWS(e: any) {
  bots.forEach((b: Bot) => b.handleWS(e));
}

async function main() {
  logger.info("Starting trading bot");

  try {
    await initDB();
    logger.info("Database initialized");
  } catch (error) {
    logger.error({ error }, "Failed to initialize database");
    sendTelegramError("DB INIT", error);
    throw error;
  }

  // Initialize AIFilter price cache from historical data
  logger.info("Initializing price caches...");
  for (const b of bots) {
    await initPriceCache(b.symbol);
  }

  CONFIG.SYMBOLS.forEach((symbol: string) => startOB(symbol));
  logger.info({ symbols: CONFIG.SYMBOLS }, "Started orderbook streams");

  try {
    await startUserWS(routeWS);
    logger.info("User WebSocket connected");
  } catch (error) {
    logger.error({ error }, "Failed to connect user WebSocket");
    sendTelegramError("WS INIT", error);
    throw error;
  }

  logger.info("Recovering positions...");
  for (const b of bots) {
    try {
      await b.recover();
      logger.info({ symbol: b.symbol, positions: b.pos.length }, "Recovered positions");
    } catch (error) {
      logger.error({ error, symbol: b.symbol }, "Failed to recover positions");
    }
  }

  // Startup notification
  sendTelegramMessage(
    `🟢 <b>BOT STARTED</b>\n` +
    `Symbols: <code>${CONFIG.SYMBOLS.join(", ")}</code>\n` +
    `BUY_USDT: <code>${CONFIG.BUY_USDT}</code>\n` +
    `TP1: <code>+${(CONFIG.PARTIAL_TP1_PCT * 100).toFixed(0)}%</code> | ` +
    `TP2: <code>+${(CONFIG.PARTIAL_TP2_PCT * 100).toFixed(0)}%</code>\n` +
    `Trailing: <code>${(CONFIG.TRAILING_DEFAULT * 100).toFixed(1)}%</code>\n` +
    `Max Hold: <code>${CONFIG.MAX_HOLD_MS > 0 ? CONFIG.MAX_HOLD_MS / 3600000 + "h" : "disabled"}</code>\n` +
    `Time: <code>${new Date().toISOString()}</code>`
  );

  // Health check HTTP server
  const healthServer = createServer((req, res) => {
    if (req.url !== "/health") {
      res.writeHead(404);
      res.end();
      return;
    }

    const uptimeMs = Date.now() - healthState.startedAt;
    const lastTickAge = Date.now() - healthState.lastTickAt;
    const isHealthy = lastTickAge < CONFIG.CHECK_INTERVAL * 3; // stale jika > 3 tick terlewat

    const body = JSON.stringify({
      status: isHealthy ? "ok" : "stale",
      uptime_ms: uptimeMs,
      last_tick_age_ms: lastTickAge,
      ws_connected: healthState.wsConnected,
      open_positions: healthState.openPositions,
      symbols: CONFIG.SYMBOLS,
      timestamp: new Date().toISOString(),
    }, null, 2);

    res.writeHead(isHealthy ? 200 : 503, { "Content-Type": "application/json" });
    res.end(body);
  });

  healthServer.listen(3000, () => {
    logger.info("Health check server listening on :3000");
  });

  logger.info("Starting main trading loop");
  let tickCount = 0;
  while (true) {
    const loopStart = Date.now();
    
    for (const b of bots) {
      try {
        // Safety timeout: max 15s per bot tick, prevent stuck bot from blocking loop
        await Promise.race([
          b.tick(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Bot tick timeout after 15s`)), 15_000)
          ),
        ]);
      } catch (error) {
        logger.error({ error, symbol: b.symbol }, "Error in bot tick");
        sendTelegramError(`MAIN LOOP [${b.symbol}]`, error);
      }
    }

    tickCount++;
    const loopDuration = Date.now() - loopStart;
    
    if (tickCount % 5 === 0) {
      logger.debug({ 
        tickCount, 
        loopDuration: `${loopDuration}ms`,
        interval: `${CONFIG.CHECK_INTERVAL}ms`,
        totalPositions: bots.reduce((sum: number, b: Bot) => sum + b.pos.length, 0)
      }, "Trading loop heartbeat");
    }

    logger.debug({ 
      tickCount, 
      loopDuration: `${loopDuration}ms`,
      nextTickIn: `${CONFIG.CHECK_INTERVAL}ms`
    }, "Tick completed");

    await new Promise(r => setTimeout(r, CONFIG.CHECK_INTERVAL));
  }
}

// Graceful shutdown
async function shutdown(signal: string) {
  sendTelegramMessage(
    `🔴 <b>BOT STOPPED</b>\n` +
    `Signal: <code>${signal}</code>\n` +
    `Time: <code>${new Date().toISOString()}</code>`
  );

  // Give time for Telegram message to be sent before process exit
  await new Promise(r => setTimeout(r, 2000));
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM")); // Docker stop
process.on("SIGINT", () => shutdown("SIGINT"));   // Ctrl+C

main();