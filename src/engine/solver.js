/**
 * Exact winner determination + VCG-style payments for the multi-item
 * double auction.
 *
 * Winner determination is a full enumeration over buy-quote subsets. Supply
 * is a set of independent sell segments; for any chosen subset the cheapest
 * feasible procurement is computed item by item (greedy over ascending unit
 * prices). The markets in this app stay at or below 16 buy quotes, so the
 * exhaustive search is exact.
 *
 * The mechanism is VCG over quotes: each winning quote is an agent.
 *   buyer payment_b  = W(-b) - (W - v_b)
 *   supplier receipt_s = W + c_s - W(-s)
 * where W is the optimal welfare, W(-x) is optimal welfare with quote x
 * removed, and c_s is the cost of the quantity actually bought from s.
 * Payments are never adjusted to close the budget gap.
 */

import { MarketError, demandOfBuyQuotes, cmpId } from './market.js';

export const DEFAULT_NODE_LIMIT = 2_000_000;

export class SolveTimeout extends Error {
  constructor(message, { used, limit } = {}) {
    super(message);
    this.name = 'SolveTimeout';
    this.used = used;
    this.limit = limit;
  }
}

/** Shared enumeration budget across one settlement computation. */
export class NodeBudget {
  constructor(limit = DEFAULT_NODE_LIMIT) {
    if (!Number.isFinite(limit) || limit <= 0) throw new MarketError('节点预算必须是正数');
    this.limit = Math.floor(limit);
    this.used = 0;
  }
  tick() {
    this.used += 1;
    if (this.used > this.limit) {
      throw new SolveTimeout('枚举节点预算耗尽', { used: this.used, limit: this.limit });
    }
  }
  get remaining() {
    return Math.max(0, this.limit - this.used);
  }
}

/** Units of each item available from a set of sell quotes. */
function supplyIndex(sellQuotes) {
  const byItem = new Map();
  for (const quote of sellQuotes) {
    if (!byItem.has(quote.itemId)) byItem.set(quote.itemId, []);
    byItem.get(quote.itemId).push(quote);
  }
  for (const [itemId, list] of byItem) {
    list.sort((a, b) => a.unitPrice - b.unitPrice || a.qty - b.qty || cmpId(a.id, b.id));
    byItem.set(itemId, list);
  }
  return byItem;
}

/**
 * Cheapest feasible procurement for a demand vector.
 * @returns {{feasible:boolean, cost:number, uses:Map<string,number>}}
 */
export function cheapestProcurement(demand, byItem) {
  let cost = 0;
  const uses = new Map();
  for (const [itemId, units] of demand) {
    if (units === 0) continue;
    const offers = byItem.get(itemId) || [];
    let need = units;
    for (const offer of offers) {
      if (need === 0) break;
      const take = Math.min(need, offer.qty);
      if (take > 0) {
        need -= take;
        cost += take * offer.unitPrice;
        uses.set(offer.id, (uses.get(offer.id) || 0) + take);
      }
    }
    if (need > 0) return { feasible: false, cost: Infinity, uses: new Map() };
  }
  return { feasible: true, cost, uses };
}

/** Public helper: supply index for a market, for the explanation panel. */
export function supplyIndexFor(sellQuotes) {
  return supplyIndex(sellQuotes);
}

function signature(selectedIds) {
  return selectedIds.join(',');
}

/**
 * Enumerate all feasible allocations and find the welfare-maximizing set.
 *
 * Tie-break (documented and shown in the UI):
 *   1. maximum welfare,
 *   2. maximum total declared buyer value,
 *   3. lexicographically smallest selected-quote-id signature.
 *
 * `requiredBuyIds` pins quotes into every candidate allocation; the result
 * then answers "what is the best outcome if this rejected quote must be
 * accepted?". If the pinned set is infeasible the result carries
 * `requiredInfeasible: true`.
 *
 * @param {object} market normalized market
 * @param {{buyIds?:Set<string>, sellIds?:Set<string>, requiredBuyIds?:Iterable<string>, budget:NodeBudget}} options
 * @returns {object} solution
 */
