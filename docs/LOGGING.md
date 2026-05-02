# Logging System Documentation

## Overview

The trading bot uses **Pino** as its logging library, which provides high-performance, structured logging with JSON output. In development mode, logs are pretty-printed using **pino-pretty** for better readability.

## Configuration

### Environment Variables

Add the following to your `.env` file:

```bash
# Logging level (options: trace, debug, info, warn, error, fatal, silent)
LOG_LEVEL=info
```

### Log Levels

- **trace**: Very detailed logging, typically for debugging complex issues
- **debug**: Detailed information for debugging
- **info**: General informational messages (default)
- **warn**: Warning messages for potentially harmful situations
- **error**: Error messages for error events
- **fatal**: Critical error messages that may cause the application to fail
- **silent**: No logging output

## Logger Usage

### Creating a Logger

```typescript
import { logger } from "./utils/logger/logger";
import { createChildLogger } from "./utils/logger/logger";

// Use the main logger
logger.info("Application started");

// Create a child logger with context
const botLogger = createChildLogger("Bot:BTC/USDT");
botLogger.info("Bot initialized");
```

### Logging Methods

```typescript
// Debug level - detailed information
logger.debug({ symbol: "BTC/USDT", price: 50000 }, "Price update");

// Info level - general information
logger.info({ orderId: "12345" }, "Order executed");

// Warn level - warning messages
logger.warn({ symbol: "BTC/USDT" }, "WebSocket connection lost, reconnecting...");

// Error level - error messages
logger.error({ error: err, symbol: "BTC/USDT" }, "Failed to execute order");
```

## Log Context

Each log entry includes structured data:

- **context**: The module or component name (e.g., "Bot:BTC/USDT", "UserWS", "Database")
- **timestamp**: ISO 8601 timestamp
- **level**: Log level
- **msg**: Log message
- **Additional fields**: Any data passed in the first parameter

## Current Logging Points

### Main Application (`src/main.ts`)
- Application startup
- Database initialization
- WebSocket connections
- Position recovery
- Trading loop heartbeat
- Error handling

### Bot Core (`src/core/bot.ts`)
- Position recovery
- Buy order execution
- Take profit order creation
- WebSocket order fills
- Hourly checks
- Entry condition evaluation

### Services

#### User WebSocket (`src/services/ws.ts`)
- Connection events
- Authentication
- Message reception
- Connection errors
- Reconnection attempts

#### Orderbook WebSocket (`src/services/orderbookWS.ts`)
- Stream initialization
- Connection events
- Orderbook updates
- Connection errors

#### Retry Service (`src/services/retry.ts`)
- Retry attempts
- Delays between retries
- Exhausted retries

#### Slippage Service (`src/services/slippage.ts`)
- Slippage calculations
- Threshold comparisons
- Check results

### Database (`src/db/`)
- Schema initialization
- Trade logging
- Query errors

### Exchange Client (`src/exchange/client.ts`)
- API calls
- API responses
- API errors

### Strategies (`src/strategies/aiFilter.ts`)
- Entry condition checks
- Ratio calculations
- Momentum checks

## Log Output Examples

### Development Mode (Pretty-printed)

```
[2024-01-01 12:00:00.000] INFO (Bot:BTC/USDT): Executing buy order
    price: 50000
    amount: 0.0002
    exposure: 100
```

### Production Mode (JSON)

```json
{
  "level": 30,
  "time": 1704105600000,
  "context": "Bot:BTC/USDT",
  "price": 50000,
  "amount": 0.0002,
  "exposure": 100,
  "msg": "Executing buy order"
}
```

## Best Practices

1. **Use appropriate log levels**: Don't log everything at `info` level. Use `debug` for detailed information and `error` for failures.

2. **Include relevant context**: Always include relevant data in the log object (e.g., symbol, orderId, price).

3. **Use child loggers**: Create child loggers with context for better log filtering and organization.

4. **Log errors properly**: Always include the error object when logging errors.

5. **Don't log sensitive data**: Avoid logging API keys, secrets, or sensitive user data.

6. **Be consistent**: Use consistent message formats and field names across the application.

## Troubleshooting

### No logs appearing

1. Check that `LOG_LEVEL` is set correctly in your `.env` file
2. Ensure the logger is imported and used correctly
3. Verify that the application is running

### Too many logs

1. Increase the `LOG_LEVEL` to `warn` or `error` to reduce verbosity
2. Check if debug logs are being generated and adjust accordingly

### Logs not in production

1. Verify that `NODE_ENV=production` is set
2. Check that logs are being written to the correct output stream
3. Ensure logging infrastructure is configured correctly

## Performance Considerations

Pino is designed for high performance with minimal overhead:
- Logs are written asynchronously
- String interpolation is avoided (use objects instead)
- No stack trace generation unless needed
- Minimal memory allocation

For optimal performance:
- Avoid logging in tight loops
- Use appropriate log levels
- Keep log messages concise