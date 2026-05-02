import { pool } from "./index";
import { createChildLogger } from "../utils/logger/logger";
import { sendTelegramError } from "../services/telegram";

const logger = createChildLogger("DatabaseInit");

export async function initDB() {
  try {
    logger.info("Initializing database schema");
    
    // Create tables if they don't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trades (
        id SERIAL PRIMARY KEY,
        symbol TEXT,
        side TEXT,
        price DOUBLE PRECISION,
        amount DOUBLE PRECISION,
        order_id TEXT,
        timestamp BIGINT
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS positions (
        id SERIAL PRIMARY KEY,
        symbol TEXT NOT NULL,
        buy_price DOUBLE PRECISION NOT NULL,
        amount DOUBLE PRECISION NOT NULL,
        highest_price DOUBLE PRECISION NOT NULL,
        trailing_pct DOUBLE PRECISION NOT NULL,
        partial1_taken BOOLEAN NOT NULL DEFAULT false,
        partial2_taken BOOLEAN NOT NULL DEFAULT false,
        break_even_armed BOOLEAN NOT NULL DEFAULT false,
        created_at BIGINT NOT NULL,
        closed_at BIGINT DEFAULT NULL
      )
    `);

    // Migration: add closed_at column if missing (for existing databases)
    await pool.query(`ALTER TABLE positions ADD COLUMN IF NOT EXISTS closed_at BIGINT DEFAULT NULL`);

    // Index untuk query recovery (dipanggil setiap restart)
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_positions_symbol_open
        ON positions (symbol, closed_at)
        WHERE closed_at IS NULL
    `);

    // Index untuk analytics / query historis
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_trades_symbol_timestamp
        ON trades (symbol, timestamp DESC)
    `);

    logger.info("Database schema initialized successfully");
  } catch (error) {
    logger.error({ error }, "Failed to initialize database schema");
    sendTelegramError("DB INIT SCHEMA", error);
    throw error;
  }
}