export function solveAllocation(market, options = {}) {
  const budget = options.budget || new NodeBudget(options.nodeLimit ?? DEFAULT_NODE_LIMIT);
  const includedBuys = market.buyQuotes.filter((q) => !options.buyIds || options.buyIds.has(q.id));
  const includedSells = market.sellQuotes.filter((q) => !options.sellIds || options.sellIds.has(q.id));
  const byItem = supplyIndex(includedSells);
  const supplyByItem = new Map();
  for (const [itemId, offers] of byItem) {
    supplyByItem.set(itemId, offers.reduce((sum, offer) => sum + offer.qty, 0));
  }

  // Deterministic agent order: by quote id.
  const quotes = includedBuys.slice().sort((a, b) => cmpId(a.id, b.id));
  const winnerAllocations = [];
  let bestWelfare = 0;
  let bestBuyValue = 0;
  let exploredLeaves = 0;
  let feasibleLeaves = 0;

  const used = new Map();
  const selected = [];
  const bidderSpend = new Map();
  const groupTaken = new Map();

  const required = new Set(options.requiredBuyIds || []);
  let requiredInfeasible = false;
  for (const id of required) {
    if (!quotes.some((q) => q.id === id)) {
      requiredInfeasible = true;
      break;
    }
  }
  if (!requiredInfeasible) {
    for (const quote of quotes) {
      if (!required.has(quote.id)) continue;
      let ok = true;
      if (quote.altGroup && groupTaken.get(quote.altGroup)) ok = false;
      for (const atom of quote.atoms) {
        if ((used.get(atom.itemId) || 0) + atom.qty > (supplyByItem.get(atom.itemId) || 0)) ok = false;
      }
      const bidder = market.bidderById.get(quote.bidderId);
      if ((bidderSpend.get(quote.bidderId) || 0) + quote.value > (bidder.budget ?? Number.MAX_SAFE_INTEGER)) ok = false;
      if (!ok) {
        requiredInfeasible = true;
        break;
      }
      for (const atom of quote.atoms) used.set(atom.itemId, (used.get(atom.itemId) || 0) + atom.qty);
      bidderSpend.set(quote.bidderId, (bidderSpend.get(quote.bidderId) || 0) + quote.value);
      if (quote.altGroup) groupTaken.set(quote.altGroup, quote.id);
      selected.push(quote);
    }
  }

  function evaluate() {
    exploredLeaves += 1;
    const demand = demandOfBuyQuotes(selected);
    // supply feasibility first
    for (const [itemId, units] of demand) {
      if ((supplyByItem.get(itemId) || 0) < units) return;
    }
    const procurement = cheapestProcurement(demand, byItem);
    if (!procurement.feasible) return;
    feasibleLeaves += 1;
    const buyValue = selected.reduce((sum, q) => sum + q.value, 0);
    const welfare = buyValue - procurement.cost;
    if (welfare < 0) return; // never trade at a loss
    if (welfare > bestWelfare) {
      bestWelfare = welfare;
      bestBuyValue = buyValue;
      winnerAllocations.length = 0;
    }
    if (welfare === bestWelfare) {
      if (buyValue > bestBuyValue) {
        bestBuyValue = buyValue;
        winnerAllocations.length = 0;
      }
      if (buyValue === bestBuyValue) {
        winnerAllocations.push({
          selectedIds: selected.map((q) => q.id),
          buyValue,
          cost: procurement.cost,
          welfare,
          uses: procurement.uses,
        });
      }
    }
  }

  const winnerCandidates = [];
  let latest = 0;
  const mainStart = budget.used;

  function recurse(index) {
    budget.tick();
    if (index === quotes.length) {
      evaluate();
      return;
    }
    const quote = quotes[index];
    if (required.has(quote.id)) {
      // Already pinned above; no branching on it.
      recurse(index + 1);
      return;
    }
    // skip
    recurse(index + 1);
    // take
    const bidder = market.bidderById.get(quote.bidderId);
    const spent = bidderSpend.get(quote.bidderId) || 0;
    const cap = bidder.budget ?? Number.MAX_SAFE_INTEGER;
    const groupFree = !quote.altGroup || !groupTaken.get(quote.altGroup);
    if (groupFree && spent + quote.value <= cap) {
      let feasibleSupply = true;
      for (const atom of quote.atoms) {
        const current = used.get(atom.itemId) || 0;
        if (current + atom.qty > (supplyByItem.get(atom.itemId) || 0)) {
          feasibleSupply = false;
          break;
        }
      }
      if (feasibleSupply) {
        for (const atom of quote.atoms) used.set(atom.itemId, (used.get(atom.itemId) || 0) + atom.qty);
        bidderSpend.set(quote.bidderId, spent + quote.value);
        if (quote.altGroup) groupTaken.set(quote.altGroup, quote.id);
        selected.push(quote);
        recurse(index + 1);
        selected.pop();
        if (quote.altGroup) groupTaken.delete(quote.altGroup);
        bidderSpend.set(quote.bidderId, spent);
        for (const atom of quote.atoms) used.set(atom.itemId, used.get(atom.itemId) - atom.qty);
      }
    }
  }

  if (!requiredInfeasible) {
    recurse(0);
  } else {
    // Pinned acceptance is impossible: no candidate can be evaluated.
    exploredLeaves = 0;
  }

  let winner = null;
  let tied = [];
  if (!requiredInfeasible && winnerAllocations.length > 0) {
    const sorted = winnerAllocations.slice().sort((a, b) => {
      if (a.buyValue !== b.buyValue) return b.buyValue - a.buyValue;
      return cmpId(signature(a.selectedIds), signature(b.selectedIds));
    });
    if (sorted[0].selectedIds.length > 0) {
      winner = sorted[0];
      tied = sorted;
    }
  }

  return {
    requiredInfeasible,
    includedBuyIds: quotes.map((q) => q.id),
    includedSellIds: includedSells.map((q) => q.id),
    bestWelfare,
    winner,
    tieCount: tied.length,
    tiedAllocations: tied.slice(0, 8),
    exploredLeaves,
    feasibleLeaves,
    nodesUsed: budget.used - mainStart,
    nodeLimit: budget.limit,
    budgetRemaining: budget.remaining,
  };
}

