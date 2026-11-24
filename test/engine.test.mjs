import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMarket, MarketError } from '../src/engine/market.js';
import { computeSettlement, solveAllocation, cheapestProcurement, supplyIndexFor, NodeBudget, SolveTimeout } from '../src/engine/solver.js';
import { explainQuote, compareSupply } from '../src/engine/explain.js';
import { bruteForceVerification } from '../src/engine/verify.js';
import {
  createRoundState,
  startClearing,
  requestWithdrawal,
  requestSupplyChange,
  nextRound,
  adoptSupplyAsNextRound,
  addBuyQuote,
  addSellQuote,
} from '../src/engine/rounds.js';
import { getScenario, SUPPLY_SHOCK } from '../src/data/scenarios.js';
import { demandOfBuyQuotes } from '../src/engine/market.js';

function baseMarket() {
  return buildMarket(getScenario('base').market);
}

test('base scenario allocation is welfare-optimal and independently verified', () => {
  const scenario = getScenario('base');
  const market = buildMarket(scenario.market);
  const result = computeSettlement(market, { nodeLimit: scenario.nodeLimit });
  assert.equal(result.status, 'ok');
  const brute = bruteForceVerification(scenario.market, { subsetLimit: 1 << 12 });
  assert.equal(result.main.welfare, brute.bestWelfare);
  assert.deepEqual(result.main.winner.selectedIds, brute.best.ids);
  assert.equal(result.main.tieCount, 1);
});

test('budget, supply, bundle and alternative-group constraints all hold', () => {
  const scenario = getScenario('base');
  const market = buildMarket(scenario.market);
  const result = computeSettlement(market, { nodeLimit: scenario.nodeLimit });
  const settledIds = result.settlements.buys.map((b) => b.quoteId);

  // Alternative group: Q-103 and Q-107 must never both win.
  assert.ok(!(settledIds.includes('Q-103') && settledIds.includes('Q-107')));

  // Budgets.
  for (const bidder of market.bidders.filter((b) => b.side === 'buy')) {
    const spend = result.settlements.buys
      .filter((b) => market.quoteById.get(b.quoteId).bidderId === bidder.id)
      .reduce((sum, b) => sum + market.quoteById.get(b.quoteId).value, 0);
    assert.ok(spend <= bidder.budget, `${bidder.id} spend ${spend} > ${bidder.budget}`);
  }

  // Supply per item equals demand and never exceeds segment capacity.
  const demand = new Map();
  for (const b of result.settlements.buys) {
    for (const atom of market.quoteById.get(b.quoteId).atoms) {
      demand.set(atom.itemId, (demand.get(atom.itemId) || 0) + atom.qty);
    }
  }
  const used = new Map();
  for (const sup of result.settlements.supplies) {
    assert.ok(sup.qty <= market.quoteById.get(sup.quoteId).qty);
    used.set(sup.itemId, (used.get(sup.itemId) || 0) + sup.qty);
  }
  for (const [itemId, qty] of demand) assert.equal(used.get(itemId), qty);
});

test('every winner payment is recomputed from its own counterfactual removal', () => {
  const scenario = getScenario('base');
  const market = buildMarket(scenario.market);
  const result = computeSettlement(market, { nodeLimit: scenario.nodeLimit });
  assert.equal(result.settlements.buyPayments.length, result.settlements.buys.length);
  for (const pay of result.settlements.buyPayments) {
    const quote = market.quoteById.get(pay.quoteId);
    const cf = solveAllocation(market, {
      buyIds: new Set(market.buyQuotes.filter((q) => q.id !== quote.id).map((q) => q.id)),
    });
    assert.equal(pay.counterfactual.welfare, cf.bestWelfare, `${pay.quoteId} counterfactual welfare`);
    assert.equal(pay.payment, cf.bestWelfare - (result.main.welfare - quote.value));
    // Not simply the "last trade price": payments must differ from the quote value.
    assert.notEqual(pay.payment, pay.value);
  }
  // Buyer IR.
  for (const pay of result.settlements.buyPayments) assert.ok(pay.payment <= pay.value);
});

