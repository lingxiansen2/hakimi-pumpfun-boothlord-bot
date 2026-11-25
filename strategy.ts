// Pure on-chain microstructure strategy for Pump.fun bonding curves (agent-fun/replay/v2).
// Tracks per-wallet token inventory, cost basis, and early-sniper overhang exhaustion
// to capture high-velocity breakouts on clean, creator-free curves.

import { BPS, type Batch, type Bot, type BotState, type Mark, type OrderInput, type Pubkey } from './vendor/agentfun-bot.ts';

const LAMPORTS = 1_000_000_000;
const FEE_BPS = 125n;

interface TradeTick {
  slot: number;
  isBuy: boolean;
  sol: number;
  user: Pubkey;
  price: number;
}

interface CoinBook {
  creator: Pubkey;
  createSlot: number;
  complete: boolean;
  balances: Map<Pubkey, number>;
  costs: Map<Pubkey, number>;
  snipers: Set<Pubkey>;
  ticks: TradeTick[];
  coolUntil: number;
}

interface PositionState {
  entrySlot: number;
  lastAddPrice: number;
  peakValue: number;
  targetSol: number;
  exiting: boolean;
}

export interface StrategyConfig {
  minAge: number;
  maxAge: number;
  sniperAgeSlots: number;
  minRqSol: number;
  maxRqSol: number;
  maxCreatorShare: number;
  maxTop1Share: number;
  maxTop3Share: number;
  maxSniperRem: number;
  maxAvgGain: number;
  minFreshBuyers: number;
  minNetFlow20: number;
  stopLoss: number;
  trailArm1: number;
  trailDrop1: number;
  trailArm2: number;
  trailDrop2: number;
  flatHoldSlots: number;
  flatMinGain: number;
  maxHoldSlots: number;
  cooldownSlots: number;
  stakeFrac: number;
  maxStakeSol: number;
  capShare: number;
  addMinValRatio: number;
  addMinPriceRatio: number;
  buySlippageBps: number;
  sellSlippageBps: number;
}

export const DEFAULT_CONFIG: StrategyConfig = {
  minAge: 8,
  maxAge: 320,
  sniperAgeSlots: 3,
  minRqSol: 10,
  maxRqSol: 72,
  maxCreatorShare: 0.005,
  maxTop1Share: 0.16,
  maxTop3Share: 0.42,
  maxSniperRem: 0.22,
  maxAvgGain: 1.50,
  minFreshBuyers: 5,
  minNetFlow20: 1.0,
  stopLoss: 0.20,
  trailArm1: 0.36,
  trailDrop1: 0.17,
  trailArm2: 0.90,
  trailDrop2: 0.15,
  flatHoldSlots: 220,
  flatMinGain: 0.05,
  maxHoldSlots: 1200,
  cooldownSlots: 80,
  stakeFrac: 0.40,
  maxStakeSol: 24.0,
  capShare: 0.98,
  addMinValRatio: 0.98,
  addMinPriceRatio: 0.96,
  buySlippageBps: 800,
  sellSlippageBps: 3500,
};