export const MECHANISMS = {
  vcg: {
    id: 'vcg',
    name: '逐报价反事实（VCG）',
    short: '买方 W(−b) − (W − v)；卖方 W + c − W(−s)',
    description:
      '每个赢家报价都单独撤除后重新求最优分配，用反事实福利差确定支付/收款。支付不由最后一笔成交价决定。',
  },
  'buyer-vcg-cost-supply': {
    id: 'buyer-vcg-cost-supply',
    name: '买方反事实 + 卖方成本补偿（对照）',
    short: '买方 W(−b) − (W − v)；卖方按成交成本收款',
    description:
      '仅供对照：买方仍按逐报价反事实支付，卖方只获成本补偿。该规则不保证激励相容，正式结算仍应使用 VCG。',
  },
};

export function getMechanism(id) {
  return MECHANISMS[id] || MECHANISMS.vcg;
}

/** Total declared value of the selected buy quotes. */
function valueOfSelection(market, selectedIds) {
  return selectedIds.reduce((sum, id) => sum + (market.quoteById.get(id)?.value || 0), 0);
}

/**
 * Compute a complete settlement. Every counterfactual is solved before any
 * settlement is returned; if one fails, `status: 'failed'` is returned with
 * no settlement payload at all.
 *
 * @param {object} market
 * @param {{nodeLimit?:number, faultInject?:{at:number,reason?:string}}} options
 */
