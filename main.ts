// Paced early-entry momentum bot for the pump.fun paper sprint.
//
// Idea: on pump.fun almost every new curve dumps, but a small share runs hard in
// its first minutes. So this bot buys a coin the moment it shows its first real
// buying (a few trades, net inflow, at least half a SOL of real reserves), takes a
// small fixed stake, and then gets out of the way: it banks half the position the
// first time it doubles, cuts the whole thing at -20%, trails a winner 30% off its
// peak, and drops a trade that has not moved up 20% within ~1200 slots. It never
// pyramids into a loser, never chases a coin that already ran, and it paces new
// entries (one per ~2000 slots) so the five open-position slots are never clogged
// by the same burst of launches and the round-trip count stays comfortably above
// the guardrail. It stops opening new trades in the last stretch of the window so
// a late entry cannot be flattened at a loss before it has had time to move.
//
// Everything is a pure function of the batches the harness sends: slot numbers and
// event data only. No clock, no randomness, no I/O, so the two graded executions
// produce byte-identical action logs.

import { LAMPORTS_PER_SOL, runBot, type Batch, type BotState, type BuyInput, type OrderInput, type Pubkey, type SellInput } from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL;

// ---- tunables (lamports unless noted) ---------------------------------------
const STAKE = (SOL * 5n) / 100n; // 0.05 SOL per coin
const MIN_BUY = (SOL * 5n) / 1000n; // 0.005 SOL: smallest buy worth the tx fee
const MIN_REAL_SOL = SOL / 2n; // 0.5 SOL of real reserves before a coin is buyable
const MAX_REAL_SOL = SOL * 200n; // effectively uncapped; a safety rail only
const WINDOW_SLOTS = 5; // lookback for the entry signal
const MIN_WINDOW_TRADES = 3; // need at least this many trades in the window
const MIN_WINDOW_BUYS = 1; // ...of which at least this many buys
const MIN_WINDOW_BUYERS = 1; // ...from at least this many distinct buyers
const ENTRY_GAP_SLOTS = 2000; // at most one new entry per this many slots
const STOP_ENTRY_AFTER_SLOTS = 90000; // stop opening new trades this far into the run
const TAKE_PROFIT_MULT = 2.0; // bank half the position at +100%
const STOP_LOSS_MULT = 0.8; // cut the whole position at -20%
const TRAIL_ARM_MULT = 1.3; // start trailing once up 30%
const TRAIL_DROP = 0.3; // exit on a 30% fall from the best value seen
const MAX_HOLD_SLOTS = 1200; // drop a trade that has not moved by this age
const HOLD_IF_UP_MULT = 1.2; // ...unless it is up at least 20% by then
const COOLDOWN_SLOTS = 600; // ignore a coin this long after an exit
const BUY_SLIPPAGE_BPS = 10_000; // fill even if the price moved in the latency
const SELL_SLIPPAGE_BPS = 10_000;
const MAX_TAPE = 100; // trades kept per coin (bounds memory)

const FEE_BPS = 125n; // 95 protocol + 30 creator, the fallback curve fee
const BPS = 10_000n;

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
  price: number; // virtual quote / virtual token, as a float ratio
}

interface Book {
  ticks: Tick[];
  entered: boolean; // a first buy was decided for this coin (one entry per coin)
  entrySlot: number; // slot the entry was decided on
  entryPrice: number; // price at the entry decision
  peakMult: number; // best liquidation value / cost seen while holding
  soldHalf: boolean; // the +100% half-sale already happened
  coolUntil: number; // slot until which the coin is ignored after an exit
}

const books = new Map<Pubkey, Book>();

function book(mint: Pubkey): Book {
  let b = books.get(mint);
  if (b === undefined) {
    b = { ticks: [], entered: false, entrySlot: -1, entryPrice: 0, peakMult: 0, soldHalf: false, coolUntil: -1 };
    books.set(mint, b);
  }
  return b;
}

/** Price as a float ratio of two u64 reserve strings. */
function priceOf(vq: string, vt: string): number {
  const vtN = Number(vt);
  if (vtN <= 0) return 0;
  return Number(vq) / vtN;
}

/**
 * What selling `tokens` against (vq, vt) would pay, curve fees deducted.
 * Mirrors the harness: q = tokens * vq / (vt + tokens), less 125 bps.
 */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

/** Net SOL a position is worth now, after the sell's tx fee, over its cost. */
function gainMult(cost: bigint, value: bigint, txFee: bigint): number {
  if (cost <= 0n) return 0;
  const net = value - txFee;
  return Number(net) / Number(cost);
}