function sellProceedsLamports(mark: Mark | undefined, tokens: bigint): bigint {
  if (mark === undefined || tokens <= 0n) return 0n;
  const vq = BigInt(mark.virtual_quote_reserves);
  const vt = BigInt(mark.virtual_token_reserves);
  const rq = BigInt(mark.real_quote_reserves);
  if (vt + tokens === 0n) return 0n;
  let q = (tokens * vq) / (vt + tokens);
  if (q > rq) q = rq;
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(cfg: StrategyConfig = DEFAULT_CONFIG): Bot {
  const books = new Map<Pubkey, CoinBook>();
  const held = new Map<Pubkey, PositionState>();

  const scoreCandidate = (b: CoinBook, now: number, rqSol: number, price: number): number | null => {
    const age = now - b.createSlot;
    if (age < cfg.minAge || age > cfg.maxAge) return null;
    if (rqSol < cfg.minRqSol || rqSol > cfg.maxRqSol) return null;

    let totalHeld = 0;
    let totalCost = 0;
    let top1 = 0;
    let top2 = 0;
    let top3 = 0;
    let sniperTokens = 0;
    for (const [u, bal] of b.balances) {
      totalHeld += bal;
      totalCost += b.costs.get(u) ?? 0;
      if (b.snipers.has(u)) sniperTokens += bal;
      if (bal > top1) { top3 = top2; top2 = top1; top1 = bal; }
      else if (bal > top2) { top3 = top2; top2 = bal; }
      else if (bal > top3) top3 = bal;
    }
    if (totalHeld <= 0 || totalCost <= 0) return null;

    const creatorShare = (b.balances.get(b.creator) ?? 0) / totalHeld;
    if (creatorShare > cfg.maxCreatorShare) return null;
    if (top1 / totalHeld > cfg.maxTop1Share || (top1 + top2 + top3) / totalHeld > cfg.maxTop3Share) return null;

    const sniperRem = sniperTokens / totalHeld;
    if (sniperRem > cfg.maxSniperRem) return null;

    const avgEntryPrice = (totalCost * LAMPORTS) / totalHeld;
    if (price / avgEntryPrice > cfg.maxAvgGain) return null;

    let net20 = 0;
    const recentBuyers = new Set<Pubkey>();
    const priorBuyers = new Set<Pubkey>();
    for (let i = b.ticks.length - 1; i >= 0; i--) {
      const t = b.ticks[i]!;
      if (now - t.slot <= 20) {
        net20 += t.isBuy ? t.sol : -t.sol;
        if (t.isBuy) recentBuyers.add(t.user);
      } else if (t.isBuy) {
        priorBuyers.add(t.user);
      }
    }
    let freshBuyers = 0;
    for (const u of recentBuyers) if (!priorBuyers.has(u)) freshBuyers++;
    if (freshBuyers < cfg.minFreshBuyers || net20 < cfg.minNetFlow20) return null;

    return freshBuyers + net20 + (1 - sniperRem) * 8;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const touched = new Set<Pubkey>();

      for (const f of batch.fills) {
        const ps = held.get(f.mint);
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          continue;
        }
        if (ps !== undefined && f.side === 'sell') {
          ps.exiting = false;
          if (!state.positions.has(f.mint)) {
            held.delete(f.mint);
            const b = books.get(f.mint);
            if (b !== undefined) b.coolUntil = now + cfg.cooldownSlots;
          }
        }
      }

      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          books.set(e.mint, {
            creator: e.creator,
            createSlot: e.slot,
            complete: false,
            balances: new Map(),
            costs: new Map(),
            snipers: new Set(),
            ticks: [],
            coolUntil: -1,
          });
        } else if (e.event === 'TradeEvent') {
          const b = books.get(e.mint);
          if (b === undefined) continue;
          const sol = Number(e.sol_amount) / LAMPORTS;
          const tokens = Number(e.token_amount);
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          if (e.is_buy && e.slot - b.createSlot <= cfg.sniperAgeSlots) {
            b.snipers.add(e.user);
          }
          const prevBal = b.balances.get(e.user) ?? 0;
          const prevCost = b.costs.get(e.user) ?? 0;
          if (e.is_buy) {
            b.balances.set(e.user, prevBal + tokens);
            b.costs.set(e.user, prevCost + sol);
          } else {
            const nextBal = prevBal - tokens;
            if (nextBal <= 1) {
              b.balances.delete(e.user);
              b.costs.delete(e.user);
            } else {
              b.costs.set(e.user, prevCost * (nextBal / prevBal));
              b.balances.set(e.user, nextBal);
            }
          }
          b.ticks.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user, price });
          if (b.ticks.length > 250) b.ticks.splice(0, b.ticks.length - 250);
          touched.add(e.mint);
        } else {
          const b = books.get(e.mint);
          if (b !== undefined) b.complete = true;
        }
      }

      const pendingBuy = new Set<Pubkey>();
      const pendingSell = new Set<Pubkey>();
      const pendingBuySol = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        if (po.order.side === 'buy') {
          pendingBuy.add(po.order.mint);
          pendingBuySol.set(po.order.mint, (pendingBuySol.get(po.order.mint) ?? 0) + Number(po.order.quote_lamports) / LAMPORTS);
        } else {
          pendingSell.add(po.order.mint);
        }
      }
      for (const [mint] of [...held]) {
        if (!state.positions.has(mint) && !pendingBuy.has(mint) && !pendingSell.has(mint)) {
          held.delete(mint);
        }
      }

      const marks = new Map<Pubkey, Mark>();
      for (const m of batch.marks) marks.set(m.mint, m);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const txFee = state.txFeeLamports();
      const txSol = Number(txFee) / LAMPORTS;

      // 1. Exits on held positions
      for (const mint of [...state.positions.keys()].sort()) {
        if (orders.length >= cap) break;
        const pos = state.positions.get(mint)!;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const ps = held.get(mint);
        if (ps === undefined || ps.exiting || pendingSell.has(mint)) continue;

        const valSol = Number(sellProceedsLamports(marks.get(mint), pos.token_amount)) / LAMPORTS - txSol;
        const costSol = Number(pos.cost_lamports) / LAMPORTS;
        if (valSol > ps.peakValue) ps.peakValue = valSol;

        const ageHeld = now - ps.entrySlot;
        const slHit = costSol > 0 && valSol <= costSol * (1 - cfg.stopLoss);
        const drop = costSol > 0 && ps.peakValue >= costSol * (1 + cfg.trailArm2) ? cfg.trailDrop2 : cfg.trailDrop1;
        const trailHit = costSol > 0 && ps.peakValue >= costSol * (1 + cfg.trailArm1) && valSol <= ps.peakValue * (1 - drop);
        const flatHit = ageHeld >= cfg.flatHoldSlots && costSol > 0 && valSol < costSol * (1 + cfg.flatMinGain);
        const maxHit = ageHeld >= cfg.maxHoldSlots;

        if (slHit || trailHit || flatHit || maxHit) {
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: cfg.sellSlippageBps });
          ps.exiting = true;
          pendingSell.add(mint);
        }
      }

      // 2. Scale-ins on confirmed winners & new entries
      let freeSol = Number(state.freeCashLamports() - txFee * BigInt(orders.length)) / LAMPORTS;
      let equitySol = freeSol;
      for (const [mint, pos] of state.positions) {
        equitySol += Number(sellProceedsLamports(marks.get(mint), pos.token_amount)) / LAMPORTS;
      }
      for (const s of pendingBuySol.values()) equitySol += s;

      for (const [mint, ps] of held) {
        if (orders.length >= cap) break;
        if (ps.exiting || pendingSell.has(mint)) continue;
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined || curve === undefined || curve.complete) continue;

        const committed = Number(pos.cost_lamports) / LAMPORTS + (pendingBuySol.get(mint) ?? 0);
        if (committed >= ps.targetSol - 0.02) continue;

        const valSol = Number(sellProceedsLamports(marks.get(mint), pos.token_amount)) / LAMPORTS;
        const costSol = Number(pos.cost_lamports) / LAMPORTS;
        if (valSol < costSol * cfg.addMinValRatio) continue;

        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        if (price < ps.lastAddPrice * cfg.addMinPriceRatio) continue;

        const maxBuySol = Math.floor(Number(state.maxBuyLamports(mint)) * cfg.capShare) / LAMPORTS;
        const spendSol = Math.min(maxBuySol, ps.targetSol - committed, freeSol - txSol * 2);
        if (spendSol < 0.05) continue;

        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(spendSol * LAMPORTS)), max_slippage_bps: cfg.buySlippageBps });
        ps.lastAddPrice = price;
        freeSol -= spendSol + txSol;
      }

      let openSlots = state.hello.caps.max_open_positions - state.committedPositionCount();
      if (openSlots > 0 && freeSol > 0.15) {
        const candidates: { mint: Pubkey; score: number; price: number }[] = [];
        for (const mint of touched) {
          if (held.has(mint) || state.positions.has(mint) || pendingBuy.has(mint)) continue;
          const b = books.get(mint);
          const curve = state.curves.get(mint);
          if (b === undefined || curve === undefined || curve.complete || b.complete || now < b.coolUntil) continue;
          const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
          const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
          const score = scoreCandidate(b, now, rqSol, price);
          if (score !== null) candidates.push({ mint, score, price });
        }
        candidates.sort((a, b) => b.score - a.score);

        for (const cand of candidates) {
          if (orders.length >= cap || openSlots <= 0) break;
          const targetSol = Math.min(cfg.maxStakeSol, Math.max(0.4, equitySol * cfg.stakeFrac));
          const maxBuySol = Math.floor(Number(state.maxBuyLamports(cand.mint)) * cfg.capShare) / LAMPORTS;
          const spendSol = Math.min(maxBuySol, targetSol, freeSol - txSol * 2);
          if (spendSol < 0.05) continue;
          orders.push({
            side: 'buy',
            mint: cand.mint,
            quote_lamports: BigInt(Math.floor(spendSol * LAMPORTS)),
            max_slippage_bps: cfg.buySlippageBps,
          });
          held.set(cand.mint, {
            entrySlot: now,
            lastAddPrice: cand.price,
            peakValue: 0,
            targetSol,
            exiting: false,
          });
          freeSol -= spendSol + txSol;
          openSlots--;
          pendingBuy.add(cand.mint);
        }
      }

      return orders;
    },
  };
}
