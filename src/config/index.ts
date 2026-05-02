import "dotenv/config";

const env = (k: string, d?: any) => process.env[k] ?? d;

export const CONFIG = {
  API_KEY: env("API_KEY"),
  SECRET: env("SECRET"),
  TELEGRAM_BOT_TOKEN: env("TELEGRAM_BOT_TOKEN"),

  SYMBOLS: env("SYMBOLS", "BTC/USDT").split(","),

   BUY_USDT: Number(env("BUY_USDT", 10)),

   // Partial Take Profit
   PARTIAL_TP1_PCT: Number(env("PARTIAL_TP1_PCT", 0.03)),   // trigger profit 3%
   PARTIAL_TP1_SIZE: Number(env("PARTIAL_TP1_SIZE", 0.4)),   // jual 40% posisi

   PARTIAL_TP2_PCT: Number(env("PARTIAL_TP2_PCT", 0.05)),    // trigger profit 5%
   PARTIAL_TP2_SIZE: Number(env("PARTIAL_TP2_SIZE", 0.3)),   // jual 30% posisi

   // Trailing Stop (dinamis)
   TRAILING_DEFAULT: Number(env("TRAILING_DEFAULT", 0.015)),     // 1.5% sebelum TP apapun
   TRAILING_AFTER_TP1: Number(env("TRAILING_AFTER_TP1", 0.008)),// 0.8% setelah TP1
   TRAILING_AFTER_TP2: Number(env("TRAILING_AFTER_TP2", 0.005)),// 0.5% setelah TP2

   // Break-Even
   BREAK_EVEN_ARM_PCT: Number(env("BREAK_EVEN_ARM_PCT", 0.015)),// arm saat profit >= 1.5%

   MAX_POSITIONS: Number(env("MAX_POSITIONS", 5)),
   MAX_BUDGET: Number(env("MAX_BUDGET", 100)),

   MAX_SLIPPAGE: Number(env("MAX_SLIPPAGE", 0.002)),

    MIN_ORDER_USDT: Number(env("MIN_ORDER_USDT", 6)),

    TAKER_FEE: Number(env("TAKER_FEE", 0.001)),

    MAX_HOLD_MS: Number(env("MAX_HOLD_MS", 86400000)),

   CHECK_INTERVAL: Number(env("CHECK_INTERVAL", 30000)),

  DB: {
    host: env("DB_HOST"),
    port: Number(env("DB_PORT")),
    user: env("DB_USER"),
    password: env("DB_PASSWORD"),
    database: env("DB_NAME"),
  }
};
