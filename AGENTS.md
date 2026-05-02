# 🤖 AGENTS.md — Trading Bot

This file helps AI coding agents understand the project's architecture, conventions, and boundaries. Read this before making changes.

---

## 🎯 Project Overview

A **real-time cryptocurrency trading bot** for Binance spot, built with **Bun + TypeScript**. It monitors orderbook depth streams and user data WebSockets, evaluates entry signals using multi-timeframe filtering + orderbook imbalance, and manages positions with partial take-profit layers, trailing stops, and break-even protection.

**Key principles:**
- Exchange is **source of truth** for active positions
- PostgreSQL is **logging/analytics only**, not source of truth
- Positions persist across restarts via DB (`positions` table)
- Telegram notifications for all major events

---

## 🏗️ Architecture

```
src/
├── config/index.ts          # Env-based configuration (CONFIG object)
├── core/bot.ts              # Main bot logic — Bot class (entry, trailing, exits)
├── db/
│   ├── index.ts             # pg Pool singleton
│   ├── init.ts              # Schema creation + migrations
│   └── trades.ts            # CRUD helpers: logTrade, savePosition, closePosition, etc.
├── exchange/client.ts       # CCXT Binance client (Proxy-wrapped with logging)
├── main.ts                  # Entry point — wires everything, runs trading loop
├── services/
│   ├── health.ts            # Shared health state object
│   ├── orderbookWS.ts       # Orderbook depth WebSocket (per-symbol)
│   ├── ws.ts                # User data WebSocket (Binance WebSocket API v3)
│   ├── telegram.ts          # Telegram bot (Telegraf) — notifications + commands
│   ├── retry.ts             # Exponential backoff retry utility
│   └── slippage.ts          # Slippage check against orderbook
├── strategies/
│   └── aiFilter.ts          # Multi-timeframe entry filter (15m + 1h + orderbook)
└── utils/logger/logger.ts   # Pino logger setup
```

---

## ⚙️ Tech Stack

| Layer | Choice | Notes |
|-------|--------|-------|
| Runtime | **Bun** | Runs TypeScript natively, no build step |
| Exchange | **CCXT** (`ccxt.binance`) | Proxy-wrapped in `exchange/client.ts` for logging |
| WebSocket | `ws` npm package | Direct Binance streams (not via CCXT) |
| Database | **PostgreSQL** via `pg` | Pool-based connections |
| Telegram | **Telegraf** | Bot commands: `/start`, `/stop`, `/status`, `/health` |
| Logging | **Pino** | Structured JSON, pretty-printed in dev |
| Container | **Docker** | Multi-service compose (bot + db) |

---

## 📁 Key Files Reference

### `src/config/index.ts`
- Reads all config from environment variables via `dotenv`
- Exports a single `CONFIG` object — **always use `CONFIG.X`**, never `process.env.X` directly
- Add new config keys here with sensible defaults

### `src/core/bot.ts`
- **Bot class** — one instance per symbol
- Key methods:
  - `tick()` — called every `CHECK_INTERVAL` ms
  - `buy(price)` — market buy + create limit TP order
  - `managePositions(price)` — evaluates trailing, break-even, partial TPs, max-hold exit
  - `recover()` — loads open positions from DB on startup
  - `handleWS(e)` — processes WebSocket execution reports
- `isTicking` guard prevents overlapping ticks
- Uses `getMidPrice()` from orderbook WS for trailing (real-time), falls back to REST

### `src/services/telegram.ts`
- Telegram bot initialized at module scope
- Chat IDs persisted to `data/telegram-chats.json` (survives Docker restarts via named volume)
- Bot commands: `/start` (subscribe), `/stop` (unsubscribe), `/status`, `/health`
- `sendTelegramMessage()` broadcasts to **all** subscribed chat IDs
- `sendTelegramError()` for error alerts (HTML-escaped)

### `src/strategies/aiFilter.ts`
- Entry filter: **15m price > previous 15m close** AND **1h price > previous 1h close** AND **bids/asks ratio > 1.2**
- Price cache initialized from historical klines on startup (`initPriceCache`)
- `updatePriceCache()` called every tick — snapshots at interval boundaries

### `src/db/trades.ts`
- Position CRUD: `savePosition`, `updatePosition`, `closePosition`, `loadOpenPositions`
- Trade logging: `logTrade`
- DB is **not** source of truth — positions are in-memory, recovered from DB on restart

### `src/exchange/client.ts`
- CCXT exchange wrapped in a **Proxy** for automatic method-level logging
- `fetchPrice(symbol, timeoutMs)` — fast price fetch with race-based timeout
- `getUSDTBalance()` — free USDT balance check

### `src/services/health.ts`
- Singleton `healthState` object shared across modules
- Tracks: `startedAt`, `lastTickAt`, `wsConnected`, `openPositions`
- Updated by `bot.ts` (tick), `orderbookWS.ts`, `ws.ts`

---

## 🧪 Coding Conventions

