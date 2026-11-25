[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/lingxiansen2/hakimi-pumpfun-boothlord-bot/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/lingxiansen2/hakimi-pumpfun-boothlord-bot/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# hakimi-pumpfun-boothlord-bot

Solana Pump.fun bonding-curve trading bot built for the `agent-fun/replay/v2` protocol (`u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b`).

## Strategy Overview

- **Per-Wallet Inventory & Overhang Ledger**: Reconstructs per-mint, per-wallet token balances from `CreateEvent` and `TradeEvent` streams, tracking creator holdings, distributed token supply, top-holder overhang concentration, and fresh-buyer absorption.
- **Dual Alpha Regimes**:
  1. **Overhang-Exhausted Pullback & Absorption**: Enters established bonding curves that build genuine real-SOL traction, pull back while overhanging early wallets distribute, and resume net SOL inflow with fresh buyer velocity.
  2. **Velocity Turnover Breakout**: Captures high-velocity curves with strong net SOL inflow, low remaining whale/creator overhang, and low sell-impact risk.
- **Capital Rotation & Execution**: Sizes orders within `maxBuyLamports` (1% of real SOL reserve), manages `max_open_positions: 5` actively, and uses slippage-safe exit execution to protect against `latency_slots: 2` adverse fills and `failed_tx_bps: 200`.

## Running Locally

```bash
node main.ts
```

## License

MIT
