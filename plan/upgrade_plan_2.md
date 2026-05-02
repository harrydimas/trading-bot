# Upgrade Plan 2: Bug Fixes & Edge Cases
## Ghost Position · Recovery · Min Order · Race Condition

Lanjutan dari `UPGRADE_PLAN.md`.
Semua fix di sini harus diimplementasi **setelah** UPGRADE_PLAN.md selesai.

---

## Fix 1: Ghost Position Guard (`core/bot.ts`)

### Masalah
`managePositions()` memanggil `sell()` lalu push ke `toRemove`.
Kalau bot crash di antara keduanya, posisi tidak pernah di-remove — jadi ghost position yang terus di-loop setiap tick dan bisa trigger sell lagi.

### Solusi
Tambahkan flag `closing` di interface `Position`:

```ts
// Tambahkan field ini ke interface Position
interface Position {
  // ... field yang sudah ada ...
  closing: boolean; // true saat sell sedang diproses — guard dari double-sell
}
```

Inisialisasi `closing: false` di semua tempat yang membuat Position baru:
- method `buy()`
- method `recover()`

Di awal loop `for (const pos of this.pos)` dalam `managePositions()`, tambahkan guard:

```ts
// Tambahkan ini sebagai baris PERTAMA di dalam for loop:
if (pos.closing) continue;
```

Setiap kali sebelum memanggil `this.sell(...)`, set flag dulu:

```ts
// Sebelum setiap sell call, tambahkan:
pos.closing = true;
const ok = await this.sell(pos, pos.amount, price, "...");
if (!ok) {
  pos.closing = false; // reset jika sell gagal, biar bisa retry
}
```

---

## Fix 2: Recovery dari DB, bukan dari Open Orders (`src/db/trades.ts` + `core/bot.ts`)

### Masalah
Di v3 tidak ada lagi limit sell order yang dipasang saat entry.
Artinya `exchange.fetchOpenOrders()` tidak return apa-apa → `recover()` selalu menghasilkan posisi kosong → semua posisi aktif hilang saat bot restart.

### Solusi: Simpan & load posisi aktif dari DB

#### Langkah A — Tambah tabel baru di `src/db/init.ts`

Tambahkan query ini ke fungsi init DB:

```sql
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
  closed_at BIGINT
);
```

#### Langkah B — Tambah fungsi di `src/db/trades.ts`

Tambahkan 3 fungsi baru:

```ts
// Simpan posisi baru saat entry
export async function savePosition(symbol: string, pos: Position): Promise<number> {
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

// Update state posisi setiap kali ada perubahan (partial sell, trailing update, dll)
export async function updatePosition(id: number, pos: Position): Promise<void> {
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

// Tandai posisi sebagai closed
export async function closePosition(id: number): Promise<void> {
  await pool.query(
    `UPDATE positions SET closed_at = $1 WHERE id = $2`,
    [Date.now(), id]
  );
}

// Load semua posisi aktif (belum closed) untuk satu symbol
export async function loadOpenPositions(symbol: string): Promise<any[]> {
  const result = await pool.query(
    `SELECT * FROM positions WHERE symbol = $1 AND closed_at IS NULL`,
    [symbol]
  );
  return result.rows;
}
```

#### Langkah C — Tambah field `db_id` di interface `Position`

```ts
interface Position {
  db_id?: number;  // id dari tabel positions, untuk update & close
  // ... field lainnya tetap sama ...
}
```

#### Langkah D — Update `buy()` di `core/bot.ts`

Setelah push ke `this.pos`, simpan ke DB:

```ts
// Tambahkan setelah this.pos.push(pos):
const dbId = await savePosition(this.symbol, pos);
pos.db_id = dbId;
```

#### Langkah E — Update `managePositions()` di `core/bot.ts`

Setelah setiap perubahan state posisi (partial sell, trailing update), panggil `updatePosition`:

```ts
// Tambahkan setelah setiap blok yang mengubah pos (TP1, TP2, trailing update):
if (pos.db_id) await updatePosition(pos.db_id, pos);
```

Saat posisi fully closed (break-even atau trailing), panggil `closePosition`:

```ts
// Tambahkan setelah toRemove.push(pos):
if (pos.db_id) await closePosition(pos.db_id);
```

#### Langkah F — Ganti `recover()` di `core/bot.ts`

```ts
// sebelum — recover dari exchange open orders
// sesudah — recover dari DB:

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
```

