import { exchange, getUSDTBalance, fetchPrice } from "../exchange/client";
import { shouldEnter, updatePriceCache } from "../strategies/aiFilter";
import { getMidPrice } from "../services/orderbookWS";
import { checkSlippage } from "../services/slippage";
import { logTrade, savePosition, updatePosition, closePosition, loadOpenPositions } from "../db/trades";
import { CONFIG } from "../config";
import { createChildLogger } from "../utils/logger/logger";
import { sendTelegramMessage, sendTelegramError } from "../services/telegram";
import { healthState } from "../services/health";

interface Position {
  db_id?: number;
  buy_price: number;
  amount: number;
  created_at: number;
  highest_price: number;
  trailing_pct: number;
  partial1_taken: boolean;
  partial2_taken: boolean;
  break_even_armed: boolean;
  closing: boolean;
}

function isAboveMinOrder(amount: number, price: number): boolean {
  return amount * price >= CONFIG.MIN_ORDER_USDT;
}

function roundAmount(n: number): number {
  return Math.ceil(n * 1e8) / 1e8;
}

export class Bot {
  symbol: string;
  pos: Position[] = [];
  lastInterval = -1;
  lastPrice = 0;
  private isTicking = false;
  private logger;

  constructor(symbol: string) {
    this.symbol = symbol;
    this.logger = createChildLogger(`Bot:${symbol}`);
  }

  getExposure() {
    return this.pos.reduce((s, p) => s + p.buy_price * p.amount, 0);
  }

  async recover() {
    this.logger.info("Recovering positions from DB");
    try {
      const rows = await loadOpenPositions(this.symbol);

      this.pos = rows.map(r => ({
        db_id: r.id,
        buy_price: r.buy_price,
        amount: r.amount,
        created_at: Number(r.created_at),
        highest_price: r.highest_price,
        trailing_pct: r.trailing_pct,
        partial1_taken: r.partial1_taken,
        partial2_taken: r.partial2_taken,
        break_even_armed: r.break_even_armed,
        closing: false,
      }));

      this.logger.info({ recovered: this.pos.length }, "Positions recovered from DB");
    } catch (error) {
      this.logger.error({ error }, "Failed to recover positions");
      sendTelegramError(`RECOVER [${this.symbol}]`, error);
      throw error;
    }
  }

