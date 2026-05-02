# AIFilter Improvement Plan

## Overview

Fixes and improvements for `aiFilter.ts` based on code review. Items are ordered by priority — fix critical bugs first before moving to improvements.

-----

## 🔴 Critical Fixes (Fix First)

### 1. Timezone Bug — `getHours()` → `getUTCHours()`

**Problem:** `new Date().getHours()` uses the server's local timezone. Binance OHLCV data uses UTC. If the server runs in WIB (UTC+7), interval boundaries are misaligned by 7 hours, causing snapshots at the wrong time.

**Affected functions:** `initPriceCache`, `updatePriceCache`

**Fix:**

```typescript
const now = new Date();
const hour = now.getUTCHours();
const minute = now.getUTCMinutes();
const minuteOfDay = hour * 60 + minute;

const current15m = Math.floor(minuteOfDay / 15);
const current1h = hour;
```

Apply this in both `initPriceCache` (for `current15m` / `current1h` seed values) and `updatePriceCache` (for interval change detection).

-----

### 2. `currentTickPrice` Never Seeded in `initPriceCache`

**Problem:** `initPriceCache` sets `last15mInterval` and `last1hInterval` but never sets `currentTickPrice[symbol]`. If the interval boundary is crossed on the second tick (before `currentTickPrice` is assigned), the snapshot saves `undefined`.

**Fix:** At the end of `initPriceCache`, seed `currentTickPrice` from the current (live) candle close:

```typescript
// Seed currentTickPrice from the current live candle
const latestK1h = k1h[k1h.length - 1];
currentTickPrice[symbol] = latestK1h[4]; // index 4 = close price
logger.info({ symbol, price: latestK1h[4] }, "currentTickPrice seeded from live candle");
```

-----

### 3. Snapshot Guard for `undefined` Price

**Problem:** Even with fix #2, a defensive guard should exist so a snapshot never saves `undefined`. This is a safety net for symbols initialized via the fallback path (without `initPriceCache`).

**Fix:** In `updatePriceCache`, guard both snapshot assignments:

```typescript
if (current15m !== last15mInterval[symbol]) {
  const prevPrice = currentTickPrice[symbol] ?? price; // fallback to current tick
  snap15m[symbol] = { price: prevPrice, interval: last15mInterval[symbol] };
  last15mInterval[symbol] = current15m;
}

if (current1h !== last1hInterval[symbol]) {
  const prevPrice = currentTickPrice[symbol] ?? price;
  snap1h[symbol] = { price: prevPrice, interval: last1hInterval[symbol] };
  last1hInterval[symbol] = current1h;
}
```

-----

### 4. Orderbook Division Guard

**Problem:** `ob.bids / (ob.asks || 1)` — if `ob.asks` is `0`, ratio inflates to `ob.bids` (potentially thousands). The `|| 1` fallback makes it look like a valid ratio when it isn't.

**Fix:**

```typescript
const ratio = ob.asks > 0 ? ob.bids / ob.asks : 0;
```

If `ob.bids` can also be zero or negative, add:

```typescript
const ratio = (ob.asks > 0 && ob.bids > 0) ? ob.bids / ob.asks : 0;
```

-----

## 🟡 Important Improvements

### 5. Telegram Throttle

**Problem:** `sendTelegramMessage` is called on every tick. At 1–10 ticks/second, this hits Telegram's rate limit (30 messages/second per bot, 1 message/second per chat) and will eventually get the bot banned.

**Fix:** Throttle per symbol, and only send when the decision *changes*:

```typescript
const lastTelegramSent: Record<string, number> = {};
const lastDecision: Record<string, boolean> = {};

// Inside shouldEnter, replace sendTelegramMessage call:
const decisionChanged = lastDecision[symbol] !== enter;
const throttleMs = 60_000; // 1 minute minimum between same-decision messages
const now = Date.now();
const elapsed = now - (lastTelegramSent[symbol] ?? 0);

if (decisionChanged || elapsed > throttleMs) {
  sendTelegramMessage(/* ... existing message ... */);
  lastTelegramSent[symbol] = now;
  lastDecision[symbol] = enter;
}
```

This ensures you always get notified on HOLD → ENTER (or vice versa), but suppresses repeated identical messages.

-----

### 6. Interval Bucket: Use Epoch-Based Timestamps

**Problem:** `Math.floor(minuteOfDay / 15)` resets every midnight. Interval `0` at 00:00 today is identical to interval `0` at 00:00 yesterday. If the bot runs across midnight, it won't detect the interval change.

**Fix:** Use epoch-based buckets that are globally unique:

```typescript
const current15m = Math.floor(Date.now() / (15 * 60 * 1000));
const current1h  = Math.floor(Date.now() / (60 * 60 * 1000));
```

Update both `initPriceCache` and `updatePriceCache`. Note: Fix timezone bug (#1) first — epoch timestamps are always UTC so this also resolves the timezone concern for interval detection.

-----

## 🟢 Optional Enhancements

### 7. Volatility Filter

**Problem:** In a flat/sideways market, price can be marginally above `s15m.price` and `s1h.price` without any real momentum. The current logic would still return `enter = true`.

**Fix:** Add a minimum price change threshold:

```typescript
const change15m = Math.abs(price - s15m.price) / s15m.price;
const change1h  = Math.abs(price - s1h.price) / s1h.price;

const hasVolatility = change15m > 0.002 && change1h > 0.001; // 0.2% and 0.1%
const enter = above15m && above1h && obStrong && hasVolatility;
```

Tune thresholds per asset (crypto vs lower-vol assets need different values).

-----

### 8. Enforce Call Order via Wrapper

**Problem:** There is no guarantee that `updatePriceCache` is called before `shouldEnter` each tick. If call order breaks, stale prices are silently used.

**Fix:** Export a single `processTick` function that enforces the order:

```typescript
export function processTick(symbol: string, price: number): boolean {
  updatePriceCache(symbol, price);
  return shouldEnter(symbol, price);
}
```

Callers use `processTick` instead of calling both functions separately.

-----

### 9. Strict `>` vs `>=` for Entry Conditions

**Problem:** `price > s15m.price` returns `false` when price exactly equals the snapshot. In practice this is rare, but worth noting.

**Decision:** Keep `>` (strict) — entering at exactly the previous close is not a confirmed breakout. Only change to `>=` if backtesting shows missed entries at key levels.

-----

## Implementation Order

|#|Fix                            |Priority   |Risk if Skipped                |
|-|-------------------------------|-----------|-------------------------------|
|1|Timezone UTC fix               |🔴 Critical |Wrong interval detection       |
|2|Seed `currentTickPrice` in init|🔴 Critical |`undefined` snapshot on restart|
|3|Snapshot `undefined` guard     |🔴 Critical |Entry logic corruption         |
|4|OB division guard              |🔴 Critical |Inflated ratio, false entry    |
|5|Telegram throttle              |🟡 Important|Rate limit / bot ban           |
|6|Epoch interval buckets         |🟡 Important|Midnight boundary miss         |
|7|Volatility filter              |🟢 Optional |Flat market false entries      |
|8|`processTick` wrapper          |🟢 Optional |Fragile call order             |
|9|`>` vs `>=` review             |🟢 Optional |Rare edge case only            |

-----

## Notes

- All four critical fixes (#1–#4) are low-risk, surgical changes. Apply them in a single commit.
- Fix #6 (epoch buckets) implicitly fixes the timezone issue for interval detection — but fix #1 still needed for `initPriceCache`'s seed values.
- Do not change entry logic (`&&` → `||`) without backtesting data. The conservative AND gate is a feature, not a bug.
