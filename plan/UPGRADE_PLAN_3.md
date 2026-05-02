# Upgrade Plan 3: Improvements & Accuracy Fixes
## Trailing Accuracy · Entry Filter · Fee · Float Drift · UX · Max Hold

Lanjutan dari `UPGRADE_PLAN_2.md`.
Implementasi setelah Plan 1 & 2 selesai dan bot sudah berjalan stabil.

---

## Improvement 1: Trailing Stop dari WebSocket, bukan Polling (`core/bot.ts` + `services/orderbookWS.ts`)

### Masalah
`tick()` polling harga setiap 30 detik via `fetchTicker`.
Kalau harga naik ke 105 lalu turun ke 103 dalam satu interval 30 detik,
`highest_price` tidak pernah mencatat 105 → trailing tidak akurat.

### Solusi
Gunakan harga dari orderbook WebSocket yang sudah ada untuk update `highest_price` secara real-time, terpisah dari `tick()`.

#### Langkah A — Expose mid price dari `orderbookWS.ts`

Tambahkan tracking `lastMidPrice` di `orderbookWS.ts`:

```ts
// Tambahkan di luar fungsi startOB, setelah deklarasi ob:
const midPrice: Record<string, number> = {};

// Di dalam ws.on("message"), setelah update ob[symbol]:
// Hitung mid price dari best bid & best ask
const bestBid = parseFloat(d.b[0]?.[0] || "0");
const bestAsk = parseFloat(d.a[0]?.[0] || "0");
if (bestBid > 0 && bestAsk > 0) {
  midPrice[symbol] = (bestBid + bestAsk) / 2;
}

// Tambahkan export function baru:
export const getMidPrice = (s: string): number | null => midPrice[s] ?? null;
```

#### Langkah B — Tambah method `updateTrailing()` di `core/bot.ts`

Tambahkan method baru di class `Bot`:

```ts
// Method ini dipanggil dari callback WebSocket orderbook
// tujuan: update highest_price secara real-time tanpa tunggu tick
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
```

#### Langkah C — Panggil `updateTrailing()` dari `orderbookWS.ts`

Di `main.ts` atau tempat `startOB` dipanggil, inject callback ke orderbookWS.
Atau lebih simpel: panggil `bot.updateTrailing(getMidPrice(symbol))` di awal setiap `tick()`, sebelum `managePositions()`:

```ts
// Tambahkan di tick(), sebelum managePositions():
const wsPrice = getMidPrice(this.symbol);
if (wsPrice && this.pos.length > 0) {
  this.updateTrailing(wsPrice);
}
```

---

## Improvement 2: Entry Filter Multi-Timeframe yang Benar (`strategies/aiFilter.ts`)

### Masalah
`shouldEnter(symbol, price, lastPrice)` membandingkan harga tick sekarang vs tick sebelumnya (30 detik lalu).
Ini bukan konfirmasi 15m + 1h — hanya momentum sangat jangka pendek.

### Solusi
Cache harga per interval 15 menit dan 1 jam, lalu bandingkan.

#### Ganti seluruh isi `aiFilter.ts`:

