// Health state shared between modules
export const healthState = {
  startedAt: Date.now(),
  lastTickAt: 0,
  wsConnected: false,
  userWsConnected: false,
  orderbookWsConnected: false,
  openPositions: 0,
};