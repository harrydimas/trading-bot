import { getOB } from "../services/orderbookWS";
import { createChildLogger } from "../utils/logger/logger";
import { exchange } from "../exchange/client";

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

/**
 * Inisialisasi cache harga menggunakan data historis (Klines)
 * Mencegah bot "buta" di jam pertama setelah restart.
 */
export async function initPriceCache(symbol: string) {
  try {
    logger.info({ symbol }, "Initializing price cache with historical data...");

    const now = new Date();
    const current15m = Math.floor((now.getHours() * 60 + now.getMinutes()) / 15);
    const current1h = now.getHours();

    // Fetch 1h klines (ambil 2 terakhir: current dan previous)
    const k1h = await exchange.fetchOHLCV(symbol, "1h", undefined, 2);
    if (k1h && k1h.length >= 2) {
      const prev1h = k1h[k1h.length - 2]; // [timestamp, open, high, low, close, volume]
      const prevHour = new Date(prev1h[0]).getHours();
      snap1h[symbol] = { price: prev1h[4], interval: prevHour };
      logger.info({ symbol, price: prev1h[4], hour: prevHour }, "1h cache initialized from previous candle close");
    }

    // Fetch 15m klines
    const k15m = await exchange.fetchOHLCV(symbol, "15m", undefined, 2);
    if (k15m && k15m.length >= 2) {
      const prev15m = k15m[k15m.length - 2];
      const prev15mDate = new Date(prev15m[0]);
      const prev15mInterval = Math.floor((prev15mDate.getHours() * 60 + prev15mDate.getMinutes()) / 15);
      snap15m[symbol] = { price: prev15m[4], interval: prev15mInterval };
      logger.info({ symbol, price: prev15m[4], interval: prev15mInterval }, "15m cache initialized from previous candle close");
    }

    // Set tracker ke interval saat ini agar tidak double snapshot di tick pertama
    last15mInterval[symbol] = current15m;
    last1hInterval[symbol] = current1h;

  } catch (error) {
    logger.error({ symbol, error }, "Failed to initialize price cache");
  }
}

// Dipanggil setiap tick — update cache harga per timeframe
export function updatePriceCache(symbol: string, price: number) {
  const now = new Date();
  const minuteOfDay = now.getHours() * 60 + now.getMinutes();

  const current15m = Math.floor(minuteOfDay / 15);
  const current1h = now.getHours();

  // Initialize trackers for new symbols (fallback jika initPriceCache belum dipanggil)
  if (last15mInterval[symbol] === undefined) {
    last15mInterval[symbol] = current15m;
    last1hInterval[symbol] = current1h;
    currentTickPrice[symbol] = price;
    return;
  }

  // Snapshot harga dari interval lama saat interval baru dimulai
  // Simpan price dari tick TERAKHIR interval sebelumnya (currentTickPrice sebelum update)
  if (current15m !== last15mInterval[symbol]) {
    snap15m[symbol] = { price: currentTickPrice[symbol], interval: last15mInterval[symbol] };
    logger.debug({ symbol, price: currentTickPrice[symbol], interval: last15mInterval[symbol] }, "15m price snapshot updated (previous close)");
    last15mInterval[symbol] = current15m;
  }

  if (current1h !== last1hInterval[symbol]) {
    snap1h[symbol] = { price: currentTickPrice[symbol], interval: last1hInterval[symbol] };
    logger.debug({ symbol, price: currentTickPrice[symbol], hour: last1hInterval[symbol] }, "1h price snapshot updated (previous close)");
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

  const ratio = ob.bids / (ob.asks || 1);
  const above15m = price > s15m.price;  // konfirmasi momentum 15 menit
  const above1h = price > s1h.price;    // konfirmasi tren 1 jam
  const obStrong = ratio > 1.2;         // orderbook masih condong bids

  const enter = above15m && above1h && obStrong;

  logger.debug({
    symbol, price,
    p15m: s15m.price, i15m: s15m.interval,
    p1h: s1h.price, i1h: s1h.interval,
    above15m, above1h,
    ratio: ratio.toFixed(2),
    obStrong,
    enter,
  }, "Entry condition check");

  return enter;
}