let firstSlot = -1;
let lastEntrySlot = -1;

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const slot = state.slot;
    const txFee = state.txFeeLamports();
    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;

    // Track the first batch so new entries stop in the last stretch of the run.
    if (firstSlot === -1) firstSlot = slot;
    if (lastEntrySlot === -1) lastEntrySlot = slot - ENTRY_GAP_SLOTS;

    // ---- fold the batch's events into the per-coin tapes --------------------
    const touched: Pubkey[] = [];
    for (const e of batch.events) {
      if (e.event !== 'TradeEvent') continue;
      const b = book(e.mint);
      const price = priceOf(e.virtual_quote_reserves, e.virtual_token_reserves);
      b.ticks.push({ slot: e.slot, isBuy: e.is_buy, sol: BigInt(e.sol_amount), user: e.user, price });
      if (b.ticks.length > MAX_TAPE) b.ticks.splice(0, b.ticks.length - MAX_TAPE);
      if (touched[touched.length - 1] !== e.mint && !touched.includes(e.mint)) touched.push(e.mint);
    }

    // ---- fold the fills: clear exit state when a position is fully gone -----
    for (const f of batch.fills) {
      if (f.client_id.startsWith('_')) continue; // harness closes, not our orders
      const b = books.get(f.mint);
      if (b === undefined) continue;
      if (f.side === 'sell' && f.status === 'filled' && !state.positions.has(f.mint)) {
        b.coolUntil = slot + COOLDOWN_SLOTS;
        b.peakMult = 0;
        b.soldHalf = false;
      }
      if (f.side === 'buy' && f.status === 'filled' && b.entrySlot < 0) {
        b.entrySlot = f.decided_slot;
      }
    }

    const pendingMints = new Set<Pubkey>();
    for (const p of state.pending.values()) pendingMints.add(p.order.mint);

    // Latest reserves per mint, marks first, curves as fallback.
    const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
    for (const m of batch.marks) {
      marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
    }
    const reserves = (mint: Pubkey): { vq: bigint; vt: bigint } | undefined => {
      const mk = marks.get(mint);
      if (mk !== undefined) return mk;
      const cv = state.curves.get(mint);
      if (cv === undefined) return undefined;
      return { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
    };

    // ---- exits: every held position, in mint order (deterministic) ----------
    const held = [...state.positions.keys()].sort();
    for (const mint of held) {
      if (orders.length >= cap) break;
      if (pendingMints.has(mint)) continue;
      const h = state.positions.get(mint)!;
      const b = book(mint);
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const r = reserves(mint);
      if (r === undefined) continue;
      const value = sellValue(h.token_amount, r.vq, r.vt);
      const mult = gainMult(h.cost_lamports, value, txFee);
      if (mult > b.peakMult) b.peakMult = mult;

      let sell: 'all' | 'half' | null = null;
      if (mult <= STOP_LOSS_MULT) {
        sell = 'all';
      } else if (!b.soldHalf && mult >= TAKE_PROFIT_MULT) {
        sell = 'half';
      } else if (b.peakMult >= TRAIL_ARM_MULT && mult < b.peakMult * (1 - TRAIL_DROP)) {
        sell = 'all';
      } else if (b.entrySlot >= 0 && slot - b.entrySlot > MAX_HOLD_SLOTS && mult < HOLD_IF_UP_MULT) {
        sell = 'all';
      }
      if (sell === null) continue;
      const amount = sell === 'half' ? h.token_amount / 2n : h.token_amount;
      if (amount <= 0n) continue;
      const sellOrder: SellInput = { side: 'sell', mint, token_amount: amount, max_slippage_bps: SELL_SLIPPAGE_BPS };
      orders.push(sellOrder);
      if (sell === 'half') b.soldHalf = true;
      pendingMints.add(mint);
    }

    // ---- entries: coins that traded this batch, in event order --------------
    if (slot - firstSlot <= STOP_ENTRY_AFTER_SLOTS) {
      let open = state.committedPositionCount();
      for (const mint of touched) {
        if (orders.length >= cap) break;
        if (slot - lastEntrySlot < ENTRY_GAP_SLOTS) break;
        if (open >= state.hello.caps.max_open_positions) break;
        if (state.positions.has(mint) || pendingMints.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const b = book(mint);
        if (b.entered) continue;
        if (slot < b.coolUntil) continue;
        if (curve.real_quote_reserves < MIN_REAL_SOL || curve.real_quote_reserves > MAX_REAL_SOL) continue;

        // Entry signal: at least 3 trades in the last 5 slots, at least one buy
        // from a distinct buyer, and net buying in the last couple of slots.
        const win = b.ticks.filter((t) => t.slot > slot - WINDOW_SLOTS);
        if (win.length < MIN_WINDOW_TRADES) continue;
        let buys = 0;
        let net = 0n;
        const buyers = new Set<Pubkey>();
        for (const t of win) {
          if (t.isBuy) {
            buys++;
            net += t.sol;
            buyers.add(t.user);
          } else {
            net -= t.sol;
          }
        }
        if (buys < MIN_WINDOW_BUYS || buyers.size < MIN_WINDOW_BUYERS) continue;
        const mid = slot - Math.floor(WINDOW_SLOTS / 2);
        let netNew = 0n;
        for (const t of win) {
          if (t.slot > mid) netNew += t.isBuy ? t.sol : -t.sol;
        }
        if (netNew <= 0n) continue;

        // Size: the fixed stake, capped at 1% of the coin's real SOL reserve.
        const sizeCap = state.maxBuyLamports(mint);
        let amount = STAKE < sizeCap ? STAKE : sizeCap;
        if (amount < MIN_BUY) continue;
        if (state.freeCashLamports() < amount + txFee) continue;
        const buyOrder: BuyInput = { side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS };
        orders.push(buyOrder);
        b.entered = true;
        b.entrySlot = slot;
        b.entryPrice = win[win.length - 1]!.price;
        b.peakMult = 0;
        b.soldHalf = false;
        pendingMints.add(mint);
        lastEntrySlot = slot;
        open++;
      }
    }
    return orders;
  },
});