  async buy(price: number) {
    if (this.pos.length >= CONFIG.MAX_POSITIONS) {
      this.logger.debug({ positions: this.pos.length, max: CONFIG.MAX_POSITIONS }, "Max positions reached, skipping buy");
      return;
    }

    const currentExposure = this.getExposure();
    if (currentExposure + CONFIG.BUY_USDT > CONFIG.MAX_BUDGET) {
      this.logger.debug({ exposure: currentExposure, budget: CONFIG.MAX_BUDGET }, "Max budget reached, skipping buy");
      return;
    }

    const usdtBalance = await getUSDTBalance();
    if (usdtBalance < CONFIG.BUY_USDT) {
      this.logger.warn({
        balance: usdtBalance,
        required: CONFIG.BUY_USDT,
      }, "Insufficient USDT balance, skipping buy");
      sendTelegramMessage(
        `⚠️ <b>INSUFFICIENT BALANCE</b> ${this.symbol}\n` +
        `Balance: <code>${usdtBalance.toFixed(2)} USDT</code>\n` +
        `Required: <code>${CONFIG.BUY_USDT} USDT</code>`
      );
      return;
    }

    if (!checkSlippage(this.symbol, price)) {
      this.logger.debug({ price }, "Slippage check failed, skipping buy");
      return;
   }

    const amount = roundAmount(CONFIG.BUY_USDT / price);

    if (!isAboveMinOrder(amount, price)) {
      this.logger.warn(
        { amount, price, notional: amount * price, min: CONFIG.MIN_ORDER_USDT },
        "Buy order below minimum notional, skipping"
      );
      return;
    }

    this.logger.info({ price, amount, exposure: currentExposure }, "Executing buy order");

    try {
      const order = await exchange.createOrder(
        this.symbol,
        "market",
        "buy",
        amount,
        undefined,
        { quoteOrderQty: CONFIG.BUY_USDT }
      );
      const filledAmount = (order.filled as number) || amount;
      this.logger.info({ orderId: order.id, price, amount: filledAmount }, "Buy order executed");

      sendTelegramMessage(
        `✅ <b>BUY ORDER EXECUTED</b>\n` +
        `Symbol: <code>${this.symbol}</code>\n` +
        `Price: <code>${price}</code>\n` +
        `Amount: <code>${filledAmount.toFixed(6)}</code>\n` +
        `Value: <code>${(price * filledAmount).toFixed(2)} USDT</code>\n` +
        `Positions: <code>${this.pos.length + 1}/${CONFIG.MAX_POSITIONS}</code>`
      );

      await logTrade({
        symbol: this.symbol,
        side: "buy",
        price,
        amount: filledAmount,
        orderId: order.id,
      });

      const newPos: Position = {
        buy_price: price,
        amount: filledAmount,
        created_at: Date.now(),
        highest_price: price,
        trailing_pct: CONFIG.TRAILING_DEFAULT,
        partial1_taken: false,
        partial2_taken: false,
        break_even_armed: false,
        closing: false,
      };

      this.pos.push(newPos);

      // Simpan ke DB
      const dbId = await savePosition(this.symbol, newPos);
      newPos.db_id = dbId;

      this.logger.info({ positions: this.pos.length }, "Position opened");

      sendTelegramMessage(
        `✅ <b>POSITION OPENED</b>\n` +
        `Symbol: <code>${this.symbol}</code>\n` +
        `Entry: <code>${price}</code>\n` +
        `Amount: <code>${filledAmount.toFixed(6)}</code>`
      );
    } catch (error) {
      this.logger.error({ error, price, amount }, "Failed to execute buy order");
      sendTelegramError(`BUY [${this.symbol}]`, error);
      throw error;
    }
  }

  handleWS(e: any) {
    if (e.e !== "executionReport") return;
    if (e.X === "FILLED") {
      this.logger.info({
        orderId: e.i,
        side: e.S,
        price: parseFloat(e.L),
        amount: parseFloat(e.l),
      }, "Order filled via WebSocket");
    }
  }

  updateTrailing(price: number) {
    for (const pos of this.pos) {
      if (pos.closing) continue;
      if (price > pos.highest_price) {
        pos.highest_price = price;
        this.logger.debug({
          symbol: this.symbol,
          newHighest: price,
        }, "Highest price updated from WS");
      }
    }
  }

  private async sell(pos: Position, sellAmount: number, price: number, reason: string): Promise<boolean> {
    try {
      const order = await exchange.createMarketSellOrder(this.symbol, sellAmount);
      const feePaid = price * sellAmount * CONFIG.TAKER_FEE;
      const profit = (price - pos.buy_price) * sellAmount - feePaid;
      const remainingAfter = pos.amount - sellAmount;
      const remainingValue = remainingAfter * price;

      await logTrade({
        symbol: this.symbol,
        side: "sell",
        price,
        amount: sellAmount,
        orderId: order.id,
      });

      sendTelegramMessage(
        `🔴 <b>SELL (${reason})</b> ${this.symbol}\n` +
        `Entry: <code>${pos.buy_price}</code> → Exit: <code>${price}</code>\n` +
        `Amount: <code>${sellAmount.toFixed(6)}</code>\n` +
        `Fee: <code>-${feePaid.toFixed(4)} USDT</code>\n` +
        `Net P/L: <code>${profit >= 0 ? "+" : ""}${profit.toFixed(2)} USDT</code>\n` +
        `Remaining: <code>${remainingAfter.toFixed(6)}</code> (~<code>${remainingValue.toFixed(2)} USDT</code>)\n` +
        `Trailing: <code>${(pos.trailing_pct * 100).toFixed(1)}%</code>`
      );

      return true;
    } catch (error) {
      this.logger.error({ error, reason }, "Sell failed");
      sendTelegramError(`SELL [${this.symbol}] ${reason}`, error);
      return false;
    }
  }