test('supplier receipts use W + cost - W(-s), not the per-unit trade price', () => {
  const scenario = getScenario('base');
  const market = buildMarket(scenario.market);
  const result = computeSettlement(market, { nodeLimit: scenario.nodeLimit });
  assert.ok(result.settlements.supplierReceipts.length > 0);
  for (const rec of result.settlements.supplierReceipts) {
    const cf = solveAllocation(market, {
      sellIds: new Set(market.sellQuotes.filter((q) => q.id !== rec.quoteId).map((q) => q.id)),
    });
    assert.equal(rec.receipt, result.main.welfare + rec.cost - cf.bestWelfare);
    assert.equal(rec.counterfactual.welfare, cf.bestWelfare);
  }
  // If the budget gap exists, it is exposed and not zeroed out.
  const s = result.settlements;
  assert.equal(s.gap, s.totalSupplierReceived - s.totalBuyerPaid);
  assert.equal(typeof s.gapMeaning, 'string');
});

test('validation checks pass for the real settlement', () => {
  const scenario = getScenario('base');
  const result = computeSettlement(buildMarket(scenario.market), { nodeLimit: scenario.nodeLimit });
  assert.equal(result.validation.ok, true, JSON.stringify(result.validation.checks.filter((c) => !c.ok)));
});

test('no-trade scenario yields no winners and no payment entries', () => {
  const scenario = getScenario('no-trade');
  const result = computeSettlement(buildMarket(scenario.market), { nodeLimit: scenario.nodeLimit });
  assert.equal(result.status, 'no-trade');
  assert.equal(result.settlements.winners.length, 0);
  assert.equal(result.settlements.buyPayments.length, 0);
  assert.equal(result.settlements.supplierReceipts.length, 0);
  assert.equal(result.validation.ok, true);
});

test('tie scenario reports both optimal allocations and applies documented tie-break', () => {
  const scenario = getScenario('tie');
  const result = computeSettlement(buildMarket(scenario.market), { nodeLimit: scenario.nodeLimit });
  assert.equal(result.status, 'ok');
  assert.equal(result.settlements.tie.count, 2);
  assert.equal(result.settlements.tie.alternatives.length, 1);
  // Lexicographically smallest quote id wins.
  assert.deepEqual(result.settlements.buys.map((b) => b.quoteId), ['Q-501']);
});

test('timeout scenario refuses to publish a partial settlement', () => {
  const scenario = getScenario('timeout');
  const result = computeSettlement(buildMarket(scenario.market), { nodeLimit: scenario.nodeLimit });
  assert.equal(result.status, 'timeout');
  assert.equal(result.settlements, null);
  assert.equal(result.payments, null);
  assert.ok(result.error.message.includes('预算'));
});

