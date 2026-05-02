# Upgrade Plan 4: Stability & Production Hardening
## Cold Start · Balance Check · DB Schema · Health Check · WS Null · Index

Lanjutan dari `UPGRADE_PLAN_3.md`.
Fokus pada stabilitas production — semua fix di sini mencegah silent failure.

---

## Fix 1: Cold Start False Signal Guard (`strategies/aiFilter.ts`)

### Masalah
Saat bot restart tepat di awal interval baru (misal jam 09:00:01),
`price15m` dan `price1h` langsung terisi dengan harga saat ini.
Tick berikutnya: `price > p15m` → selalu true → false entry signal.

### Solusi
Simpan **timestamp** saat cache diisi. Entry hanya boleh terjadi jika cache
sudah diisi **sebelum** interval saat ini — bukan di interval yang sama.

#### Update `aiFilter.ts` — tambahkan timestamp tracking:

```ts
// Ganti deklarasi cache dari:
const price15m: Record<string, number> = {};
const price1h: Record<string, number> = {};

// Menjadi:
interface PriceSnapshot {
  price: number;
  interval: number; // interval ke-berapa saat snapshot diambil
}

const snap15m: Record<string, PriceSnapshot> = {};
const snap1h: Record<string, PriceSnapshot> = {};
```

#### Update `updatePriceCache()`:

```ts
export function updatePriceCache(symbol: string, price: number) {
  const now = new Date();
  const minuteOfDay = now.getHours() * 60 + now.getMinutes();
  const current15m = Math.floor(minuteOfDay / 15);
  const current1h = now.getHours();

  if (current15m !== last15mInterval) {
    snap15m[symbol] = { price, interval: last15mInterval }; // simpan interval SEBELUMNYA
    last15mInterval = current15m;
  }

  if (current1h !== last1hInterval) {
    snap1h[symbol] = { price, interval: last1hInterval };
    last1hInterval = current1h;
  }
}
```

#### Update `shouldEnter()`:

```ts
export function shouldEnter(symbol: string, price: number): boolean {
  const ob = getOB(symbol);
  if (!ob) return false;

  const s15m = snap15m[symbol];
  const s1h = snap1h[symbol];

  // Cache belum ada sama sekali — bot baru start, belum lewat satu interval penuh
  if (!s15m || !s1h) {
    logger.debug({ symbol }, "Price cache not ready — waiting for first full interval");
    return false;
  }

  const ratio = ob.bids / (ob.asks || 1);
  const above15m = price > s15m.price;
  const above1h = price > s1h.price;
  const obStrong = ratio > 1.2;

  const enter = above15m && above1h && obStrong;

  logger.debug({
    symbol, price,
    p15m: s15m.price, p1h: s1h.price,
    above15m, above1h, obStrong, enter,
  }, "Entry check");

  return enter;
}
```

Dengan cara ini, snapshot selalu berisi harga dari interval **sebelumnya**,
bukan interval saat ini — cold start tidak bisa trigger entry langsung.

---

## Fix 2: Balance Check Sebelum Buy (`core/bot.ts` + `exchange/client.ts`)

### Masalah
Bot tidak cek USDT balance sebelum eksekusi buy.
Kalau balance tidak cukup: order gagal → retry 5x → log penuh error → delay entry valid berikutnya.

### Solusi

#### Tambahkan helper di `exchange/client.ts`:

```ts
// Tambahkan fungsi baru:
export async function getUSDTBalance(): Promise<number> {
  const balance = await exchange.fetchBalance();
  return balance.free["USDT"] ?? 0;
}
```

#### Update method `buy()` di `core/bot.ts`:

```ts
// Import tambahan:
import { getUSDTBalance } from "../exchange/client";

// Tambahkan check ini setelah MAX_BUDGET check, sebelum checkSlippage:
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
```

Catatan: `getUSDTBalance()` menambahkan satu API call per entry attempt.
Ini acceptable karena entry hanya terjadi sekali per interval 15 menit.

---

## Fix 3: DB Schema — Tambah `closed_at` + Index (`db/init.ts`)

### Masalah 1
Schema `positions` di README tidak ada kolom `closed_at`.
Fungsi `closePosition()` dari Plan 2 akan gagal karena kolom tidak ada.
Posisi yang sudah closed akan di-load ulang saat recovery → ghost position.

### Masalah 2
Query `WHERE symbol = $1 AND closed_at IS NULL` tanpa index akan full table scan
setelah data terakumulasi lama.