---

## Fix 3: Minimum Order Size Check (`core/bot.ts`)

### Masalah
Binance menolak order dengan notional value < ~$5 (tergantung pair).
Kalau `BUY_USDT=10` dan `PARTIAL_TP1_SIZE=0.4` → sell $4 → order reject.

### Solusi
Tambahkan konstanta dan helper check di `config/index.ts`:

```ts
// Tambahkan ke CONFIG:
MIN_ORDER_USDT: Number(env("MIN_ORDER_USDT", 6)), // minimum notional per order
```

Tambahkan helper function di `core/bot.ts` (di luar class):

```ts
function isAboveMinOrder(amount: number, price: number): boolean {
  return amount * price >= CONFIG.MIN_ORDER_USDT;
}
```

Di dalam `managePositions()`, wrap setiap partial sell dengan check ini:

```ts
// Contoh untuk TP1 — terapkan hal sama untuk TP2:
if (!pos.partial1_taken && profit >= CONFIG.PARTIAL_TP1_PCT) {
  const sellAmt = pos.amount * CONFIG.PARTIAL_TP1_SIZE;

  if (!isAboveMinOrder(sellAmt, price)) {
    // Notional terlalu kecil — skip partial, langsung jual semua
    this.logger.warn({ sellAmt, price, notional: sellAmt * price }, "Partial TP below min order, selling all");
    pos.closing = true;
    const ok = await this.sell(pos, pos.amount, price, "TP1-FULL (min order)");
    if (ok) { toRemove.push(pos); continue; }
    pos.closing = false;
  } else {
    pos.closing = true;
    const ok = await this.sell(pos, sellAmt, price, `TP1 +${(CONFIG.PARTIAL_TP1_PCT * 100).toFixed(0)}%`);
    if (ok) {
      pos.amount -= sellAmt;
      pos.partial1_taken = true;
      pos.trailing_pct = CONFIG.TRAILING_AFTER_TP1;
      if (pos.db_id) await updatePosition(pos.db_id, pos);
    }
    pos.closing = false;
  }
}
```

Tambahkan ke `.env.example`:
```env
MIN_ORDER_USDT=6   # minimum notional value per sell order (Binance ~$5)
```

---

## Fix 4: Race Condition Guard (`core/bot.ts`)

### Masalah
`tick()` dipanggil setiap 30 detik via `setInterval`.
Kalau satu tick lambat (network timeout, retry), tick berikutnya mulai sebelum yang pertama selesai → dua instance `managePositions()` jalan bersamaan → potensi double-sell.

### Solusi
Tambahkan flag `isTicking` di class `Bot`:

```ts
// Tambahkan property di class Bot:
private isTicking = false;
```

Wrap seluruh body `tick()` dengan guard:

```ts
async tick() {
  // Guard: skip jika tick sebelumnya belum selesai
  if (this.isTicking) {
    this.logger.warn("Tick skipped — previous tick still running");
    return;
  }

  this.isTicking = true;

  try {
    // ... seluruh isi tick() yang sudah ada, tidak berubah ...
  } catch (error) {
    this.logger.error({ error }, "Error in tick");
    sendTelegramError(`TICK [${this.symbol}]`, error);
  } finally {
    this.isTicking = false; // selalu release, bahkan jika error
  }
}
```

Catatan: pindahkan `throw error` dari catch ke log saja (seperti contoh di atas) supaya `finally` selalu dieksekusi dan flag pasti di-release.

---

## Ringkasan Semua Fix

| Fix | File yang Diubah | Risiko Tanpa Fix |
|-----|-----------------|------------------|
| Ghost position guard | `core/bot.ts` | Double-sell saat bot unstable |
| Recovery dari DB | `db/init.ts`, `db/trades.ts`, `core/bot.ts` | Semua posisi hilang saat restart |
| Min order size check | `config/index.ts`, `core/bot.ts` | Order reject dari Binance |
| Race condition guard | `core/bot.ts` | Double-sell saat tick lambat |

## Urutan Implementasi yang Disarankan

```
1. Fix 2 (Recovery DB)   — paling kritikal, posisi hilang saat restart
2. Fix 4 (Race condition) — paling mudah, 5 baris
3. Fix 1 (Ghost position) — butuh Fix 4 sudah ada dulu
4. Fix 3 (Min order)      — bisa terakhir, tergantung BUY_USDT kamu
```