  async managePositions(price: number) {
    const toRemove: Position[] = [];

    for (const pos of this.pos) {
      // Ghost position guard - skip jika posisi sedang dalam proses close
      if (pos.closing) continue;

      const profit = (price - pos.buy_price) / pos.buy_price;

      // Update highest price
      if (price > pos.highest_price) {
        pos.highest_price = price;
      }

      // Max hold time exit - tambahkan sebagai check PERTAMA setelah highest price update
      if (CONFIG.MAX_HOLD_MS > 0) {
        const heldMs = Date.now() - pos.created_at;
        if (heldMs > CONFIG.MAX_HOLD_MS) {
          const profitPct = (price - pos.buy_price) / pos.buy_price;
          this.logger.info({
            heldMs,
            maxMs: CONFIG.MAX_HOLD_MS,
            profit: (profitPct * 100).toFixed(2) + "%",
          }, "Max hold time reached, force exit");

          pos.closing = true;
          const ok = await this.sell(pos, pos.amount, price, `MAX-HOLD ${Math.round(heldMs / 3600000)}h`);
          if (ok) {
            if (pos.db_id) await closePosition(pos.db_id);
            toRemove.push(pos);
            continue;
          }
          pos.closing = false;
        }
      }

      // 1. Break-Even Arm
      if (!pos.break_even_armed && profit >= CONFIG.BREAK_EVEN_ARM_PCT) {
        pos.break_even_armed = true;
        if (pos.db_id) await updatePosition(pos.db_id, pos);
        this.logger.info({ profit: (profit * 100).toFixed(2) + "%" }, "Break-even armed");
        sendTelegramMessage(
          `🛡️ <b>BREAK-EVEN ARMED</b> ${this.symbol}\n` +
          `Entry: <code>${pos.buy_price}</code> | Now: <code>${price}</code>\n` +
          `Profit: <code>+${(profit * 100).toFixed(2)}%</code>`
        );
      }

      // 2. Break-Even Exit
      if (pos.break_even_armed && price <= pos.buy_price) {
        pos.closing = true;
        const ok = await this.sell(pos, pos.amount, price, "BREAK-EVEN");
        if (ok) {
          toRemove.push(pos);
          if (pos.db_id) await closePosition(pos.db_id);
          continue;
        }
        pos.closing = false; // reset jika gagal
      }

      // 3. Partial TP Layer 1 (default 3%)
      if (!pos.partial1_taken && profit >= CONFIG.PARTIAL_TP1_PCT) {
        const sellAmt = roundAmount(pos.amount * CONFIG.PARTIAL_TP1_SIZE);

        if (!isAboveMinOrder(sellAmt, price)) {
          // Notional terlalu kecil - skip partial, langsung jual semua
          this.logger.warn({ sellAmt, price, notional: sellAmt * price }, "Partial TP1 below min order, selling all");
          pos.closing = true;
          const ok = await this.sell(pos, pos.amount, price, "TP1-FULL (min order)");
          if (ok) {
            toRemove.push(pos);
            if (pos.db_id) await closePosition(pos.db_id);
            continue;
          }
          pos.closing = false;
        } else {
          pos.closing = true;
          const ok = await this.sell(pos, sellAmt, price, `TP1 +${(CONFIG.PARTIAL_TP1_PCT * 100).toFixed(0)}%`);
          if (ok) {
            pos.amount = roundAmount(pos.amount - sellAmt);
            pos.partial1_taken = true;
            pos.trailing_pct = CONFIG.TRAILING_AFTER_TP1;
            if (pos.db_id) await updatePosition(pos.db_id, pos);
          }
          pos.closing = false;
        }
      }

      // 4. Partial TP Layer 2 (default 5%)
      if (pos.partial1_taken && !pos.partial2_taken && profit >= CONFIG.PARTIAL_TP2_PCT) {
        const sellAmt = roundAmount(pos.amount * CONFIG.PARTIAL_TP2_SIZE);

        if (!isAboveMinOrder(sellAmt, price)) {
          // Notional terlalu kecil - skip partial, langsung jual semua
          this.logger.warn({ sellAmt, price, notional: sellAmt * price }, "Partial TP2 below min order, selling all");
          pos.closing = true;
          const ok = await this.sell(pos, pos.amount, price, "TP2-FULL (min order)");
          if (ok) {
            toRemove.push(pos);
            if (pos.db_id) await closePosition(pos.db_id);
            continue;
          }
          pos.closing = false;
        } else {
          pos.closing = true;
          const ok = await this.sell(pos, sellAmt, price, `TP2 +${(CONFIG.PARTIAL_TP2_PCT * 100).toFixed(0)}%`);
          if (ok) {
            pos.amount = roundAmount(pos.amount - sellAmt);
            pos.partial2_taken = true;
            pos.trailing_pct = CONFIG.TRAILING_AFTER_TP2;
            if (pos.db_id) await updatePosition(pos.db_id, pos);
          }
          pos.closing = false;
        }
      }

      // 5. Trailing Stop
      const trailingTrigger = pos.highest_price * (1 - pos.trailing_pct);
      if (price <= trailingTrigger) {
        pos.closing = true;
        const ok = await this.sell(pos, pos.amount, price, `TRAILING -${(pos.trailing_pct * 100).toFixed(1)}%`);
        if (ok) {
          toRemove.push(pos);
          if (pos.db_id) await closePosition(pos.db_id);
          continue;
        }
        pos.closing = false;
      }
    }

    this.pos = this.pos.filter(p => !toRemove.includes(p));
  }

