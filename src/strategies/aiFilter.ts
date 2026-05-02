import { getOB } from "../services/orderbookWS";
import { createChildLogger } from "../utils/logger/logger";

const logger = createChildLogger("AIFilter");

interface PriceSnapshot {
  price: number;
  interval: number; // interval ke-berapa saat snapshot diambil
}

// Cache harga per timeframe dengan timestamp interval
const snap15m: Record<string, PriceSnapshot> = {};
const snap1h: Record<string, PriceSnapshot> = {};

// Interval tracker
let last15mInterval = -1;
let last1hInterval = -1;

// Dipanggil setiap tick — update cache harga per timeframe
export function updatePriceCache(symbol: string, price: number) {
  const now = new Date();
  const minuteOfDay = now.getHours() * 60 + now.getMinutes();

  const current15m = Math.floor(minuteOfDay / 15);
  const current1h = now.getHours();

  // Snapshot harga di awal interval baru
  // Simpan interval SEBELUMNYA, bukan interval saat ini
  if (current15m !== last15mInterval) {
    snap15m[symbol] = { price, interval: last15mInterval };
    last15mInterval = current15m;
    logger.debug({ symbol, price, interval: current15m }, "15m price updated");
  }

  if (current1h !== last1hInterval) {
    snap1h[symbol] = { price, interval: last1hInterval };
    last1hInterval = current1h;
    logger.debug({ symbol, price, hour: current1h }, "1h price updated");
  }
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
    p15m: s15m.price, p1h: s1h.price,
    above15m, above1h,
    ratio: ratio.toFixed(2),
    obStrong,
    enter,
  }, "Entry condition check");

  return enter;
}
