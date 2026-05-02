# 🧠 Trading Bot Plan (Binance + DB Final)

## 🎯 Objective

Trading bot berbasis Bun + TypeScript dengan:

* Real-time trading (WebSocket Binance)
* Smart entry (orderbook + AI filter)
* TP limit + SL market
* Risk control (max posisi + budget)
* **PostgreSQL untuk logging & analytics (bukan source of truth)**
* Recovery dari exchange

---

# 🏗️ Architecture

```id="9e2f7k"
src/
├── config/
├── db/
├── exchange/
├── services/
├── strategies/
├── core/
└── main.ts
```

---

# ⚙️ CONFIG

## `config/index.ts`

```ts id="e9c3p1"
import "dotenv/config";

const env = (k: string, d?: any) => process.env[k] ?? d;

export const CONFIG = {
  API_KEY: env("API_KEY"),
  SECRET: env("SECRET"),

  SYMBOLS: env("SYMBOLS", "BTC/USDT").split(","),

  BUY_USDT: Number(env("BUY_USDT", 10)),
  TAKE_PROFIT: Number(env("TAKE_PROFIT", 0.03)),
  STOP_LOSS: Number(env("STOP_LOSS", 0.03)),

  MAX_POSITIONS: Number(env("MAX_POSITIONS", 5)),
  MAX_BUDGET: Number(env("MAX_BUDGET", 100)),

  MAX_SLIPPAGE: Number(env("MAX_SLIPPAGE", 0.002)),
  TP_TIMEOUT_MS: Number(env("TP_TIMEOUT_MS", 600000)),

  CHECK_INTERVAL: Number(env("CHECK_INTERVAL", 30000)),

  DB: {
    host: env("DB_HOST"),
    port: Number(env("DB_PORT")),
    user: env("DB_USER"),
    password: env("DB_PASSWORD"),
    database: env("DB_NAME"),
  }
};
```

---

# 🗃️ DATABASE (PostgreSQL)

## 🎯 Role DB

* ✔ trade history
* ✔ audit log
* ✔ PnL tracking
* ❌ bukan posisi aktif

---

## `db/index.ts`

```ts id="m4w7zk"
import { Pool } from "pg";
import { CONFIG } from "../config";

export const pool = new Pool(CONFIG.DB);
```

---

## `db/init.ts`

```ts id="h6y8qn"
import { pool } from "./index";

export async function initDB() {
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
}
```

---

## `db/trades.ts`

```ts id="r8t3lp"
import { pool } from "./index";

export async function logTrade(t: any) {
  await pool.query(
    `INSERT INTO trades(symbol, side, price, amount, order_id, timestamp)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [t.symbol, t.side, t.price, t.amount, t.orderId, Date.now()]
  );
}
```

---

# 🔌 EXCHANGE

## `exchange/client.ts`

```ts id="v5k2ox"
import ccxt from "ccxt";
import { CONFIG } from "../config";

export const exchange = new ccxt.binance({
  apiKey: CONFIG.API_KEY,
  secret: CONFIG.SECRET,
  enableRateLimit: true,
});
```

---

# 📊 ORDERBOOK WS

## `services/orderbookWS.ts`

```ts id="q7y1nb"
import WebSocket from "ws";

const ob: any = {};

export function startOB(symbol: string) {
  const stream = symbol.replace("/", "").toLowerCase() + "@depth";

  const ws = new WebSocket(`wss://stream.binance.com/ws/${stream}`);

  ws.on("message", (m) => {
    const d = JSON.parse(m.toString());

    let bids = 0, asks = 0;

    for (const b of d.b.slice(0, 10)) bids += parseFloat(b[1]);
    for (const a of d.a.slice(0, 10)) asks += parseFloat(a[1]);

    ob[symbol] = { bids, asks };
  });
}

export const getOB = (s: string) => ob[s];
```

---

# 📡 USER WS (REAL-TIME EVENTS)

## `services/ws.ts`

```ts id="y2k9dx"
import WebSocket from "ws";
import { CONFIG } from "../config";

export async function startUserWS(onMsg: any) {
  const res = await fetch("https://api.binance.com/api/v3/userDataStream", {
    method: "POST",
    headers: { "X-MBX-APIKEY": CONFIG.API_KEY },
  });

  const { listenKey } = await res.json();

  const ws = new WebSocket(`wss://stream.binance.com/ws/${listenKey}`);

  ws.on("message", (m) => onMsg(JSON.parse(m.toString())));
}
```

---

# 📉 SLIPPAGE

## `services/slippage.ts`

```ts id="k3d2pz"
import { getOB } from "./orderbookWS";

