# Trading Bot

A cryptocurrency trading bot with real-time WebSocket orderbook streams, user stream monitoring, multi-timeframe entry filtering, trailing stop with WebSocket accuracy, partial take profit, break-even protection, slippage control, PostgreSQL logging, and Docker support.

## Features

- ✅ Real-time orderbook monitoring via WebSocket depth streams (bids/asks + mid price)
- ✅ Real-time order updates via WebSocket user stream
- ✅ Multi-timeframe entry filter (15m + 1h price confirmation + orderbook imbalance)
- ✅ Partial Take Profit (TP Layer 1: sell 40% at 3%, TP Layer 2: sell 30% at 5%)
- ✅ Trailing Stop from WebSocket mid price (real-time, not polling)
- ✅ Break-Even Protection (arm at 1.5%, exit if price drops back)
- ✅ Force exit via Max Hold Time (default 24h, configurable)
- ✅ Fee-aware P/L calculation (taker fee 0.1%, configurable)
- ✅ Float drift fix (rounded to 8 decimals)
- ✅ Retry system with exponential backoff
- ✅ Slippage control and protection
- ✅ Risk management (max positions + budget limits)
- ✅ PostgreSQL for trade history and analytics (not source of truth)
- ✅ Recovery from DB on restart
- ✅ Docker support
- ✅ Environment-based configuration
- ✅ Binance exchange support

## Architecture

```
src/
├── config/          # Configuration management
├── core/            # Main bot logic (positions, entry, exit)
├── db/              # PostgreSQL for logging & analytics
├── exchange/        # CCXT Binance client
├── services/        # WebSocket, orderbook, retry, slippage, telegram
├── strategies/      # Multi-timeframe entry filter
└── main.ts          # Application entry point
```

## Setup

### 1. Install Dependencies

```bash
bun install
```

### 2. Configure Environment

Copy `.env.example` to `.env` and update with your Binance API credentials:

```bash
cp .env.example .env
```

Edit `.env` with your values — see the full parameter list below.

### 3. Run with Docker Compose

```bash
docker-compose up -d
```

This will:
- Start PostgreSQL database
- Build and run the trading bot
- Keep both services running

### 4. View Logs

```bash
docker-compose logs -f bot
```

## How It Works

### Entry Strategy (Multi-Timeframe Filter)

The bot uses a multi-timeframe entry filter in `strategies/aiFilter.ts`:

1. **15m Confirmation**: Price must be higher than the price at the start of the current 15-minute interval
2. **1h Confirmation**: Price must be higher than the price at the start of the current 1-hour interval
3. **Orderbook Imbalance**: Bids/Asks ratio > 1.2 (more buying pressure)

Entry is only evaluated once per 15-minute interval. All three conditions must be met to enter.

**Cold-Start Protection:** On restart, the bot waits for one full interval (15m + 1h) before the price cache is considered valid. This prevents false entry signals caused by the current price being compared against itself.

### Position Management

Each position follows a lifecycle:

1. **Entry**: Market buy order (amount = BUY_USDT / price)
2. **Break-Even Arm**: At +1.5% profit, the position is "armed" for break-even protection
3. **Partial TP Layer 1**: At +3% profit, sell 40% of position, tighten trailing to 0.8%
4. **Partial TP Layer 2**: At +5% profit, sell 30% of position (from remaining), tighten trailing to 0.5%
5. **Trailing Stop**: Remaining position follows a trailing stop (real-time via WebSocket mid price)
6. **Break-Even Exit**: If break-even is armed and price falls back to entry, sell remaining
7. **Max Hold Force Exit**: If position exceeds MAX_HOLD_MS (default 24h), force close

### Trailing Stop (WebSocket Accuracy)

The trailing stop updates `highest_price` using the **WebSocket orderbook mid price**, not the 30-second polling ticker. This means:
- Price spikes between ticks are captured in real-time
- Trailing stop is much more accurate than polling-based approaches
- `updateTrailing()` is called every tick using `getMidPrice()` from the orderbook stream

**Fallback:** If the WebSocket mid price is not yet available (e.g. during the first few seconds after startup), the bot falls back to the polling ticker price to ensure `highest_price` is never missed.

### Fee-Aware P/L