### TypeScript
- **`module: "Preserve"`** + **`moduleResolution: "bundler"`** (Bun-native)
- **`verbatimModuleSyntax: true`** — use `import type` for type-only imports
- **`noUncheckedIndexedAccess: true`** — always handle `undefined` for indexed access
- No `noEmit: true` — Bun runs TS directly
- Types in `bun` global types, not `@types/node`

### Module pattern
- Services initialize at **module scope** (e.g., Telegram bot, WebSocket connections)
- Exported functions use the module-scoped instances
- No DI containers — simple module-level singletons

### Error handling
- All async operations wrapped in try/catch
- Errors logged with `logger.error({ error, context }, "message")`
- Critical errors sent via `sendTelegramError()`
- `retry()` utility for transient failures (exponential backoff, 5 attempts)

### Logging
- Use `createChildLogger("Context")` for each module
- First argument is always a structured data object, second is message string
- Levels: `debug` for tick-level detail, `info` for state changes, `warn` for recoverable issues, `error` for failures

### Async patterns
- `main.ts` trading loop uses `while(true)` with `await new Promise(r => setTimeout(r, N))`
- Bot ticks use `Promise.race` with 15s timeout to prevent stuck loops
- WebSocket reconnections use `setTimeout(() => startX(), 5000)`
- DB init uses exponential backoff `waitForDB()`

---

## 🐳 Docker

- **Dockerfile**: `oven/bun:1` image, copies everything, runs `bun run src/main.ts`
- **docker-compose.yml**: `bot` service + `db` service (PostgreSQL 15)
- Named volume `bot-data` mounted at `/app/data` for persistence (Telegram chat IDs)
- Health check: HTTP GET `:3000/health` every 60s

---

## 🚀 Running

```bash
# Development (without Docker)
bun run src/main.ts

# Production (Docker)
docker compose up -d --build

# View logs
docker compose logs -f bot

# Restart after changes
docker compose up --build -d bot
```

---

## 🔧 Configuration

All config via `.env` file (see `.env.example` for template). Key parameters:

| Variable | Default | Description |
|----------|---------|-------------|
| `BUY_USDT` | 10 | USDT per trade entry |
| `CHECK_INTERVAL` | 30000 | Main loop interval in ms |
| `PARTIAL_TP1_PCT` | 0.03 | TP1 at 3% (sell 40%) |
| `PARTIAL_TP2_PCT` | 0.05 | TP2 at 5% (sell 30%) |
| `TRAILING_DEFAULT` | 0.015 | Initial trailing stop 1.5% |
| `BREAK_EVEN_ARM_PCT` | 0.015 | Arm break-even at 1.5% |
| `MAX_HOLD_MS` | 86400000 | Force exit after 24h (0 = disabled) |
| `MAX_POSITIONS` | 5 | Max concurrent positions |
| `MAX_BUDGET` | 100 | Max total exposure USDT |
| `TELEGRAM_BOT_TOKEN` | — | Bot token from @BotFather |
| `LOG_LEVEL` | info | Pino log level |

Add new config keys to `src/config/index.ts` with `env("KEY", defaultValue)` pattern, then document in `.env.example` and README.

---

## 🌿 Git Workflow

- **Branch from `main`**: `git checkout -b feat/your-feature main`
- **Commit style**: conventional commits (`feat:`, `fix:`, `refactor:`, etc.)
- **PRs**: Created via `gh pr create` or GitHub API, base = `main`
- **`.env` is in `.gitignore`** — never commit secrets
- **`data/*.json` is in `.gitignore`** — runtime data, not source

---

## ⚠️ Common Pitfalls

1. **Race condition on tick**: Bot has `isTicking` guard — don't remove it
2. **Price source priority**: Always prefer `getMidPrice()` (WS) over REST `fetchPrice()` for trailing
3. **Ghost positions**: `closing` flag on Position prevents double-sell — don't bypass
4. **DB as log, not source**: Active positions are in-memory; DB recovery is a fallback on restart
5. **Telegram init at module scope**: Bot starts on import; if token is missing, module degrades gracefully
6. **Slippage check before buy**: `checkSlippage()` returns false if no orderbook data — entry won't happen until WS connects
7. **Cold-start protection**: `aiFilter.ts` waits one full 15m + 1h interval before allowing entry (cache not ready)
8. **Docker volume**: `telegram-chats.json` lives in `/app/data/` (named volume); without the volume, chat IDs are lost on container recreate
9. **No concurrent buys per symbol**: `MAX_POSITIONS` + `getExposure()` guard; `MAX_BUDGET` is total across all symbols
10. **WebSocket reconnection**: Both orderbook and user WS auto-reconnect after 5s delay on close — don't add duplicate reconnection logic

---

## 🔍 Debugging Tips

- Set `LOG_LEVEL=debug` in `.env` for full tick-level visibility
- Check `docker compose logs bot` for WebSocket connection status
- Hit `http://localhost:3000/health` for bot status JSON
- Telegram `/status` and `/health` commands work while bot is running
- If bot enters no trades after restart, check logs for "Price cache not ready" — wait one full interval
