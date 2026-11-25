// Pump.fun wallet-overhang & velocity breakout trading bot (agent-fun/replay/v2).

import { runBot } from './vendor/agentfun-bot.ts';
import { createStrategy } from './strategy.ts';

await runBot(createStrategy());