All profit calculations subtract the taker fee (default 0.1%):
- `TAKER_FEE=0.001` for standard Binance accounts
- `TAKER_FEE=0.00075` if you have BNB fee discount
- Telegram messages show gross profit, fee amount, and net P/L

### Safety Features

#### Retry System
- Automatic retry with exponential backoff (5 attempts)
- Delay doubles with each retry (1s, 2s, 4s, 8s, 16s)

#### Slippage Control
- Checks orderbook before placing orders
- Rejects orders if estimated slippage > MAX_SLIPPAGE (default 0.2%)
- Protects against unfavorable fills

#### Balance Check
Before every buy attempt, the bot checks your **USDT free balance** via the exchange API. If the balance is insufficient for `BUY_USDT`, the attempt is skipped immediately with a Telegram alert — no failed orders, no retry storms.

#### Risk Management
- **MAX_POSITIONS**: Limits concurrent open positions
- **MAX_BUDGET**: Limits total exposure across all positions
- **MIN_ORDER_USDT**: Minimum notional value per sell order (Binance ~$5)
- **MAX_HOLD_MS**: Forces exit after max hold time (default 24h, 0 = disabled)

### Database Role

PostgreSQL is used for **logging and analytics only**, not as source of truth:

- **Trade History**: Records all buy and sell orders
- **Positions**: Tracks open positions (entry price, amount, trailing state)
- **Audit Logs**: Timestamps, prices, amounts, order IDs
- **Analytics**: Query historical performance data
- **NOT Source of Truth**: Active positions are stored in-memory and recovered from DB on restart

**Database Schema:**

```sql
CREATE TABLE trades (
  id SERIAL PRIMARY KEY,
  symbol TEXT,
  side TEXT,
  price DOUBLE PRECISION,
  amount DOUBLE PRECISION,
  order_id TEXT,
  timestamp BIGINT
);

CREATE INDEX idx_trades_symbol_timestamp
  ON trades (symbol, timestamp DESC);

CREATE TABLE positions (
  id SERIAL PRIMARY KEY,
  symbol TEXT,
  buy_price DOUBLE PRECISION,
  amount DOUBLE PRECISION,
  created_at BIGINT,
  highest_price DOUBLE PRECISION,
  trailing_pct DOUBLE PRECISION,
  partial1_taken BOOLEAN DEFAULT false,
  partial2_taken BOOLEAN DEFAULT false,
  break_even_armed BOOLEAN DEFAULT false,
  closed_at BIGINT DEFAULT NULL
);

CREATE INDEX idx_positions_symbol_open
  ON positions (symbol, closed_at)
  WHERE closed_at IS NULL;
```

### Recovery

On startup, the bot:
- Connects to PostgreSQL
- Loads all open positions from the `positions` table (`WHERE closed_at IS NULL`)
- Resumes monitoring without missing active trades
- DB is source of truth for positions across restarts

The `closed_at` column distinguishes open vs. closed positions, and the partial index `idx_positions_symbol_open` ensures fast recovery queries even as the table grows.

## Manual Usage (Without Docker)

### 1. Start PostgreSQL

```bash
docker run -d \
  --name trading-db \
  -e POSTGRES_USER=trader \
  -e POSTGRES_PASSWORD=traderpass \
  -e POSTGRES_DB=trading \
  -p 5432:5432 \
  postgres:15
```

### 2. Update .env for Local DB

```env
DB_HOST=localhost
DB_PORT=5432
DB_USER=trader
DB_PASSWORD=traderpass
DB_NAME=trading
```

### 3. Run Bot

```bash
bun run src/main.ts
```

## Stopping the Bot

### With Docker Compose

```bash
docker-compose down
```

### Without Docker

Press `Ctrl+C` to stop the bot.

## Telegram Notifications

The bot sends real-time notifications to Telegram for key events:

| Event | Icon | Description |
|-------|------|-------------|
| BOT STARTED | 🟢 | Bot successfully started (config summary) |
| BOT STOPPED | 🔴 | Bot stopped gracefully (SIGTERM / SIGINT) |
| BUY ORDER EXECUTED | ✅ | Market buy order filled |
| POSITION OPENED | ✅ | Position created with entry price |
| BREAK-EVEN ARMED | 🛡️ | Profit reached arm threshold |
| SELL (TP1/TP2) | 🔴 | Partial take profit executed |
| SELL (TRAILING) | 🔴 | Trailing stop triggered |
| SELL (BREAK-EVEN) | 🔴 | Break-even exit |
| SELL (MAX-HOLD) | 🔴 | Force exit due to max hold time |
| ENTRY SIGNAL | 📈 | Entry conditions met |
| INSUFFICIENT BALANCE | ⚠️ | USDT balance too low for buy |
| Error | ⚠️ | Any error (WS, DB, order, etc.) |

