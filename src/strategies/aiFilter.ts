import { getOB } from "../services/orderbookWS";
import { createChildLogger } from "../utils/logger/logger";
import { exchange } from "../exchange/client";
import { sendTelegramMessage } from "../services/telegram";

const logger = createChildLogger("AIFilter");

interface PriceSnapshot {
  price: number;
  interval: number; // interval ke-berapa saat snapshot diambil
}

// Cache harga per timeframe dengan timestamp interval
const snap15m: Record<string, PriceSnapshot> = {};
const snap1h: Record<string, PriceSnapshot> = {};

// Interval tracker per symbol untuk mendukung multi-symbol
const last15mInterval: Record<string, number> = {};
const last1hInterval: Record<string, number> = {};

// Track current tick price for snapshotting
const currentTickPrice: Record<string, number> = {};

// Telegram throttle - prevent rate limit
const lastTelegramSent: Record<string, number> = {};
const lastDecision: Record<string, boolean> = {};

// Export for testing
export const _test = {
  snap15m,
  snap1h,
  last15mInterval,
  last1hInterval,
  currentTickPrice,
  lastTelegramSent,
  lastDecision,
};

/**
 * Inisialisasi cache harga menggunakan data historis (Klines)
 * Mencegah bot "buta" di jam pertama setelah restart.
 */
export async function initPriceCache(symbol: string) {
  try {
    logger.info({ symbol }, "Initializing price cache with historical data...");

    // Use epoch-based intervals (always UTC, never resets at midnight)
    const current15m = Math.floor(Date.now() / (15 * 60 * 1000));
    const current1h  = Math.floor(Date.now() / (60 * 60 * 1000));

    // Fetch 1h klines (ambil 2 terakhir: current dan previous)
    const k1h = await exchange.fetchOHLCV(symbol, "1h", undefined, 2);
    if (k1h && k1h.length >= 2) {
      const prev1h = k1h[k1h.length - 2]; // [timestamp, open, high, low, close, volume]
      const prevHourInterval = Math.floor(prev1h[0] / 1000 / (60 * 60));
      snap1h[symbol] = { price: prev1h[4], interval: prevHourInterval };
      logger.info({ symbol, price: prev1h[4], interval: prevHourInterval }, "1h cache initialized from previous candle close");
    }

    // Fetch 15m klines
    const k15m = await exchange.fetchOHLCV(symbol, "15m", undefined, 2);
    if (k15m && k15m.length >= 2) {
      const prev15m = k15m[k15m.length - 2];
      const prev15mInterval = Math.floor(prev15m[0] / 1000 / (15 * 60));
      snap15m[symbol] = { price: prev15m[4], interval: prev15mInterval };
      logger.info({ symbol, price: prev15m[4], interval: prev15mInterval }, "15m cache initialized from previous candle close");
    }

    // Set tracker ke interval saat ini agar tidak double snapshot di tick pertama
    last15mInterval[symbol] = current15m;
    last1hInterval[symbol] = current1h;

    // Seed currentTickPrice from the current (live) candle close
    const latestK1h = k1h?.[k1h.length - 1];
    if (latestK1h) {
      currentTickPrice[symbol] = latestK1h[4];
      logger.info({ symbol, price: latestK1h[4] }, "currentTickPrice seeded from live candle");
    }

  } catch (error) {
    logger.error({ symbol, error }, "Failed to initialize price cache");
  }
}

