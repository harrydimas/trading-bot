import { pool } from "./index";
import { createChildLogger } from "../utils/logger/logger";
import { sendTelegramError } from "../services/telegram";

const logger = createChildLogger("Database");

export async function logTrade(t: any) {
  try {
    await pool.query(
      `INSERT INTO trades(symbol, side, price, amount, order_id, timestamp)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [t.symbol, t.side, t.price, t.amount, t.orderId, Date.now()]
    );
    
    logger.info({ 
      symbol: t.symbol, 
      side: t.side, 
      price: t.price, 
      amount: t.amount, 
      orderId: t.orderId 
    }, "Trade logged to database");
  } catch (error) {
    logger.error({ error, trade: t }, "Failed to log trade to database");
    sendTelegramError(`DB Trade Log [${t.symbol}]`, error);
    throw error;
  }
}

// ─── Position persistence ─────────────────────────────────────────

export async function savePosition(symbol: string, pos: any): Promise<number> {
  const result = await pool.query(
    `INSERT INTO positions
      (symbol, buy_price, amount, highest_price, trailing_pct,
       partial1_taken, partial2_taken, break_even_armed, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [symbol, pos.buy_price, pos.amount, pos.highest_price, pos.trailing_pct,
     pos.partial1_taken, pos.partial2_taken, pos.break_even_armed, pos.created_at]
  );
  return result.rows[0].id;
}

export async function updatePosition(id: number, pos: any): Promise<void> {
  await pool.query(
    `UPDATE positions SET
      amount = $1,
      highest_price = $2,
      trailing_pct = $3,
      partial1_taken = $4,
      partial2_taken = $5,
      break_even_armed = $6
     WHERE id = $7`,
    [pos.amount, pos.highest_price, pos.trailing_pct,
     pos.partial1_taken, pos.partial2_taken, pos.break_even_armed, id]
  );
}

export async function closePosition(id: number): Promise<void> {
  await pool.query(
    `UPDATE positions SET closed_at = $1 WHERE id = $2`,
    [Date.now(), id]
  );
}

export async function loadOpenPositions(symbol: string): Promise<any[]> {
  const result = await pool.query(
    `SELECT * FROM positions WHERE symbol = $1 AND closed_at IS NULL`,
    [symbol]
  );
  return result.rows;
}