### Solusi
Update query CREATE TABLE di `db/init.ts`:

```sql
-- Ganti CREATE TABLE positions dengan versi ini:
CREATE TABLE IF NOT EXISTS positions (
  id SERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  buy_price DOUBLE PRECISION NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  created_at BIGINT NOT NULL,
  highest_price DOUBLE PRECISION NOT NULL,
  trailing_pct DOUBLE PRECISION NOT NULL,
  partial1_taken BOOLEAN NOT NULL DEFAULT false,
  partial2_taken BOOLEAN NOT NULL DEFAULT false,
  break_even_armed BOOLEAN NOT NULL DEFAULT false,
  closed_at BIGINT DEFAULT NULL  -- NULL = masih open
);

-- Index untuk query recovery (dipanggil setiap restart)
CREATE INDEX IF NOT EXISTS idx_positions_symbol_open
  ON positions (symbol, closed_at)
  WHERE closed_at IS NULL;

-- Index untuk analytics / query historis
CREATE INDEX IF NOT EXISTS idx_trades_symbol_timestamp
  ON trades (symbol, timestamp DESC);
```

### Untuk DB yang sudah jalan (migration)
Jalankan query ini manual sekali di PostgreSQL:

```sql
ALTER TABLE positions ADD COLUMN IF NOT EXISTS closed_at BIGINT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_positions_symbol_open
  ON positions (symbol, closed_at)
  WHERE closed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_trades_symbol_timestamp
  ON trades (symbol, timestamp DESC);
```

---

## Fix 4: Telegram Notification Bot Start/Stop (`main.ts`)

### Masalah
Kalau bot crash dan Docker restart otomatis, user tidak tahu sampai error lain muncul.
Tidak ada notifikasi kapan bot mulai atau berhenti.

### Solusi

#### Di `main.ts`, tambahkan notifikasi startup:

```ts
// Tambahkan setelah semua service berhasil connect, sebelum setInterval:
sendTelegramMessage(
  `🟢 <b>BOT STARTED</b>\n` +
  `Symbols: <code>${CONFIG.SYMBOLS.join(", ")}</code>\n` +
  `BUY_USDT: <code>${CONFIG.BUY_USDT}</code>\n` +
  `TP1: <code>+${(CONFIG.PARTIAL_TP1_PCT * 100).toFixed(0)}%</code> | ` +
  `TP2: <code>+${(CONFIG.PARTIAL_TP2_PCT * 100).toFixed(0)}%</code>\n` +
  `Trailing: <code>${(CONFIG.TRAILING_DEFAULT * 100).toFixed(1)}%</code>\n` +
  `Max Hold: <code>${CONFIG.MAX_HOLD_MS > 0 ? CONFIG.MAX_HOLD_MS / 3600000 + "h" : "disabled"}</code>\n` +
  `Time: <code>${new Date().toISOString()}</code>`
);
```

#### Tambahkan graceful shutdown handler:

```ts
// Tambahkan di main.ts sebelum akhir file:
async function shutdown(signal: string) {
  sendTelegramMessage(
    `🔴 <b>BOT STOPPED</b>\n` +
    `Signal: <code>${signal}</code>\n` +
    `Time: <code>${new Date().toISOString()}</code>`
  );

  // Beri waktu Telegram message terkirim sebelum process exit
  await new Promise(r => setTimeout(r, 2000));
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM")); // Docker stop
process.on("SIGINT", () => shutdown("SIGINT"));   // Ctrl+C
```

---

## Fix 5: WebSocket Mid Price Null Guard (`core/bot.ts`)

### Masalah
`getMidPrice()` return `null` di detik-detik awal sebelum orderbook stream connect.
Kalau ini terjadi saat harga sedang spike, `updateTrailing()` miss update tersebut
dan `highest_price` tidak tercatat di puncaknya.

### Solusi
Fallback ke harga dari `fetchTicker` kalau mid price belum tersedia,
dan log warning agar user tahu WS belum siap.

#### Update di `tick()` di `core/bot.ts`:

```ts
// Ganti blok updateTrailing yang ada:

// sebelum:
const wsPrice = getMidPrice(this.symbol);
if (wsPrice && this.pos.length > 0) {
  this.updateTrailing(wsPrice);
}

// sesudah:
const wsPrice = getMidPrice(this.symbol);
if (this.pos.length > 0) {
  if (wsPrice) {
    this.updateTrailing(wsPrice);
  } else {
    // WS belum connect — fallback ke ticker price
    this.logger.warn({ symbol: this.symbol }, "WS mid price unavailable, using ticker price for trailing");
    this.updateTrailing(price); // price sudah ada dari fetchTicker di atas
  }
}
```

Ini memastikan `highest_price` selalu terupdate meski WS belum connect,
dengan akurasi lebih rendah (polling) sampai WS siap.

---

## Fix 6: Health Check HTTP Endpoint (`main.ts`)

### Masalah
Tidak ada cara untuk tahu bot masih hidup selain `docker-compose logs`.
Monitoring tool (UptimeRobot, Grafana, dll) tidak bisa ping bot.

### Solusi
Tambahkan simple HTTP server yang expose `/health` endpoint.

#### Tambahkan di `main.ts`:

```ts
import { createServer } from "http";

// Tambahkan state tracker di main.ts:
export const healthState = {
  startedAt: Date.now(),
  lastTickAt: 0,
  wsConnected: false,
  openPositions: 0,
};

// Tambahkan sebelum setInterval:
const healthServer = createServer((req, res) => {
  if (req.url !== "/health") {
    res.writeHead(404);
    res.end();
    return;
  }

  const uptimeMs = Date.now() - healthState.startedAt;
  const lastTickAge = Date.now() - healthState.lastTickAt;
  const isHealthy = lastTickAge < CONFIG.CHECK_INTERVAL * 3; // stale jika > 3 tick terlewat

  const body = JSON.stringify({
    status: isHealthy ? "ok" : "stale",
    uptime_ms: uptimeMs,
    last_tick_age_ms: lastTickAge,
    ws_connected: healthState.wsConnected,
    open_positions: healthState.openPositions,
    symbols: CONFIG.SYMBOLS,
    timestamp: new Date().toISOString(),
  }, null, 2);

  res.writeHead(isHealthy ? 200 : 503, { "Content-Type": "application/json" });
  res.end(body);
});

healthServer.listen(3000, () => {
  logger.info("Health check server listening on :3000");
});
```

#### Update `tick()` di `core/bot.ts` — update `lastTickAt`:

```ts
// Import healthState:
import { healthState } from "../main";

// Tambahkan di akhir tick() yang berhasil (di dalam try, setelah managePositions):
healthState.lastTickAt = Date.now();
healthState.openPositions = this.pos.length;
```

#### Update `docker-compose.yml` — expose port dan tambah healthcheck:

```yaml
bot:
  ports:
    - "3000:3000"
  healthcheck:
    test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
    interval: 60s
    timeout: 5s
    retries: 3
    start_period: 30s
```

Contoh response `/health`:
```json
{
  "status": "ok",
  "uptime_ms": 3600000,
  "last_tick_age_ms": 12000,
  "ws_connected": true,
  "open_positions": 2,
  "symbols": ["BTC/USDT", "ETH/USDT"],
  "timestamp": "2025-01-01T12:00:00.000Z"
}
```

---

## Ringkasan Semua Fix

| # | Fix | File yang Diubah | Risiko Tanpa Fix |
|---|-----|-----------------|------------------|
| 1 | Cold start false signal | `aiFilter.ts` | False entry signal saat restart |
| 2 | Balance check sebelum buy | `exchange/client.ts`, `bot.ts` | 5x retry error tiap entry attempt |
| 3 | DB schema `closed_at` + index | `db/init.ts` | Ghost position saat recovery, query lambat |
| 4 | Telegram start/stop notif | `main.ts` | Tidak tahu bot crash sampai terlambat |
| 5 | WS null guard fallback | `bot.ts` | Miss highest price saat WS belum connect |
| 6 | Health check endpoint | `main.ts`, `docker-compose.yml` | Tidak ada monitoring dari luar |

## Urutan Implementasi yang Disarankan

```
1. Fix 3 (DB schema)       — jalankan migration dulu sebelum restart apapun
2. Fix 2 (Balance check)   — cegah error storm, mudah diimplementasi
3. Fix 1 (Cold start)      — ganti logika cache di aiFilter.ts
4. Fix 5 (WS null guard)   — 5 baris di tick()
5. Fix 4 (Telegram notif)  — tambah di main.ts, zero risk
6. Fix 6 (Health check)    — lakukan terakhir, butuh update docker-compose juga
```