export function computeSettlement(market, options = {}) {
  const startedAt = Date.now();
  const budget = new NodeBudget(options.nodeLimit ?? DEFAULT_NODE_LIMIT);
  const mechanism = getMechanism(options.mechanism);
  const result = {
    status: 'ok',
    settlements: null,
    error: null,
    mechanism,
    main: null,
    mainSummary: null,
    counterfactuals: [],
    counterfactualTotal: 0,
    payments: null,
    validation: null,
    nodes: { used: 0, limit: budget.limit, remaining: 0 },
    durationMs: 0,
  };

  try {
    const main = solveAllocation(market, { budget });
    result.mainSummary = {
      status: 'ok',
      welfare: main.bestWelfare,
      winnerIds: main.winner ? main.winner.selectedIds.slice() : [],
      tieCount: main.tieCount,
    };
    if (!main.winner) {
      result.main = summarizeSolution(main);
      result.status = 'no-trade';
      result.settlements = {
        winners: [],
        buyPayments: [],
        supplierReceipts: [],
        totalBuyerPaid: 0,
        totalSupplierReceived: 0,
        gap: 0,
        gapMeaning: '无成交，无资金流动',
      };
      result.validation = validateSettlement(market, result);
      result.nodes = { used: budget.used, limit: budget.limit, remaining: budget.remaining };
      result.durationMs = Date.now() - startedAt;
      return result;
    }

    const winner = main.winner;
    const selectedBuys = winner.selectedIds.map((id) => market.quoteById.get(id));
    const selectedSells = [...winner.uses.entries()].map(([id, qty]) => ({
      quote: market.quoteById.get(id),
      qty,
      cost: qty * market.quoteById.get(id).unitPrice,
    }));

    const buyCf = [];
    const sellCf = [];
    const tasks = [
      ...selectedBuys.map((quote) => ({ side: 'buy', quote })),
      ...selectedSells.map((entry) => ({ side: 'sell', quote: entry.quote, qty: entry.qty })),
    ];
    result.counterfactualTotal = tasks.length;

    for (let i = 0; i < tasks.length; i += 1) {
      const task = tasks[i];
      const label =
        task.side === 'buy'
          ? `撤除买方报价 ${task.quote.id}（${market.bidderById.get(task.quote.bidderId)?.name || ''}）`
          : `撤除卖方报价 ${task.quote.id}（${market.bidderById.get(task.quote.bidderId)?.name || ''}，${task.quote.itemId} × ${task.qty}）`;

      // Fault-injection drill: lets the UI prove that a failed subtask blocks
      // the whole settlement.
      if (options.faultInject && options.faultInject.at === i + 1) {
        result.counterfactuals.push({
          index: i + 1,
          side: task.side,
          quoteId: task.quote.id,
          label,
          status: 'failed',
          error: options.faultInject.reason || '注入的子任务失败（演练）',
        });
        throw new MarketError(
          `反事实子任务 ${i + 1}/${tasks.length} 失败：${options.faultInject.reason || '注入失败（演练）'}；结算单未发布`,
        );
      }

      const cf = solveAllocation(market, {
        budget,
        buyIds:
          task.side === 'buy'
            ? new Set(market.buyQuotes.filter((q) => q.id !== task.quote.id).map((q) => q.id))
            : undefined,
        sellIds:
          task.side === 'sell'
            ? new Set(market.sellQuotes.filter((q) => q.id !== task.quote.id).map((q) => q.id))
            : undefined,
      });
      const entry = {
        index: i + 1,
        side: task.side,
        quoteId: task.quote.id,
        label,
        status: 'ok',
        solution: summarizeSolution(cf),
        welfare: cf.bestWelfare,
        winnerIds: cf.winner ? cf.winner.selectedIds : [],
        procurementCost: cf.winner ? cf.winner.cost : 0,
        uses: cf.winner ? cf.winner.uses : new Map(),
      };
      if (task.side === 'buy') buyCf.push(entry);
      else sellCf.push(entry);
      result.counterfactuals.push(entry);
    }

    const W = main.bestWelfare;
    const buyPayments = selectedBuys.map((quote) => {
      const cf = buyCf.find((entry) => entry.quoteId === quote.id);
      const without = cf.welfare;
      const payment = without - (W - quote.value);
      return {
        quoteId: quote.id,
        bidderId: quote.bidderId,
        bidderName: market.bidderById.get(quote.bidderId)?.name,
        value: quote.value,
        payment,
        rule: 'buyer-counterfactual',
        formula: 'W(−b) − (W − v)',
        identity: `W(−${quote.id}) − (W − ${quote.value}) = ${without} − ${W - quote.value} = ${payment}`,
        counterfactual: cf,
      };
    });

    const supplierReceipts = selectedSells.map((entry) => {
      const q = entry.quote;
      const cf = sellCf.find((item) => item.quoteId === q.id);
      const cost = entry.cost;
      const receipt = mechanism.id === 'vcg' ? W + cost - cf.welfare : cost;
      return {
        quoteId: q.id,
        bidderId: q.bidderId,
        bidderName: market.bidderById.get(q.bidderId)?.name,
        itemId: q.itemId,
        qty: entry.qty,
        unitPrice: q.unitPrice,
        cost,
        receipt,
        rule: mechanism.id === 'vcg' ? 'seller-counterfactual' : 'cost-compensation',
        formula: mechanism.id === 'vcg' ? 'W + c − W(−s)' : 'c（成交成本）',
        identity:
          mechanism.id === 'vcg'
            ? `W + ${cost} − W(−${q.id}) = ${W} + ${cost} − ${cf.welfare} = ${receipt}`
            : `成交成本 ${cost} = ${receipt}`,
        counterfactual: cf,
      };
    });

    const totalBuyerPaid = buyPayments.reduce((sum, p) => sum + p.payment, 0);
    const totalSupplierReceived = supplierReceipts.reduce((sum, p) => sum + p.receipt, 0);
    const gap = totalSupplierReceived - totalBuyerPaid;

    result.main = summarizeSolution(main);
    result.payments = { buyPayments, supplierReceipts };
    result.mechanism = mechanism;
    result.settlements = {
      mechanismId: mechanism.id,
      mechanismName: mechanism.name,
      winners: selectedBuys.map((q) => ({
        quoteId: q.id,
        bidderId: q.bidderId,
        bidderName: market.bidderById.get(q.bidderId)?.name,
        atoms: q.atoms,
        value: q.value,
        note: q.note,
      })),
      buys: selectedBuys.map((q) => ({
        quoteId: q.id,
        bidderId: q.bidderId,
        atoms: q.atoms,
        value: q.value,
      })),
      supplies: selectedSells.map((entry) => ({
        quoteId: entry.quote.id,
        bidderId: entry.quote.bidderId,
        itemId: entry.quote.itemId,
        qty: entry.qty,
        unitPrice: entry.quote.unitPrice,
        cost: entry.cost,
        offeredQty: entry.quote.qty,
      })),
      procurementCost: winner.cost,
      totalBuyerValue: valueOfSelection(market, winner.selectedIds),
      welfare: W,
      totalBuyerPaid,
      totalSupplierReceived,
      gap,
      gapMeaning:
        gap > 0
          ? `机制支出超过收入 ${gap}：需外部补足，支付未修改`
          : gap < 0
            ? `机制收入超过支出 ${-gap}：形成盈余，支付未修改`
            : '预算恰好平衡',
      buyPayments,
      supplierReceipts,
      tie: {
        count: main.tieCount,
        alternatives: main.tiedAllocations
          .filter((alloc) => signature(alloc.selectedIds) !== signature(winner.selectedIds))
          .slice(0, 3)
          .map((alloc) => ({ selectedIds: alloc.selectedIds, buyValue: alloc.buyValue, cost: alloc.cost })),
      },
    };
    result.validation = validateSettlement(market, result);
    result.status = 'ok';
    result.counterfactualsDone = result.counterfactuals.filter((c) => c.status === 'ok').length;
  } catch (error) {
    result.status = error instanceof SolveTimeout ? 'timeout' : 'failed';
    result.error = {
      name: error.name,
      message: error.message,
      used: error.used,
      limit: error.limit,
    };
    result.main = null;
    result.counterfactualsDone = result.counterfactuals.filter((c) => c.status === 'ok').length;
    result.payments = null;
    result.settlements = null; // never publish a partial settlement
    result.validation = null;
  }

  result.nodes = { used: budget.used, limit: budget.limit, remaining: budget.remaining };
  result.durationMs = Date.now() - startedAt;
  return result;
}