```ts
import { getOB } from "../services/orderbookWS";
import { createChildLogger } from "../utils/logger/logger";

const logger = createChildLogger("AIFilter");

// Cache harga per timeframe
// key: symbol, value: harga penutupan interval terakhir
const price15m: Record<string, number> = {};
const price1h: Record<string, number> = {};

// Interval tracker
let last15mInterval = -1;
let last1hInterval = -1;

// Dipanggil setiap tick — update cache harga per timeframe
export function updatePriceCache(symbol: string, price: number) {
  const now = new Date();
  const minuteOfDay = now.getHours() * 60 + now.getMinutes();

  const current15m = Math.floor(minuteOfDay / 15);
  const current1h = now.getHours();

  // Snapshot harga di awal interval baru
  if (current15m !== last15mInterval) {
    price15m[symbol] = price;
    last15mInterval = current15m;
    logger.debug({ symbol, price, interval: current15m }, "15m price updated");
  }

  if (current1h !== last1hInterval) {
    price1h[symbol] = price;
    last1hInterval = current1h;
    logger.debug({ symbol, price, hour: current1h }, "1h price updated");
  }
}

export function shouldEnter(symbol: string, price: number): boolean {
  const ob = getOB(symbol);
  if (!ob) {
    logger.debug({ symbol }, "No orderbook data");
    return false;
  }

  const p15m = price15m[symbol];
  const p1h = price1h[symbol];

  // Butuh minimal satu interval 15m dan 1h sudah tersimpan
  if (!p15m || !p1h) {
    logger.debug({ symbol }, "Price cache not ready yet");
    return false;
  }

  const ratio = ob.bids / (ob.asks || 1);
  const above15m = price > p15m;   // konfirmasi momentum 15 menit
  const above1h = price > p1h;     // konfirmasi tren 1 jam
  const obStrong = ratio > 1.2;    // orderbook masih condong bids

  const enter = above15m && above1h && obStrong;

  logger.debug({
    symbol, price,
    p15m, p1h,
    above15m, above1h,
    ratio: ratio.toFixed(2),
    obStrong,
    enter,
  }, "Entry condition check");

  return enter;
}
```

#### Update pemanggilan di `core/bot.ts`

```ts
// Import tambahan:
import { shouldEnter, updatePriceCache } from "../strategies/aiFilter";

// Di dalam tick(), sebelum entry check:
updatePriceCache(this.symbol, price);

// Ubah pemanggilan shouldEnter (hapus lastPrice):
// sebelum:
if (shouldEnter(this.symbol, price, this.lastPrice))
// sesudah:
if (shouldEnter(this.symbol, price))
```

Property `lastPrice` di class `Bot` bisa dihapus jika tidak dipakai di tempat lain.

---

## Improvement 3: Fee-Aware Profit Calculation (`core/bot.ts`)

### Masalah
Setiap market sell order kena taker fee 0.1% (default Binance).
P/L yang ditampilkan di Telegram dan dicatat di DB tidak memperhitungkan fee
→ angka selalu lebih bagus dari realita.

### Solusi

#### Tambahkan ke `config/index.ts`:

```ts
TAKER_FEE: Number(env("TAKER_FEE", 0.001)),  // 0.1% default Binance taker fee
```

#### Update kalkulasi profit di method `sell()` di `core/bot.ts`:

```ts
// sebelum:
const profit = (price - pos.buy_price) * sellAmount;

// sesudah:
const feePaid = price * sellAmount * CONFIG.TAKER_FEE;
const profit = (price - pos.buy_price) * sellAmount - feePaid;
```

Tambahkan info fee ke Telegram message di `sell()`:

```ts
// Tambahkan baris fee ke sendTelegramMessage:
`Fee: <code>-${feePaid.toFixed(4)} USDT</code>\n` +
`Net P/L: <code>${profit >= 0 ? "+" : ""}${profit.toFixed(2)} USDT</code>`
```

Tambahkan ke `.env.example`:
```env
TAKER_FEE=0.001   # Binance taker fee (0.1%). Gunakan 0.00075 jika punya BNB discount
```

---

## Improvement 4: Float Drift Fix (`core/bot.ts`)

### Masalah
`pos.amount -= sellAmt` menggunakan float arithmetic langsung.
Setelah beberapa partial sell, bisa akumulasi error kecil:
```
10.000000000000002  →  6.000000000000001  →  4.200000000000001
```
Kalau error ini dikirim ke Binance sebagai order amount, bisa reject atau mismatch.

### Solusi
Tambahkan helper function di `core/bot.ts` (di luar class):

```ts
// Bulatkan ke 8 desimal (presisi standar crypto amount di Binance)
function roundAmount(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}
```

Gunakan di semua tempat yang mengubah `pos.amount`:

```ts
// sebelum:
pos.amount -= sellAmt;

// sesudah:
pos.amount = roundAmount(pos.amount - sellAmt);
```

Gunakan juga saat menghitung `sellAmt`:

```ts
// sebelum:
const sellAmt = pos.amount * CONFIG.PARTIAL_TP1_SIZE;

// sesudah:
const sellAmt = roundAmount(pos.amount * CONFIG.PARTIAL_TP1_SIZE);
```

---

## Improvement 5: Telegram Message — Info Sisa Posisi (`core/bot.ts`)

### Masalah
Saat partial sell, user tidak tahu berapa yang masih held.
Harus cek exchange manual untuk tahu sisa posisi.

### Solusi
Update Telegram message di method `sell()` — tambahkan info sisa amount dan nilai:

```ts
// Tambahkan ke sendTelegramMessage di sell():
const remainingAfter = pos.amount - sellAmount; // hitung sebelum pos.amount diupdate
const remainingValue = remainingAfter * price;

// Tambahkan baris ini ke message:
`Remaining: <code>${remainingAfter.toFixed(6)}</code> (~<code>${remainingValue.toFixed(2)} USDT</code>)\n` +
`Trailing: <code>${(pos.trailing_pct * 100).toFixed(1)}%</code>`
```

Catatan: hitung `remainingAfter` sebelum `pos.amount` diupdate di pemanggil, atau pass sebagai parameter tambahan ke `sell()`.

---

## Improvement 6: Max Hold Time (`core/bot.ts` + `config/index.ts`)

### Masalah
Posisi bisa stuck berminggu-minggu di pasar sideways.
Harga tidak naik ke TP, tidak turun ke trailing → posisi tidak pernah closed.
Modal terikat tanpa menghasilkan apa-apa.

### Solusi

#### Tambahkan ke `config/index.ts`:

```ts
MAX_HOLD_MS: Number(env("MAX_HOLD_MS", 86400000)), // default 24 jam
```

#### Tambahkan check di `managePositions()`, sebelum break-even check:

```ts
// Max hold time exit — tambahkan sebagai check PERTAMA di dalam for loop
// (setelah closing guard):
const heldMs = Date.now() - pos.created_at;
if (heldMs > CONFIG.MAX_HOLD_MS) {
  const profit = (price - pos.buy_price) / pos.buy_price;
  this.logger.info({
    heldMs,
    maxMs: CONFIG.MAX_HOLD_MS,
    profit: (profit * 100).toFixed(2) + "%",
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
```

Tambahkan ke `.env.example`:
```env
MAX_HOLD_MS=86400000   # Max hold time in ms (86400000 = 24 jam, 0 = disabled)
```

Untuk disable fitur ini (hold selamanya), tambahkan kondisi:
```ts
if (CONFIG.MAX_HOLD_MS > 0 && heldMs > CONFIG.MAX_HOLD_MS) { ... }
```

---

## Ringkasan Semua Improvement

| # | Improvement | File yang Diubah | Impact |
|---|-------------|-----------------|--------|
| 1 | Trailing dari WS real-time | `orderbookWS.ts`, `bot.ts` | Trailing jauh lebih akurat |
| 2 | Entry filter 15m + 1h benar | `aiFilter.ts`, `bot.ts` | Entry lebih valid, kurang false signal |
| 3 | Fee-aware profit | `config/index.ts`, `bot.ts` | P/L akurat, tidak misleading |
| 4 | Float drift fix | `bot.ts` | Amount akurat, order tidak reject |
| 5 | Telegram sisa posisi | `bot.ts` | Visibility lebih baik |
| 6 | Max hold time | `config/index.ts`, `bot.ts` | Tidak ada modal terikat sia-sia |

## Urutan Implementasi yang Disarankan

```
1. Improvement 4 (Float drift)    — paling mudah, paling aman
2. Improvement 3 (Fee)            — satu konstanta + satu kalkulasi
3. Improvement 5 (Telegram)       — UX, tidak ada logic change
4. Improvement 2 (Entry filter)   — ganti aiFilter.ts sepenuhnya
5. Improvement 6 (Max hold)       — tambah satu check di loop
6. Improvement 1 (Trailing WS)    — paling kompleks, lakukan terakhir
```