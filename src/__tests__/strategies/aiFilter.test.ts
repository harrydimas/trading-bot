import { describe, it, expect, beforeEach, mock } from "bun:test";
import { initPriceCache, updatePriceCache, shouldEnter, processTick, _test } from "../../strategies/aiFilter";

// Import the setup to apply mocks
import "../setup";

describe("AIFilter Strategy", () => {
  const symbol = "BTC/USDT";

  beforeEach(() => {
    // Clear caches before each test
    for (const key in _test.snap15m) delete (_test.snap15m as any)[key];
    for (const key in _test.snap1h) delete (_test.snap1h as any)[key];
    for (const key in _test.last15mInterval) delete (_test.last15mInterval as any)[key];
    for (const key in _test.last1hInterval) delete (_test.last1hInterval as any)[key];
    for (const key in _test.currentTickPrice) delete (_test.currentTickPrice as any)[key];
    for (const key in _test.lastTelegramSent) delete (_test.lastTelegramSent as any)[key];
    for (const key in _test.lastDecision) delete (_test.lastDecision as any)[key];

    // Reset telegram spy
    const telegram = require("../../services/telegram");
    telegram.sendTelegramMessage.mockClear();
  });

  describe("initPriceCache", () => {
    it("should initialize price cache with historical data", async () => {
      await initPriceCache(symbol);

      expect(_test.snap15m[symbol]).toBeDefined();
      expect(_test.snap1h[symbol]).toBeDefined();
      expect(_test.currentTickPrice[symbol]).toBeDefined();
      
      // Prices should be numbers
      expect(typeof _test.snap15m[symbol].price).toBe("number");
      expect(typeof _test.snap1h[symbol].price).toBe("number");
      expect(typeof _test.currentTickPrice[symbol]).toBe("number");
    });

    it("should seed currentTickPrice from live candle", async () => {
      await initPriceCache(symbol);
      
      expect(_test.currentTickPrice[symbol]).toBeGreaterThan(0);
    });
  });

  describe("updatePriceCache", () => {
    it("should initialize trackers for new symbols", () => {
      updatePriceCache(symbol, 50000);
      
      expect(_test.last15mInterval[symbol]).toBeDefined();
      expect(_test.last1hInterval[symbol]).toBeDefined();
      expect(_test.currentTickPrice[symbol]).toBe(50000);
    });

    it("should snapshot price on interval change", () => {
      // First call to initialize
      updatePriceCache(symbol, 50000);
      
      // Mock time advancing by 60 minutes to ensure both 15m and 1h change
      const originalDateNow = Date.now;
      Date.now = mock(() => originalDateNow() + 60 * 60 * 1000);
      
      try {
        // Second call - should trigger snapshot
        updatePriceCache(symbol, 55000);
        
        // First price (50000) should be snapped
        expect(_test.snap15m[symbol]?.price).toBe(50000);
        expect(_test.snap1h[symbol]?.price).toBe(50000);
        
        // Current tick price should be updated
        expect(_test.currentTickPrice[symbol]).toBe(55000);
      } finally {
        Date.now = originalDateNow;
      }
    });

    it("should guard against undefined price in snapshots", () => {
      // Initialize with a price
      updatePriceCache(symbol, 50000);
      
      // Clear currentTickPrice to simulate undefined
      delete _test.currentTickPrice[symbol];
      
      // Mock time advancing
      const originalDateNow = Date.now;
      Date.now = mock(() => originalDateNow() + 15 * 60 * 1000);
      
      try {
        // Should fallback to current price (55000) for snapshot
        updatePriceCache(symbol, 55000);
        
        expect(_test.snap15m[symbol]?.price).toBe(55000); // fallback price
      } finally {
        Date.now = originalDateNow;
      }
    });
  });

  describe("shouldEnter", () => {
    beforeEach(() => {
      // Initialize cache so it's "ready"
      const current15m = Math.floor(Date.now() / (15 * 60 * 1000));
      const current1h  = Math.floor(Date.now() / (60 * 60 * 1000));

      _test.snap15m[symbol] = { price: 100, interval: current15m - 1 };
      _test.snap1h[symbol] = { price: 100, interval: current1h - 1 };
      _test.last15mInterval[symbol] = current15m;
      _test.last1hInterval[symbol] = current1h;
    });

    it("should return false when no orderbook data", () => {
      // Import the store to manipulate it
      const { obStore } = require("../setup");
      const originalOb = obStore.ob;
      obStore.ob = null;
      
      try {
        const result = shouldEnter(symbol, 105);
        expect(result).toBe(false);
      } finally {
        obStore.ob = originalOb;
      }
    });

    it("should return false when price cache not ready", () => {
      _test.snap15m[symbol] = undefined as any;
      
      const result = shouldEnter(symbol, 105);
      expect(result).toBe(false);
    });

    it("should return false when orderbook ratio is weak", () => {
      const { obStore } = require("../setup");
      const originalOb = obStore.ob;
      obStore.ob = { bids: 5, asks: 10, bestAsk: 105, bestBid: 95 }; // ratio = 0.5
      
      try {
        const result = shouldEnter(symbol, 105);
        expect(result).toBe(false);
      } finally {
        obStore.ob = originalOb;
      }
    });

    it("should return false when price not above 15m snapshot", () => {
      _test.snap15m[symbol] = { price: 110, interval: 1 }; // higher than current price
      
      const result = shouldEnter(symbol, 105);
      expect(result).toBe(false);
    });

    it("should return false when price not above 1h snapshot", () => {
      _test.snap1h[symbol] = { price: 110, interval: 1 }; // higher than current price
      
      const result = shouldEnter(symbol, 105);
      expect(result).toBe(false);
    });

    it("should return true when all conditions met", () => {
      const { obStore } = require("../setup");
      const originalOb = obStore.ob;
      obStore.ob = { bids: 20, asks: 5, bestAsk: 102, bestBid: 101 }; // strong bids
      
      try {
        _test.snap15m[symbol] = { price: 99, interval: 1 }; // price > 99
        _test.snap1h[symbol] = { price: 99, interval: 1 };   // price > 99
        
        const result = shouldEnter(symbol, 100); // 100 > 99, strong bids
        expect(result).toBe(true);
      } finally {
        obStore.ob = originalOb;
      }
    });

    it("should throttle telegram messages", () => {
      const { obStore } = require("../setup");
      const originalOb = obStore.ob;
      obStore.ob = { bids: 20, asks: 5, bestAsk: 102, bestBid: 101 };
      
      try {
        _test.snap15m[symbol] = { price: 99, interval: 1 };
        _test.snap1h[symbol] = { price: 99, interval: 1 };
        
        // Access telegram mock
        const telegram = require("../../services/telegram");
        const sendSpy = telegram.sendTelegramMessage;
        
        // First call - should send telegram
        shouldEnter(symbol, 100);
        expect(sendSpy).toHaveBeenCalledTimes(1);
        
        // Second call same decision within 60s - should not send
        shouldEnter(symbol, 100);
        expect(sendSpy).toHaveBeenCalledTimes(1);
        
        // Third call after 61s - should send again
        const originalDateNow = Date.now;
        Date.now = mock(() => originalDateNow() + 61_000);
        try {
          shouldEnter(symbol, 100);
          expect(sendSpy).toHaveBeenCalledTimes(2);
        } finally {
          Date.now = originalDateNow;
        }
        
        // Fourth call with different decision - should send
        _test.snap15m[symbol] = { price: 101, interval: 1 }; // now price < snapshot
        shouldEnter(symbol, 100);
        expect(sendSpy).toHaveBeenCalledTimes(3);
      } finally {
        obStore.ob = originalOb;
      }
    });
  });

  describe("processTick", () => {
    it("should enforce call order: updatePriceCache before shouldEnter", () => {
      // This test is a bit redundant now that we test public API, but let's keep it simple
      // By checking the effect of updatePriceCache (snapshot updated)
      updatePriceCache(symbol, 50000);
      const originalDateNow = Date.now;
      Date.now = mock(() => originalDateNow() + 15 * 60 * 1000);
      
      try {
        processTick(symbol, 55000);
        expect(_test.snap15m[symbol]?.price).toBe(50000);
      } finally {
        Date.now = originalDateNow;
      }
    });
  });
});