function summarizeSolution(solution) {
  return {
    welfare: solution.bestWelfare,
    winner: solution.winner
      ? {
          selectedIds: solution.winner.selectedIds.slice(),
          buyValue: solution.winner.buyValue,
          cost: solution.winner.cost,
          uses: new Map(solution.winner.uses),
        }
      : null,
    tieCount: solution.tieCount,
    tiedAllocations: solution.tiedAllocations.map((alloc) => ({
      selectedIds: alloc.selectedIds.slice(),
      buyValue: alloc.buyValue,
      cost: alloc.cost,
    })),
    nodesUsed: solution.nodesUsed,
    nodeLimit: solution.nodeLimit,
    exploredLeaves: solution.exploredLeaves,
    feasibleLeaves: solution.feasibleLeaves,
  };
}

/**
 * Independent checks over a computed settlement. Every check returns
 * { id, label, ok, detail }. A false check means the settlement is inconsistent.
 */
export function validateSettlement(market, result) {
  const checks = [];
  const add = (id, label, ok, detail) => checks.push({ id, label, ok, detail });

  if (result.status === 'no-trade') {
    add('no-trade', '无成交清算：没有赢家、没有支付', true, '所有报价组合都被判定为无利可图或不满足约束');
    add('no-partial-payment', '无部分支付结算单', result.settlements.buyPayments.length === 0, '买方支付条目为 0');
    return { ok: true, checks };
  }
  if (result.status !== 'ok' || !result.settlements) {
    add('not-published', '失败时未发布结算单', result.settlements === null, result.error?.message || '');
    return { ok: false, checks };
  }

  const s = result.settlements;
  const winner = result.main.winner;
  const chosen = new Set(winner.selectedIds);

  // 1. Buy quotes in settlement equal the winner allocation.
  const settledBuys = s.buys.map((b) => b.quoteId).sort(cmpId);
  const expectedBuys = [...chosen].sort(cmpId);
  add(
    'allocation-match',
    '成交明细与最优分配一致',
    JSON.stringify(settledBuys) === JSON.stringify(expectedBuys),
    `结算 ${settledBuys.join(', ') || '∅'} / 求解 ${expectedBuys.join(', ') || '∅'}`,
  );

  // 2. Supply per item never exceeds available segments; only winning quotes used.
  const demand = new Map();
  for (const buy of s.buys) {
    const q = market.quoteById.get(buy.quoteId);
    for (const atom of q.atoms) demand.set(atom.itemId, (demand.get(atom.itemId) || 0) + atom.qty);
  }
  const supply = new Map();
  for (const sup of s.supplies) {
    const q = market.quoteById.get(sup.quoteId);
    if (!q) {
      add('supply-valid', '供给条目均来自真实报价', false, `未知报价 ${sup.quoteId}`);
      continue;
    }
    if (sup.qty > q.qty || sup.qty <= 0) {
      add('supply-within-segment', `分段 ${sup.quoteId} 的取用量合法`, false, `取用 ${sup.qty} / 供给 ${q.qty}`);
    }
    supply.set(sup.itemId, (supply.get(sup.itemId) || 0) + sup.qty);
  }
  const supplyOk = [...demand.entries()].every(([itemId, units]) => (supply.get(itemId) || 0) === units);
  const demandText = [...demand.entries()].map(([k, v]) => `${k}×${v}`).join(', ') || '∅';
  const supplyText = [...supply.entries()].map(([k, v]) => `${k}×${v}`).join(', ') || '∅';
  add('supply-feasible', '供应量满足全部成交需求', supplyOk, `需求 ${demandText}；实际取用 ${supplyText}`);

  // 3. Budget per bidder (declared value basis).
  const spendByBidder = new Map();
  for (const buy of s.buys) {
    const q = market.quoteById.get(buy.quoteId);
    spendByBidder.set(q.bidderId, (spendByBidder.get(q.bidderId) || 0) + q.value);
  }
  let budgetOk = true;
  const budgetDetails = [];
  for (const [bidderId, spend] of spendByBidder) {
    const bidder = market.bidderById.get(bidderId);
    const cap = bidder.budget ?? Number.MAX_SAFE_INTEGER;
    if (spend > cap) budgetOk = false;
    budgetDetails.push(`${bidder.name} ${spend}/${cap === Number.MAX_SAFE_INTEGER ? '∞' : cap}`);
  }
  add('budget-feasible', '买方预算约束满足（按申报价值占用）', budgetOk, budgetDetails.join('；') || '无买方支出');

  // 4. Welfare recomputation from the published allocation.
  let recomputedBuyValue = 0;
  for (const buy of s.buys) recomputedBuyValue += market.quoteById.get(buy.quoteId).value;
  let recomputedCost = 0;
  for (const sup of s.supplies) {
    const q = market.quoteById.get(sup.quoteId);
    recomputedCost += sup.qty * q.unitPrice;
  }
  const recomputedWelfare = recomputedBuyValue - recomputedCost;
  add(
    'welfare',
    '福利 = 成交买方价值 − 采购成本',
    recomputedWelfare === s.welfare && recomputedWelfare === result.main.welfare,
    `${recomputedBuyValue} − ${recomputedCost} = ${recomputedWelfare}（求解最优 ${result.main.welfare}）`,
  );

  // 5. Every winner has exactly one payment entry, with none missing.
  const paymentIds = s.buyPayments.map((p) => p.quoteId).sort(cmpId);
  const winnersSorted = [...chosen].sort(cmpId);
  add(
    'payments-complete',
    '每位赢家都有且仅有一笔支付',
    JSON.stringify(paymentIds) === JSON.stringify(winnersSorted),
    `${paymentIds.length} 笔支付 / ${winnersSorted.length} 位赢家`,
  );

  // 6. Recompute every payment from stored counterfactual welfare.
  const paymentRecomputed = s.buyPayments.every(
    (p) => p.payment === p.counterfactual.welfare - (s.welfare - p.value),
  );
  const receiptRecomputed = s.supplierReceipts.every(
    (p) => p.receipt === s.welfare + p.cost - p.counterfactual.welfare,
  );
  add(
    'payments-recomputed',
    '支付可由反事实重新计算',
    paymentRecomputed && receiptRecomputed,
    `买方 ${s.buyPayments.length} 笔；卖方 ${s.supplierReceipts.length} 笔`,
  );

  // 7. Each quoted payment ≤ declared value; supplier receipts non-negative.
  const buyerIR = s.buyPayments.every((p) => p.payment <= p.value);
  add('buyer-ir', '买方支付不超过申报价值', buyerIR, s.buyPayments.map((p) => `${p.quoteId}: ${p.payment}≤${p.value}`).join('；') || '无');

  // 8. Budget gap is reported, not hidden.
  const gapRecomputed = s.totalSupplierReceived - s.totalBuyerPaid === s.gap;
  add('gap-reported', '资金缺口单独披露，未挪用支付', gapRecomputed, `收入 ${s.totalBuyerPaid}；支出 ${s.totalSupplierReceived}；缺口 ${s.gap}`);

  return { ok: checks.every((c) => c.ok), checks };
}