// Dipanggil setiap tick — update cache harga per timeframe
export function updatePriceCache(symbol: string, price: number) {
  // Use epoch-based intervals (always UTC, never resets at midnight)
  const current15m = Math.floor(Date.now() / (15 * 60 * 1000));
  const current1h  = Math.floor(Date.now() / (60 * 60 * 1000));

  // Initialize trackers for new symbols (fallback jika initPriceCache belum dipanggil)
  if (last15mInterval[symbol] === undefined) {
    last15mInterval[symbol] = current15m;
    last1hInterval[symbol] = current1h;
    currentTickPrice[symbol] = price;
    return;
  }

  // Snapshot harga dari interval lama saat interval baru dimulai
  // Simpan price dari tick TERAKHIR interval sebelumnya (currentTickPrice sebelum update)
  // Guard against undefined price — fallback to current tick price
  if (current15m !== last15mInterval[symbol]) {
    const prevPrice = currentTickPrice[symbol] ?? price;
    snap15m[symbol] = { price: prevPrice, interval: last15mInterval[symbol] };
    logger.debug({ symbol, price: prevPrice, interval: last15mInterval[symbol] }, "15m price snapshot updated (previous close)");
    last15mInterval[symbol] = current15m;
  }

  if (current1h !== last1hInterval[symbol]) {
    const prevPrice = currentTickPrice[symbol] ?? price;
    snap1h[symbol] = { price: prevPrice, interval: last1hInterval[symbol] };
    logger.debug({ symbol, price: prevPrice, hour: last1hInterval[symbol] }, "1h price snapshot updated (previous close)");
    last1hInterval[symbol] = current1h;
  }

  // Update current tick price AFTER checking for interval change to preserve previous close
  currentTickPrice[symbol] = price;
}

export function shouldEnter(symbol: string, price: number): boolean {
  const ob = getOB(symbol);
  if (!ob) {
    logger.debug({ symbol }, "No orderbook data");
    return false;
  }

  const s15m = snap15m[symbol];
  const s1h = snap1h[symbol];

  // Cache belum ada sama sekali — bot baru start, belum lewat satu interval penuh
  if (!s15m || !s1h) {
    logger.debug({ symbol }, "Price cache not ready — waiting for first full interval");
    return false;
  }

  // Safe orderbook ratio calculation (avoid division by zero)
  const ratio = (ob.asks > 0 && ob.bids > 0) ? ob.bids / ob.asks : 0;

  const above15m = price > s15m.price;  // konfirmasi momentum 15 menit
  const above1h = price > s1h.price;    // konfirmasi tren 1 jam
  const obStrong = ratio > 1.2;         // orderbook masih condong bids

  const enter = above15m && above1h && obStrong;

  logger.info({
    symbol, price,
    p15m: s15m.price, i15m: s15m.interval,
    p1h: s1h.price, i1h: s1h.interval,
    above15m, above1h,
    ratio: ratio.toFixed(2),
    obStrong,
    enter,
  }, "Entry condition check");

  // Telegram throttle — only notify on decision change or after 60s of same decision
  const decisionChanged = lastDecision[symbol] !== enter;
  const throttleMs = 60_000;
  const now = Date.now();
  const elapsed = now - (lastTelegramSent[symbol] ?? 0);

  if (decisionChanged || elapsed > throttleMs) {
    sendTelegramMessage(
      `${enter ? "📈" : "⏸️"} <b>ENTRY CHECK</b> ${symbol}\n` +
      `Decision: <code>${enter ? "ENTER ✅" : "HOLD"}</code>\n` +
      `Price: <code>${price}</code> | Ratio: <code>${ratio.toFixed(2)}</code>\n` +
      `15m:  <code>${above15m ? "✅" : "❌"}</code> price > prev <code>${s15m.price}</code> (int: ${s15m.interval})\n` +
      `1h:   <code>${above1h ? "✅" : "❌"}</code> price > prev <code>${s1h.price}</code> (int: ${s1h.interval})\n` +
      `OB:   <code>${obStrong ? "✅" : "❌"}</code> ratio <code>${ratio.toFixed(2)}</code> > 1.2`
    );
    lastTelegramSent[symbol] = now;
    lastDecision[symbol] = enter;
  }

  return enter;
}

/**
 * Wrapper that enforces call order: updatePriceCache before shouldEnter.
 * Callers should use this instead of calling both functions separately.
 */
export function processTick(symbol: string, price: number): boolean {
  updatePriceCache(symbol, price);
  return shouldEnter(symbol, price);
}
