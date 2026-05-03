import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Bot } from "../../core/bot";
import { _test as aiFilterTest } from "../../strategies/aiFilter";

// Import stores and setup
import { dbStore, obStore } from "../setup";

describe("E2E Bot Flow", () => {
  const symbol = "BTC/USDT";
  let bot: Bot;

  beforeEach(() => {
    // Reset stores
    dbStore.trades = [];
    dbStore.positions.clear();
    dbStore.positionIdCounter = 1;

    obStore.midPrice = 50000;
    obStore.ob = {
      bids: 20,
      asks: 5,
      bestAsk: 50001,
      bestBid: 49999
    };

    // Setup aiFilter conditions to allow entry
    const current15m = Math.floor(Date.now() / (15 * 60 * 1000));
    const current1h  = Math.floor(Date.now() / (60 * 60 * 1000));

    aiFilterTest.snap15m[symbol] = { price: 49000, interval: current15m - 1 };
    aiFilterTest.snap1h[symbol] = { price: 49000, interval: current1h - 1 };
    aiFilterTest.last15mInterval[symbol] = current15m;
    aiFilterTest.last1hInterval[symbol] = current1h;
    aiFilterTest.currentTickPrice[symbol] = 50000;

    bot = new Bot(symbol);
  });

  it("should complete a full trade cycle (Buy -> Partial TP1 -> Partial TP2 -> Trailing Exit)", async () => {
    // 1. Initial State
    expect(bot.pos.length).toBe(0);

    // 2. Trigger Buy (tick)
    bot.lastInterval = -1; // Force check
    await bot.tick();

    expect(bot.pos.length).toBe(1);
    const pos = bot.pos[0];
    expect(pos.buy_price).toBe(50000);
    expect(pos.partial1_taken).toBe(false);

    // Verify DB save
    expect(dbStore.positions.size).toBe(1);

    // 3. Price goes up to trigger TP1 (+3.1%)
    const tp1Price = 50000 * 1.031;
    obStore.midPrice = tp1Price;
    
    await bot.tick();

    expect(bot.pos[0].partial1_taken).toBe(true);
    expect(bot.pos[0].partial2_taken).toBe(false);
    
    // Check trailing updated (TP1 is 3%, Trailing after TP1 is 0.8%)
    expect(bot.pos[0].trailing_pct).toBe(0.008); 

    // 4. Price goes up further to trigger TP2 (+5.1%)
    const tp2Price = 50000 * 1.051;
    obStore.midPrice = tp2Price;

    await bot.tick();

    expect(bot.pos[0].partial2_taken).toBe(true);
    // Trailing after TP2 is 0.5%
    expect(bot.pos[0].trailing_pct).toBe(0.005); 

    // 5. Price reaches a peak then drops to hit Trailing Stop
    const peakPrice = 50000 * 1.10; 
    obStore.midPrice = peakPrice;
    await bot.tick(); // Update highest_price
    expect(bot.pos[0].highest_price).toBe(peakPrice);

    // Trailing stop at 0.5% below peak
    const exitPrice = peakPrice * (1 - 0.005 - 0.001); 
    obStore.midPrice = exitPrice;
    
    await bot.tick();

    // Position should be closed
    expect(bot.pos.length).toBe(0);

    // Verify all trades logged (1 buy, 3 sells: TP1, TP2, Trailing)
    expect(dbStore.trades.length).toBe(4);
    const sides = dbStore.trades.map((t: any) => t.side);
    expect(sides).toEqual(["buy", "sell", "sell", "sell"]);
  });

  it("should trigger Break-Even Exit", async () => {
    // 1. Buy
    bot.lastInterval = -1;
    await bot.tick();
    expect(bot.pos.length).toBe(1);

    // 2. Price goes up to ARM break-even (+1.6%, ARM is at 1.5%)
    const armPrice = 50000 * 1.016;
    obStore.midPrice = armPrice;
    await bot.tick();
    expect(bot.pos[0].break_even_armed).toBe(true);

    // 3. Price drops back to entry
    obStore.midPrice = 50000;
    await bot.tick();

    // Position should be closed via break-even
    expect(bot.pos.length).toBe(0);
    const lastTrade = dbStore.trades[dbStore.trades.length - 1];
    expect(lastTrade.side).toBe("sell");
  });

  it("should handle recovery from DB", async () => {
    dbStore.positions.set(123, {
      id: 123,
      symbol: symbol,
      buy_price: 45000,
      amount: 0.002,
      created_at: Date.now() - 3600000,
      highest_price: 46000,
      trailing_pct: 0.015,
      partial1_taken: false,
      partial2_taken: false,
      break_even_armed: true,
    });

    await bot.recover();

    expect(bot.pos.length).toBe(1);
    expect(bot.pos[0].db_id).toBe(123);
    expect(bot.pos[0].buy_price).toBe(45000);
    expect(bot.pos[0].break_even_armed).toBe(true);
  });
});
