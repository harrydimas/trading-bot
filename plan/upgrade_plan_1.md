# Upgrade Plan: Strategy Core v2 → v3
## Partial TP + Trailing Stop + Break-Even

Dokumen ini berisi instruksi perubahan untuk AI lokal.
Jangan ubah file lain selain yang disebutkan di bawah.

---

## File 1: `src/config/index.ts`

### Hapus parameter ini:
```ts
TAKE_PROFIT: Number(env("TAKE_PROFIT", 0.03)),
STOP_LOSS: Number(env("STOP_LOSS", 0.03)),
TP_TIMEOUT_MS: Number(env("TP_TIMEOUT_MS", 600000)),
```

### Ganti dengan parameter baru ini (tambahkan setelah `BUY_USDT`):
```ts
// Partial Take Profit
PARTIAL_TP1_PCT: Number(env("PARTIAL_TP1_PCT", 0.03)),   // trigger profit 3%
PARTIAL_TP1_SIZE: Number(env("PARTIAL_TP1_SIZE", 0.4)),   // jual 40% posisi

PARTIAL_TP2_PCT: Number(env("PARTIAL_TP2_PCT", 0.05)),    // trigger profit 5%
PARTIAL_TP2_SIZE: Number(env("PARTIAL_TP2_SIZE", 0.3)),   // jual 30% posisi

// Trailing Stop (dinamis)
TRAILING_DEFAULT: Number(env("TRAILING_DEFAULT", 0.015)),     // 1.5% sebelum TP apapun
TRAILING_AFTER_TP1: Number(env("TRAILING_AFTER_TP1", 0.008)),// 0.8% setelah TP1
TRAILING_AFTER_TP2: Number(env("TRAILING_AFTER_TP2", 0.005)),// 0.5% setelah TP2

// Break-Even
BREAK_EVEN_ARM_PCT: Number(env("BREAK_EVEN_ARM_PCT", 0.015)),// arm saat profit >= 1.5%
```

---

## File 2: `src/core/bot.ts`

### Perubahan 1: Ganti tipe `pos` dari `any[]` ke interface baru

Tambahkan interface ini di atas class `Bot`:

```ts
interface Position {
  buy_price: number;
  amount: number;            // sisa amount yang masih held (berkurang setelah partial sell)
  created_at: number;
  highest_price: number;     // harga tertinggi sejak entry — untuk trailing
  trailing_pct: number;      // trailing % aktif saat ini (berubah setelah tiap TP)
  partial1_taken: boolean;   // true setelah jual 40% di TP1
  partial2_taken: boolean;   // true setelah jual 30% di TP2
  break_even_armed: boolean; // true setelah profit pernah >= 1.5%
}
```

Ubah deklarasi `pos` di class:
```ts
// sebelum
pos: any[] = [];

// sesudah
pos: Position[] = [];
```

---

### Perubahan 2: Method `recover()`

Ubah struktur object di dalam `.map()`:

```ts
// sebelum
.map(o => ({
  buy_price: o.price,
  amount: o.remaining,
  tp_order_id: o.id,
  created_at: Date.now(),
}));

// sesudah
.map(o => ({
  buy_price: o.price / (1 + CONFIG.PARTIAL_TP1_PCT), // estimasi entry
  amount: o.remaining,
  created_at: Date.now(),
  highest_price: o.price / (1 + CONFIG.PARTIAL_TP1_PCT),
  trailing_pct: CONFIG.TRAILING_DEFAULT,
  partial1_taken: false,
  partial2_taken: false,
  break_even_armed: false,
}));
```

---

### Perubahan 3: Method `buy()`

Ubah object yang di-push ke `this.pos`:

```ts
// sebelum
this.pos.push({
  buy_price: price,
  amount,
  tp_order_id: o.id,
  created_at: Date.now(),
});

// sesudah — hapus createLimitSellOrder, ganti dengan ini:
this.pos.push({
  buy_price: price,
  amount,
  created_at: Date.now(),
  highest_price: price,
  trailing_pct: CONFIG.TRAILING_DEFAULT,
  partial1_taken: false,
  partial2_taken: false,
  break_even_armed: false,
});
```

Juga hapus seluruh blok ini dari `buy()` karena TP sekarang dikelola lewat trailing, bukan limit order:
```ts
// HAPUS blok ini:
const tp = price * (1 + CONFIG.TAKE_PROFIT);
const o = await exchange.createLimitSellOrder(this.symbol, amount, tp);
```

---

### Perubahan 4: Tambah method `sell()` (private helper)

Tambahkan method baru ini di dalam class `Bot`, sebelum method `tick()`:

```ts
private async sell(pos: Position, sellAmount: number, price: number, reason: string): Promise<boolean> {
  try {
    const order = await exchange.createMarketSellOrder(this.symbol, sellAmount);
    const profit = (price - pos.buy_price) * sellAmount;

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
      `P/L: <code>${profit >= 0 ? "+" : ""}${profit.toFixed(2)} USDT</code>`
    );

    return true;
  } catch (error) {
    this.logger.error({ error, reason }, "Sell failed");
    sendTelegramError(`SELL [${this.symbol}] ${reason}`, error);
    return false;
  }
}
```

---

### Perubahan 5: Tambah method `managePositions()` (baru)

Tambahkan method baru ini di dalam class `Bot`, sebelum method `tick()`:

```ts
async managePositions(price: number) {
  const toRemove: Position[] = [];

  for (const pos of this.pos) {
    const profit = (price - pos.buy_price) / pos.buy_price;

    // Update highest price
    if (price > pos.highest_price) {
      pos.highest_price = price;
    }

    // 1. Break-Even Arm
    if (!pos.break_even_armed && profit >= CONFIG.BREAK_EVEN_ARM_PCT) {
      pos.break_even_armed = true;
      this.logger.info({ profit: (profit * 100).toFixed(2) + "%" }, "Break-even armed");
      sendTelegramMessage(
        `🛡️ <b>BREAK-EVEN ARMED</b> ${this.symbol}\n` +
        `Entry: <code>${pos.buy_price}</code> | Now: <code>${price}</code>\n` +
        `Profit: <code>+${(profit * 100).toFixed(2)}%</code>`
      );
    }

    // 2. Break-Even Exit
    if (pos.break_even_armed && price <= pos.buy_price) {
      const ok = await this.sell(pos, pos.amount, price, "BREAK-EVEN");
      if (ok) { toRemove.push(pos); continue; }
    }

    // 3. Partial TP Layer 1 (default 3%)
    if (!pos.partial1_taken && profit >= CONFIG.PARTIAL_TP1_PCT) {
      const sellAmt = pos.amount * CONFIG.PARTIAL_TP1_SIZE;
      const ok = await this.sell(pos, sellAmt, price, `TP1 +${(CONFIG.PARTIAL_TP1_PCT * 100).toFixed(0)}%`);
      if (ok) {
        pos.amount -= sellAmt;
        pos.partial1_taken = true;
        pos.trailing_pct = CONFIG.TRAILING_AFTER_TP1;
      }
    }

    // 4. Partial TP Layer 2 (default 5%)
    if (pos.partial1_taken && !pos.partial2_taken && profit >= CONFIG.PARTIAL_TP2_PCT) {
      const sellAmt = pos.amount * CONFIG.PARTIAL_TP2_SIZE;
      const ok = await this.sell(pos, sellAmt, price, `TP2 +${(CONFIG.PARTIAL_TP2_PCT * 100).toFixed(0)}%`);
      if (ok) {
        pos.amount -= sellAmt;
        pos.partial2_taken = true;
        pos.trailing_pct = CONFIG.TRAILING_AFTER_TP2;
      }
    }

    // 5. Trailing Stop
    const trailingTrigger = pos.highest_price * (1 - pos.trailing_pct);
    if (price <= trailingTrigger) {
      const ok = await this.sell(pos, pos.amount, price, `TRAILING -${(pos.trailing_pct * 100).toFixed(1)}%`);
      if (ok) { toRemove.push(pos); continue; }
    }
  }

  this.pos = this.pos.filter(p => !toRemove.includes(p));
}
```

---

### Perubahan 6: Method `tick()`

Tambahkan satu baris panggilan ke `managePositions` di akhir method `tick()`, setelah update `this.lastPrice`:

```ts
// sebelum (akhir tick):
this.lastPrice = price;

// sesudah:
this.lastPrice = price;

if (this.pos.length > 0) {
  await this.managePositions(price);
}
```

---

### Perubahan 7: Method `handleWS()`

Hapus logika remove position dari `handleWS()` karena posisi sekarang di-manage oleh `managePositions()`. Cukup sisakan logging:

```ts
// sebelum
handleWS(e: any) {
  if (e.e !== "executionReport") return;
  if (e.X === "FILLED") {
    logTrade({ ... });
    const removedCount = this.pos.length;
    const pos = this.pos.find(p => p.tp_order_id === e.i);
    this.pos = this.pos.filter(p => p.tp_order_id !== e.i);
    // ... telegram message
  }
}

// sesudah — sederhanakan jadi hanya logging:
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
```

---

## File 3: `.env.example`

Hapus:
```env
TAKE_PROFIT=0.03
STOP_LOSS=0.03
TP_TIMEOUT_MS=600000
```

Tambahkan:
```env
# Partial Take Profit
PARTIAL_TP1_PCT=0.03        # jual 40% posisi saat profit 3%
PARTIAL_TP1_SIZE=0.4
PARTIAL_TP2_PCT=0.05        # jual 30% posisi saat profit 5%
PARTIAL_TP2_SIZE=0.3

# Trailing Stop
TRAILING_DEFAULT=0.015      # 1.5% sebelum TP apapun
TRAILING_AFTER_TP1=0.008    # 0.8% setelah TP1
TRAILING_AFTER_TP2=0.005    # 0.5% setelah TP2

# Break-Even
BREAK_EVEN_ARM_PCT=0.015    # arm setelah profit 1.5%
```

---

## Ringkasan Perubahan

| File | Aksi |
|------|------|
| `config/index.ts` | Hapus `TAKE_PROFIT`, `STOP_LOSS`, `TP_TIMEOUT_MS` → tambah 8 parameter baru |
| `core/bot.ts` | Tambah `Position` interface, method `sell()`, method `managePositions()`, panggil di `tick()`, sederhanakan `handleWS()` |
| `.env.example` | Sinkronisasi parameter baru |

## Yang Tidak Perlu Diubah

- `src/strategies/aiFilter.ts` — entry filter tetap sama
- `src/services/` — semua service tidak berubah
- `src/db/` — schema database tidak berubah
- `src/exchange/` — client tidak berubah
- `src/main.ts` — entry point tidak berubah