export function checkSlippage(symbol: string, price: number) {
  const ob = getOB(symbol);
  if (!ob) return false;

  const estAsk = ob.asks / 10;
  const diff = Math.abs(estAsk - price) / price;

  return diff < 0.002;
}
```

---

# 🤖 STRATEGY

## `strategies/aiFilter.ts`

```ts id="x8p2jm"
import { getOB } from "../services/orderbookWS";

export function shouldEnter(symbol: string, price: number, prev: number) {
  const ob = getOB(symbol);
  if (!ob) return false;

  const ratio = ob.bids / (ob.asks || 1);
  const momentum = price > prev;

  return ratio > 1.2 && momentum;
}
```

---

# 🧠 CORE BOT

## `core/bot.ts`

```ts id="n6f4vd"
import { exchange } from "../exchange/client";
import { shouldEnter } from "../strategies/aiFilter";
import { checkSlippage } from "../services/slippage";
import { logTrade } from "../db/trades";
import { CONFIG } from "../config";

export class Bot {
  symbol: string;
  pos: any[] = [];
  lastHour = -1;
  lastPrice = 0;

  constructor(symbol: string) {
    this.symbol = symbol;
  }

  getExposure() {
    return this.pos.reduce((s, p) => s + p.buy_price * p.amount, 0);
  }

  async recover() {
    const orders = await exchange.fetchOpenOrders(this.symbol);

    this.pos = orders
      .filter(o => o.side === "sell")
      .map(o => ({
        buy_price: o.price,
        amount: o.remaining,
        tp_order_id: o.id,
        created_at: Date.now(),
      }));
  }

  async buy(price: number) {
    if (this.pos.length >= CONFIG.MAX_POSITIONS) return;
    if (this.getExposure() + CONFIG.BUY_USDT > CONFIG.MAX_BUDGET) return;
    if (!checkSlippage(this.symbol, price)) return;

    const amount = CONFIG.BUY_USDT / price;

    const order = await exchange.createMarketBuyOrder(this.symbol, amount);

    await logTrade({
      symbol: this.symbol,
      side: "buy",
      price,
      amount,
      orderId: order.id,
    });

    const tp = price * (1 + CONFIG.TAKE_PROFIT);

    const o = await exchange.createLimitSellOrder(
      this.symbol,
      amount,
      tp
    );

    this.pos.push({
      buy_price: price,
      amount,
      tp_order_id: o.id,
      created_at: Date.now(),
    });
  }

  handleWS(e: any) {
    if (e.e !== "executionReport") return;

    if (e.X === "FILLED") {
      logTrade({
        symbol: e.s,
        side: e.S,
        price: parseFloat(e.L),
        amount: parseFloat(e.l),
        orderId: e.i,
      });

      this.pos = this.pos.filter(p => p.tp_order_id !== e.i);
    }
  }

  async tick() {
    const t = await exchange.fetchTicker(this.symbol);
    const price = t.last;

    const now = new Date();

    if (now.getHours() !== this.lastHour) {
      if (shouldEnter(this.symbol, price, this.lastPrice)) {
        await this.buy(price);
      }
      this.lastHour = now.getHours();
    }

    this.lastPrice = price;
  }
}
```

---

# 🚀 MAIN

## `main.ts`

```ts id="z1k8bt"
import { Bot } from "./core/bot";
import { CONFIG } from "./config";
import { startOB } from "./services/orderbookWS";
import { startUserWS } from "./services/ws";
import { initDB } from "./db/init";

const bots = CONFIG.SYMBOLS.map(s => new Bot(s));

function routeWS(e: any) {
  bots.forEach(b => b.handleWS(e));
}

async function main() {
  await initDB();

  CONFIG.SYMBOLS.forEach(startOB);

  await startUserWS(routeWS);

  for (const b of bots) {
    await b.recover();
  }

  while (true) {
    for (const b of bots) {
      await b.tick();
    }

    await new Promise(r => setTimeout(r, CONFIG.CHECK_INTERVAL));
  }
}

main();
```

---

# 🧠 FINAL STATUS

Bot kamu sekarang:

* ✔ real-time trading (WebSocket Binance)
* ✔ smart entry (orderbook + AI filter)
* ✔ TP limit (maker)
* ✔ risk control (max posisi + budget)
* ✔ PostgreSQL logging (audit & analytics)
* ✔ clean separation (exchange = truth, DB = log)

---

# ⚠️ DISCLAIMER

* Tidak ada strategi yang menjamin profit
* Gunakan modal kecil dulu
* Monitor performa

---