## Health Check Endpoint

The bot exposes a JSON health endpoint on port `3000`:

```bash
curl http://localhost:3000/health
```

**Example response:**
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

| Field | Meaning |
|-------|---------|
| `status` | `ok` if last tick < 3× `CHECK_INTERVAL`, otherwise `stale` |
| `last_tick_age_ms` | Time since the last successful tick loop |
| `ws_connected` | Whether the WebSocket user stream is connected |
| `open_positions` | Number of currently open positions |

The Docker Compose file includes a built-in `healthcheck` that queries this endpoint every 60 seconds.

## Configuration Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `BUY_USDT` | 10 | USDT amount per trade |
| `PARTIAL_TP1_PCT` | 0.03 | TP1 trigger at 3% profit (sell 40%) |
| `PARTIAL_TP1_SIZE` | 0.4 | Portion to sell at TP1 |
| `PARTIAL_TP2_PCT` | 0.05 | TP2 trigger at 5% profit (sell 30%) |
| `PARTIAL_TP2_SIZE` | 0.3 | Portion to sell at TP2 (from remaining) |
| `TRAILING_DEFAULT` | 0.015 | Initial trailing stop at 1.5% |
| `TRAILING_AFTER_TP1` | 0.008 | Tightened trailing to 0.8% after TP1 |
| `TRAILING_AFTER_TP2` | 0.005 | Tightest trailing at 0.5% after TP2 |
| `BREAK_EVEN_ARM_PCT` | 0.015 | Arm break-even at 1.5% profit |
| `MAX_POSITIONS` | 5 | Maximum concurrent positions |
| `MAX_BUDGET` | 100 | Maximum total exposure (USDT) |
| `MAX_SLIPPAGE` | 0.002 | Maximum allowed slippage (0.2%) |
| `MIN_ORDER_USDT` | 6 | Minimum notional value per sell order |
| `TAKER_FEE` | 0.001 | Taker fee rate (0.1%). 0.00075 with BNB discount |
| `MAX_HOLD_MS` | 86400000 | Max hold time (24h). 0 = disabled |
| `CHECK_INTERVAL` | 30000 | Check interval in milliseconds (30 sec) |

## Important Notes

⚠️ **Trading Risk Warning**: This bot is for educational purposes. Cryptocurrency trading involves significant risk. Always:
- Test with small amounts first
- Use testnet when available
- Never trade with funds you can't afford to lose
- Monitor the bot's activity closely

🔐 **Security**:
- Never commit `.env` file to version control
- Use Binance API keys with restricted permissions (trading only, no withdrawal)
- Enable IP restrictions on your API keys
- Consider using a read-only API key for monitoring

## Troubleshooting

### Bot won't start
- Check API credentials in `.env`
- Verify PostgreSQL is running: `docker ps`
- Check logs: `docker-compose logs bot`

### No trades executing
- Verify you have sufficient balance (check Telegram / logs for "Insufficient USDT balance")
- Check orderbook WebSocket is connected
- Review logs for filter conditions (need 15m + 1h cache built up — wait one full interval after restart)
- Adjust `PARTIAL_TP1_PCT` / `PARTIAL_TP2_PCT` thresholds
- Check if `MAX_POSITIONS` or `MAX_BUDGET` limits are reached

### WebSocket connection issues
- Check internet connectivity
- Verify Binance API is operational
- Review firewall settings

### High slippage warnings
- Reduce `MAX_SLIPPAGE` threshold
- Check market volatility
- Consider trading during high liquidity hours

### Database issues
- Check PostgreSQL is running: `docker ps`
- Verify DB credentials in `.env`
- Check database logs: `docker-compose logs db`

### Positions not closing
- Check trailing stop percentage (may be too tight/loose)
- Verify WebSocket is connected (trailing depends on mid price updates)
- Check if `MAX_HOLD_MS` is set to 0 (disabled)

## License

MIT
