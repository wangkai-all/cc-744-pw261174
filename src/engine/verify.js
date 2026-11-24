import { NodeBudget } from './solver.js';
import { buildMarket } from './market.js';

/**
 * Independent brute-force verifier used by the in-app self-check and tests.
 * Deliberately shares no code with the solver: it re-derives quote subsets,
 * per-item cheapest procurement and VCG payments from the raw quote list.
 */

export function bruteForceVerification(marketDef, options = {}) {
  const market = buildMarket(marketDef);
  const buyQuotes = market.buyQuotes;
  const sellQuotes = market.sellQuotes;

  const itemOrder = market.items.map((i) => i.id);
  const supply = new Map(itemOrder.map((id) => [id, 0]));
  for (const q of sellQuotes) supply.set(q.itemId, (supply.get(q.itemId) || 0) + q.qty);

  function demandOf(ids) {
    const demand = new Map(itemOrder.map((id) => [id, 0]));
    for (const id of ids) {
      const q = market.quoteById.get(id);
      for (const atom of q.atoms) demand.set(atom.itemId, demand.get(atom.itemId) + atom.qty);
    }
    return demand;
  }

  function minCost(demand) {
    let cost = 0;
    for (const itemId of itemOrder) {
      let need = demand.get(itemId) || 0;
      if (!need) continue;
      const offers = sellQuotes.filter((q) => q.itemId === itemId).sort((a, b) => a.unitPrice - b.unitPrice || (a.id < b.id ? -1 : 1));
      for (const offer of offers) {
        const take = Math.min(need, offer.qty);
        need -= take;
        cost += take * offer.unitPrice;
        if (need === 0) break;
      }
      if (need > 0) return null;
    }
    return cost;
  }

  function feasible(ids) {
    // budget per bidder
    const spend = new Map();
    for (const id of ids) {
      const q = market.quoteById.get(id);
      spend.set(q.bidderId, (spend.get(q.bidderId) || 0) + q.value);
      if (spend.get(q.bidderId) > (market.bidderById.get(q.bidderId).budget ?? Infinity)) return false;
    }
    // alternative groups
    const groups = new Set();
    for (const id of ids) {
      const q = market.quoteById.get(id);
      if (q.altGroup) {
        if (groups.has(q.altGroup)) return false;
        groups.add(q.altGroup);
      }
    }
    const demand = demandOf(ids);
    for (const itemId of itemOrder) {
      if ((demand.get(itemId) || 0) > (supply.get(itemId) || 0)) return null;
    }
    return true;
  }

  function objective(ids) {
    if (!feasible(ids)) return null;
    const cost = minCost(demandOf(ids));
    if (cost === null) return null;
    const value = ids.reduce((sum, id) => sum + market.quoteById.get(id).value, 0);
    const welfare = value - cost;
    return welfare >= 0 ? { value, cost, welfare } : null;
  }

  const subsets = [];
  const n = buyQuotes.length;
  const limit = options.subsetLimit ?? 1 << 16;
  if (n > 16) throw new Error('暴力校验最多支持 16 条买方报价');
  for (let mask = 0; mask < 1 << n; mask += 1) {
    const ids = [];
    for (let bit = 0; bit < n; bit += 1) if (mask & (1 << bit)) ids.push(buyQuotes[bit].id);
    const obj = objective(ids);
    if (obj) subsets.push({ ids, ...obj });
  }

  subsets.sort((a, b) => {
    if (a.welfare !== b.welfare) return b.welfare - a.welfare;
    if (a.value !== b.value) return b.value - a.value;
    return a.ids.join(',') < b.ids.join(',') ? -1 : 1;
  });
  const best = subsets[0] || null;

  function bestExcluding(excluded, { required = [] } = {}) {
    let top = null;
    for (const cand of subsets) {
      if (cand.ids.includes(excluded)) continue;
      if (!required.every((r) => cand.ids.includes(r))) continue;
      if (!top || cand.welfare > top.welfare || (cand.welfare === top.welfare && cand.value > top.value)) top = cand;
    }
    return top;
  }

  return {
    bestWelfare: best ? best.welfare : 0,
    best,
    isUnique: subsets.filter((s) => best && s.welfare === best.welfare && s.value === best.value).length === 1,
    ties: best ? subsets.filter((s) => s.welfare === best.welfare && s.value === best.value) : [],
    evaluated: subsets.length,
    bestExcluding,
    market,
  };
}