test('fault injection into a counterfactual blocks the settlement entirely', () => {
  const scenario = getScenario('base');
  const result = computeSettlement(buildMarket(scenario.market), {
    nodeLimit: scenario.nodeLimit,
    faultInject: { at: 2, reason: '演练：第 2 个子任务超时' },
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.settlements, null);
  assert.equal(result.payments, null);
  const failed = result.counterfactuals.find((c) => c.status === 'failed');
  assert.ok(failed);
  assert.equal(failed.index, 2);
});

test('a larger node budget lets the timeout scenario complete', () => {
  const scenario = getScenario('timeout');
  const result = computeSettlement(buildMarket(scenario.market), { nodeLimit: 5_000_000 });
  assert.equal(result.status, 'ok');
  assert.equal(result.validation.ok, true);
});

test('rejected quotes get a concrete blocking reason', () => {
  const scenario = getScenario('base');
  const market = buildMarket(scenario.market);
  const result = computeSettlement(market, { nodeLimit: scenario.nodeLimit });
  const explanation = explainQuote(market, result, 'Q-107', { nodeLimit: scenario.nodeLimit });
  assert.equal(explanation.status, 'rejected');
  assert.equal(explanation.blocking.kind, 'budget');
  const accepted = explainQuote(market, result, 'Q-101', { nodeLimit: scenario.nodeLimit });
  assert.equal(accepted.status, 'accepted');
  assert.ok(accepted.reasons.length >= 2);
  // Rejected outbid case.
  const outbid = explainQuote(market, result, 'Q-110', { nodeLimit: scenario.nodeLimit });
  assert.equal(outbid.status, 'rejected');
  assert.equal(outbid.blocking.kind, 'outbid');
});

test('supply comparison changes the winner set and both rounds are valid', () => {
  const scenario = getScenario('base');
  const cmp = compareSupply(scenario.market, SUPPLY_SHOCK.base, { nodeLimit: scenario.nodeLimit });
  assert.equal(cmp.before.status, 'ok');
  assert.equal(cmp.after.status, 'ok');
  assert.ok(cmp.diff.length > 0, 'supply change must alter at least one winner');
  assert.equal(cmp.resultBefore.validation.ok, true);
  assert.equal(cmp.resultAfter.validation.ok, true);
});

test('round lifecycle freezes quotes and defers late withdrawals', () => {
  const scenario = getScenario('base');
  let state = createRoundState(scenario.market, { nodeLimit: scenario.nodeLimit });
  const before = state.marketDef.buyQuotes.length;
  state = startClearing(state).state ?? startClearing(state);
  assert.equal(state.frozen, true);
  const withdrawn = requestWithdrawal(state, 'Q-109');
  assert.equal(withdrawn.applied, false);
  assert.equal(withdrawn.queuedRound, 2);
  assert.equal(withdrawn.state.marketDef.buyQuotes.length, before);
  assert.deepEqual(withdrawn.state.pendingWithdrawals, ['Q-109']);

  const supplyChange = requestSupplyChange(withdrawn.state, { quoteId: 'S-205', field: 'qty', value: 1 });
  assert.equal(supplyChange.applied, false);

  const round2 = nextRound(supplyChange.state);
  assert.equal(round2.round, 2);
  assert.equal(round2.frozen, false);
  assert.equal(round2.marketDef.buyQuotes.length, before - 1);
  assert.equal(round2.marketDef.sellQuotes.find((q) => q.id === 'S-205').qty, 1);
  assert.equal(round2.history.length, 1);
});

test('withdrawal before clearing takes effect immediately', () => {
  const scenario = getScenario('base');
  let state = createRoundState(scenario.market, { nodeLimit: scenario.nodeLimit });
  const before = state.marketDef.buyQuotes.length;
  const out = requestWithdrawal(state, 'Q-109');
  assert.equal(out.applied, true);
  assert.equal(out.state.marketDef.buyQuotes.length, before - 1);
});

test('adopting a supply comparison as the next round works only after clearing', () => {
  const scenario = getScenario('base');
  let state = createRoundState(scenario.market, { nodeLimit: scenario.nodeLimit });
  assert.throws(() => adoptSupplyAsNextRound(state, SUPPLY_SHOCK.base), MarketError);
  state = startClearing(state);
  const queued = adoptSupplyAsNextRound(state, SUPPLY_SHOCK.base);
  assert.equal(queued.round, 1);
  assert.equal(queued.marketDef.sellQuotes.find((q) => q.id === SUPPLY_SHOCK.base.quoteId).qty, 3);
  assert.equal(queued.pendingSupplyChanges.length, 1);
  const next = nextRound(queued);
  assert.equal(next.round, 2);
  assert.equal(next.marketDef.sellQuotes.find((q) => q.id === SUPPLY_SHOCK.base.quoteId).qty, SUPPLY_SHOCK.base.newValue);
});

test('market validation rejects malformed quotes', () => {
  const scenario = getScenario('base');
  const def = JSON.parse(JSON.stringify(scenario.market));
  def.buyQuotes.push({ id: 'Q-999', bidderId: 's1', atoms: [{ itemId: 'A', qty: 1 }], value: 10 });
  assert.throws(() => buildMarket(def), MarketError);
  const def2 = JSON.parse(JSON.stringify(scenario.market));
  def2.buyQuotes[0].atoms = [{ itemId: 'ZZZ', qty: 1 }];
  assert.throws(() => buildMarket(def2), MarketError);
});

test('solver never accepts a losing bundle (welfare < 0)', () => {
  const scenario = getScenario('no-trade');
  const market = buildMarket(scenario.market);
  const result = solveAllocation(market);
  assert.equal(result.bestWelfare, 0);
  assert.equal(result.winner, null);
});

test('per-quote alternative group ownership is enforced', () => {
  const scenario = getScenario('tie');
  const def = JSON.parse(JSON.stringify(scenario.market));
  def.buyQuotes[0].altGroup = 'g';
  def.buyQuotes[1].altGroup = 'g';
  assert.throws(() => buildMarket(def), MarketError);
});

test('node budget exhaustion throws SolveTimeout', () => {
  const market = baseMarket();
  const budget = new NodeBudget(10);
  assert.throws(() => solveAllocation(market, { budget }), SolveTimeout);
});

test('cheapest procurement uses ascending segments and partial segment use', () => {
  const market = baseMarket();
  const byItem = supplyIndexFor(market.sellQuotes);
  const demand = new Map([['A', 5]]);
  const proc = cheapestProcurement(demand, byItem);
  assert.equal(proc.feasible, true);
  assert.equal(proc.cost, 4 * 30 + 1 * 44);
  assert.equal(proc.uses.get('S-201'), 4);
  assert.equal(proc.uses.get('S-203'), 1);
});

test('buy quotes can be entered before clearing and are frozen afterwards', () => {
  const scenario = getScenario('base');
  let state = createRoundState(scenario.market, { nodeLimit: scenario.nodeLimit });
  const before = state.marketDef.buyQuotes.length;
  const out = addBuyQuote(state, {
    bidderId: 'b2',
    atoms: [{ itemId: 'T', qty: 1 }],
    value: 95,
  });
  state = out.state;
  assert.equal(state.marketDef.buyQuotes.length, before + 1);
  const cleared = startClearing(state, { nodeLimit: scenario.nodeLimit });
  assert.equal(cleared.settlement.status, 'ok');
  assert.throws(() => addBuyQuote(cleared, { bidderId: 'b2', atoms: [{ itemId: 'T', qty: 1 }], value: 90 }), MarketError);
});

test('a newly entered buy quote participates in clearing and gets its own counterfactual', () => {
  const scenario = getScenario('base');
  let state = createRoundState(scenario.market, { nodeLimit: scenario.nodeLimit });
  state = addBuyQuote(state, {
    bidderId: 'b1',
    atoms: [{ itemId: 'A', qty: 1 }],
    value: 120,
    altGroup: 'b1-extra',
  }).state;
  const cleared = startClearing(state, { nodeLimit: scenario.nodeLimit });
  const r = cleared.settlement;
  assert.equal(r.validation.ok, true);
  const ids = r.settlements.buys.map((b) => b.quoteId);
  assert.ok(ids.length > 0);
  for (const id of ids) {
    const pay = r.settlements.buyPayments.find((p) => p.quoteId === id);
    assert.ok(pay, `missing payment for ${id}`);
    assert.equal(pay.payment, pay.counterfactual.welfare - (r.main.welfare - pay.value));
  }
});

test('supply segments can be entered before clearing; invalid input is rejected', () => {
  const scenario = getScenario('base');
  let state = createRoundState(scenario.market, { nodeLimit: scenario.nodeLimit });
  state = addSellQuote(state, {
    bidderId: 's2',
    itemId: 'T',
    qty: 2,
    unitPrice: 70,
  }).state;
  assert.equal(state.marketDef.sellQuotes.length, scenario.market.sellQuotes.length + 1);
  assert.throws(() => addSellQuote(state, { bidderId: 's2', itemId: 'T', qty: 0, unitPrice: 70 }), MarketError);
  assert.throws(
    () => addSellQuote(state, { bidderName: '新供应商', itemId: 'ZZZ', qty: 1, unitPrice: 10 }),
    MarketError,
  );
});