  async tick() {
    // Race condition guard - skip jika tick sebelumnya belum selesai
    if (this.isTicking) {
      this.logger.warn("Tick skipped - previous tick still running");
      return;
    }

    this.isTicking = true;

    try {
      // ── Price sourcing: WS mid-price first, fast REST fallback ──
      const wsPrice = getMidPrice(this.symbol);
      let price: number;
      let priceSource: string;

      if (wsPrice) {
        price = wsPrice;
        priceSource = "ws";
      } else {
        const restPrice = await fetchPrice(this.symbol, 8000);
        if (restPrice) {
          price = restPrice;
          priceSource = "rest";
        } else {
          this.logger.warn("No price from WS or REST, skipping tick");
          return;
        }
      }

      const now = new Date();
      const currentInterval = Math.floor((now.getHours() * 60 + now.getMinutes()) / 15);

      this.logger.debug({
        symbol: this.symbol,
        price,
        priceSource,
        currentInterval,
        lastInterval: this.lastInterval,
        positions: this.pos.length,
        exposure: this.getExposure()
      }, "Tick update");

      // Update trailing always from WS (real-time mid) if available
      const trailingPrice = getMidPrice(this.symbol) || price;
      if (this.pos.length > 0) {
        this.updateTrailing(trailingPrice);
      }

      // Update price cache untuk multi-timeframe entry filter
      updatePriceCache(this.symbol, price);

      if (currentInterval !== this.lastInterval) {
        this.logger.info({
          price,
          interval: currentInterval
        }, "15-minute check - evaluating entry conditions");

        if (shouldEnter(this.symbol, price)) {
          sendTelegramMessage(
            `📈 <b>ENTRY SIGNAL</b>\n` +
            `Symbol: <code>${this.symbol}</code>\n` +
            `Price: <code>${price}</code>\n` +
            `Interval: <code>${currentInterval}</code>`
          );
          await this.buy(price);
        } else {
          this.logger.info("Entry conditions not met - no trade this interval");
        }
        this.lastInterval = currentInterval;
      }

      this.lastPrice = price;

      if (this.pos.length > 0) {
        await this.managePositions(price);
      }

      // Update health state
      healthState.lastTickAt = Date.now();
      healthState.openPositions = this.pos.length;
    } catch (error) {
      this.logger.error({ error }, "Error in tick");
      sendTelegramError(`TICK [${this.symbol}]`, error);
    } finally {
      this.isTicking = false;
    }
  }
}