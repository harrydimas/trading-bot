import { mock } from "bun:test";

// --- Test Stores (exported for use in tests) ---

export const dbStore = {
  trades: [] as any[],
  positions: new Map<number, any>(),
  positionIdCounter: 1,
};

export const obStore = {
  midPrice: 50000,
  ob: { 
    bids: 10, 
    asks: 5, 
    bestAsk: 50001, 
    bestBid: 49999 
  }
};

export const healthStore = {
  healthState: {
    startedAt: Date.now(),
    lastTickAt: 0,
    wsConnected: false,
    openPositions: 0
  }
};

// --- Mock Modules ---

// Mock exchange/client.ts
mock.module("../exchange/client", () => ({
  exchange: {
    fetchBalance: mock(() => Promise.resolve({ free: { USDT: 1000 } })),
    fetchOHLCV: mock(async (symbol: string, timeframe: string, since: undefined | number, limit: number) => {
      const now = Date.now();
      if (timeframe === "1h") {
        return [
          [now - 2 * 60 * 60 * 1000, 100, 110, 90, 105, 10],
          [now - 1 * 60 * 60 * 1000, 105, 115, 95, 110, 15]
        ];
      } else if (timeframe === "15m") {
        return [
          [now - 2 * 15 * 60 * 1000, 100, 110, 90, 105, 10],
          [now - 1 * 15 * 60 * 1000, 105, 115, 95, 110, 15]
        ];
      }
      return [[now, 100, 110, 90, 105, 10]];
    }),
    createOrder: mock(async () => ({
      id: "test-order-id",
      filled: 0.001,
      status: "closed"
    })),
    createMarketSellOrder: mock(async () => ({
      id: "test-sell-order-id"
    })),
    fetchTicker: mock(async () => ({ last: 50000 }))
  },
  fetchPrice: mock(async () => obStore.midPrice),
  getUSDTBalance: mock(async () => 1000)
}));

// Mock Telegram service
mock.module("../services/telegram", () => ({
  sendTelegramMessage: mock(async () => {}),
  sendTelegramError: mock(async () => {}),
  getChatIds: mock(() => [])
}));

// Mock orderbookWS
mock.module("../services/orderbookWS", () => ({
  getOB: mock(() => obStore.ob),
  getMidPrice: mock(() => obStore.midPrice),
  startOB: mock(() => {})
}));

// Mock slippage service
mock.module("../services/slippage", () => ({
  checkSlippage: mock(() => true)
}));

// Mock DB/trades
mock.module("../db/trades", () => ({
  logTrade: mock(async (trade: any) => {
    dbStore.trades.push({ ...trade, id: Date.now() + Math.random() });
  }),
  savePosition: mock(async (symbol: string, pos: any) => {
    const id = dbStore.positionIdCounter++;
    dbStore.positions.set(id, { ...pos, id, symbol });
    return id;
  }),
  updatePosition: mock(async (id: number, pos: any) => {
    const existing = dbStore.positions.get(id);
    if (existing) {
      dbStore.positions.set(id, { ...existing, ...pos });
    }
  }),
  closePosition: mock(async (id: number) => {
    const pos = dbStore.positions.get(id);
    if (pos) {
      dbStore.positions.set(id, { ...pos, closedAt: Date.now() });
    }
  }),
  loadOpenPositions: mock(async (symbol: string) => {
    return Array.from(dbStore.positions.values())
      .filter(p => p.symbol === symbol && !p.closedAt);
  })
}));

// Mock health service
mock.module("../services/health", () => ({
  healthState: healthStore.healthState
}));

// Mock logger
mock.module("../utils/logger/logger", () => ({
  logger: {
    info: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    child: mock(() => ({
      info: mock(() => {}),
      debug: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
    }))
  },
  createChildLogger: mock(() => ({
    info: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  }))
}));

// Mock retry service
mock.module("../services/retry", () => ({
  retry: mock(async <T>(fn: () => Promise<T>) => fn())
}));

// Mock config
mock.module("../config", () => ({
  CONFIG: {
    API_KEY: "test-key",
    SECRET: "test-secret",
    TELEGRAM_BOT_TOKEN: "test-token",
    SYMBOLS: ["BTC/USDT"],
    BUY_USDT: 10,
    PARTIAL_TP1_PCT: 0.03,
    PARTIAL_TP1_SIZE: 0.4,
    PARTIAL_TP2_PCT: 0.05,
    PARTIAL_TP2_SIZE: 0.3,
    TRAILING_DEFAULT: 0.015,
    TRAILING_AFTER_TP1: 0.008,
    TRAILING_AFTER_TP2: 0.005,
    BREAK_EVEN_ARM_PCT: 0.015,
    MAX_POSITIONS: 5,
    MAX_BUDGET: 100,
    MAX_SLIPPAGE: 0.002,
    MIN_ORDER_USDT: 6,
    TAKER_FEE: 0.001,
    MAX_HOLD_MS: 86400000,
    CHECK_INTERVAL: 30000,
    DB: { host: "localhost", port: 5432, user: "test", password: "test", database: "test" }
  }
}));
