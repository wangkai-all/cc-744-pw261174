/**
 * Round lifecycle: quotes are frozen the moment clearing starts. Any quote
 * withdrawal (or supply edit) attempted while frozen is queued for the next
 * round instead of silently changing the round being cleared.
 */

import { buildMarket, MarketError } from './market.js';
import { computeSettlement } from './solver.js';

export function createRoundState(marketDef, options = {}) {
  return {
    round: 1,
    marketDef: deepCopy(marketDef),
    nodeLimit: options.nodeLimit ?? 2_000_000,
    frozen: false,
    clearingStartedAt: null,
    settlement: null,
    pendingWithdrawals: [],
    pendingSupplyChanges: [],
    history: [],
  };
}

function deepCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Freeze current quotes and clear this round. */
export function startClearing(state, options = {}) {
  if (state.frozen) throw new MarketError('本轮报价已冻结，请开启新一轮');
  const market = buildMarket(state.marketDef);
  const settlement = computeSettlement(market, {
    nodeLimit: options.nodeLimit ?? state.nodeLimit,
    faultInject: options.faultInject ?? null,
    mechanism: options.mechanism ?? state.mechanismId ?? 'vcg',
  });
  return {
    ...state,
    frozen: true,
    clearingStartedAt: new Date().toISOString(),
    settlement,
    pendingWithdrawals: [],
    pendingSupplyChanges: [],
  };
}

/**
 * Withdraw a quote. Before clearing it takes effect immediately; after
 * clearing starts it is recorded as a late withdrawal for the next round.
 */
export function requestWithdrawal(state, quoteId) {
  if (!state.marketDef.buyQuotes.some((q) => q.id === quoteId) &&
      !state.marketDef.sellQuotes.some((q) => q.id === quoteId)) {
    throw new MarketError(`未知报价 ${quoteId}`);
  }
  if (state.frozen) {
    const already = state.pendingWithdrawals.includes(quoteId);
    return {
      state: already
        ? state
        : { ...state, pendingWithdrawals: [...state.pendingWithdrawals, quoteId] },
      applied: false,
      queuedRound: state.round + 1,
      message: already
        ? `报价 ${quoteId} 已在第 ${state.round + 1} 轮的待撤清单中`
        : `第 ${state.round} 轮已冻结；撤单 ${quoteId} 记入第 ${state.round + 1} 轮`,
    };
  }
  const marketDef = deepCopy(state.marketDef);
  marketDef.buyQuotes = marketDef.buyQuotes.filter((q) => q.id !== quoteId);
  marketDef.sellQuotes = marketDef.sellQuotes.filter((q) => q.id !== quoteId);
  // Drop quotes whose bidder no longer has any quote? Keep bidders; harmless.
  return {
    state: { ...state, marketDef },
    applied: true,
    queuedRound: null,
    message: `已撤回报价 ${quoteId}`,
  };
}

/** Edit a supply segment. Deferred while frozen. */
export function requestSupplyChange(state, change) {
  const { quoteId, field } = change;
  const newValue = change.newValue ?? change.value;
  const target = state.marketDef.sellQuotes.find((q) => q.id === quoteId);
  if (!target) throw new MarketError(`未知供给分段 ${quoteId}`);
  if (!['qty', 'unitPrice'].includes(field)) throw new MarketError(`不支持的字段 ${field}`);
  if (!Number.isInteger(newValue) || newValue < 1) throw new MarketError('供给数值必须是正整数');
  const normalized = { quoteId, field, newValue };

  if (state.frozen) {
    const pendingSupplyChanges = state.pendingSupplyChanges.filter(
      (c) => !(c.quoteId === quoteId && c.field === field),
    );
    return {
      state: {
        ...state,
        pendingSupplyChanges: [...pendingSupplyChanges, normalized],
      },
      applied: false,
      queuedRound: state.round + 1,
      message: `第 ${state.round} 轮已冻结；供给修改 ${quoteId} 记入第 ${state.round + 1} 轮`,
    };
  }
  const marketDef = deepCopy(state.marketDef);
  marketDef.sellQuotes.find((q) => q.id === quoteId)[field] = newValue;
  return {
    state: { ...state, marketDef },
    applied: true,
    queuedRound: null,
    message: `已更新 ${quoteId} 的${field === 'qty' ? '供给数量' : '单价'}`,
  };
}

/**
 * Open the next round, applying queued late withdrawals and supply edits.
 * Also archives a compact summary of the round just cleared.
 */
export function nextRound(state) {
  if (!state.frozen) throw new MarketError('本轮尚未开始清算，无需开启新一轮');
  const marketDef = deepCopy(state.marketDef);
  for (const id of state.pendingWithdrawals) {
    marketDef.buyQuotes = marketDef.buyQuotes.filter((q) => q.id !== id);
    marketDef.sellQuotes = marketDef.sellQuotes.filter((q) => q.id !== id);
  }
  for (const change of state.pendingSupplyChanges) {
    const target = marketDef.sellQuotes.find((q) => q.id === change.quoteId);
    if (target) target[change.field] = change.newValue;
  }
  const archived = {
    round: state.round,
    startedAt: state.clearingStartedAt,
    status: state.settlement?.status ?? 'none',
    welfare: state.settlement?.main?.welfare ?? null,
    winnerIds: state.settlement?.settlements?.buys.map((b) => b.quoteId) ?? [],
    appliedChanges: [
      ...state.pendingWithdrawals.map((id) => `撤回 ${id}`),
      ...state.pendingSupplyChanges.map(
        (c) => `${c.quoteId} ${c.field === 'qty' ? '数量' : '单价'}→${c.newValue}`,
      ),
    ],
  };
  return {
    ...state,
    round: state.round + 1,
    marketDef,
    frozen: false,
    clearingStartedAt: null,
    settlement: null,
    pendingWithdrawals: [],
    pendingSupplyChanges: [],
    history: [...state.history, archived],
  };
}

/**
 * Queue a hypothetical supply modification as a pending change for the next
 * round. The current round must be frozen: a comparison only makes sense
 * against a cleared round, and the cleared round itself must stay untouched.
 */
export function adoptSupplyAsNextRound(state, change) {
  if (!state.frozen) throw new MarketError('请先开始本轮清算，再采纳新的供给轮次');
  const target = state.marketDef.sellQuotes.find((q) => q.id === change.quoteId);
  if (!target) throw new MarketError(`供给分段 ${change.quoteId} 已不在报价中`);
  const entry = {
    quoteId: change.quoteId,
    field: change.field,
    newValue: change.newValue,
    adoptedFromComparison: true,
  };
  const exists = state.pendingSupplyChanges.some(
    (c) => c.quoteId === entry.quoteId && c.field === entry.field,
  );
  return {
    ...state,
    pendingSupplyChanges: exists
      ? state.pendingSupplyChanges.map((c) =>
          c.quoteId === entry.quoteId && c.field === entry.field ? entry : c,
        )
      : [...state.pendingSupplyChanges, entry],
  };
}

/** Append a new buy quote (draft round only). */
export function addBuyQuote(state, quote) {
  if (state.frozen) throw new MarketError('本轮报价已冻结；请在下一轮录入新报价');
  const marketDef = deepCopy(state.marketDef);
  const bidderLabel = (quote.bidderName || '').trim();
  let bidderId = quote.bidderId;
  if (!bidderId) {
    if (!bidderLabel) throw new MarketError('请选择买方或输入新买方名称');
    const existing = marketDef.bidders.find((b) => b.name === bidderLabel && b.side === 'buy');
    if (existing) {
      bidderId = existing.id;
    } else {
      bidderId = `b${marketDef.bidders.filter((b) => b.side === 'buy').length + 1}-${Date.now().toString(36).slice(-3)}`;
      marketDef.bidders.push({
        id: bidderId,
        name: bidderLabel,
        side: 'buy',
        budget: quote.budget ?? 500,
      });
    }
  }
  const atoms = (quote.atoms || []).filter((a) => Number(a.qty) > 0);
  if (atoms.length === 0) throw new MarketError('至少选择一个品种及数量');
  const itemIds = new Set(marketDef.items.map((i) => i.id));
  for (const atom of atoms) {
    if (!itemIds.has(atom.itemId)) throw new MarketError(`未知品种 ${atom.itemId}`);
    if (!Number.isInteger(Number(atom.qty)) || Number(atom.qty) < 1) {
      throw new MarketError('品种数量必须是正整数');
    }
  }
  if (!Number.isInteger(Number(quote.value)) || Number(quote.value) < 1) {
    throw new MarketError('申报价值必须是正整数');
  }
  const id = quote.id?.trim() || `Q-${900 + marketDef.buyQuotes.length + 1}`;
  if (marketDef.buyQuotes.some((q) => q.id === id) || marketDef.sellQuotes.some((q) => q.id === id)) {
    throw new MarketError(`报价编号 ${id} 已存在`);
  }
  marketDef.buyQuotes.push({
    id,
    bidderId,
    atoms: atoms.map((a) => ({ itemId: a.itemId, qty: Number(a.qty) })),
    value: Number(quote.value),
    altGroup: quote.altGroup?.trim() || null,
    note: quote.note?.trim() || '页面录入',
  });
  return { state: { ...state, marketDef }, message: `已录入买方报价 ${id}` };
}

/** Append a new supply segment (draft round only). */
export function addSellQuote(state, quote) {
  if (state.frozen) throw new MarketError('本轮报价已冻结；请在下一轮录入新报价');
  const marketDef = deepCopy(state.marketDef);
  const sellerName = (quote.bidderName || '').trim();
  let bidderId = quote.bidderId;
  if (!bidderId) {
    if (!sellerName) throw new MarketError('请选择卖方或输入新卖方名称');
    const existing = marketDef.bidders.find((b) => b.name === sellerName && b.side === 'sell');
    if (existing) {
      bidderId = existing.id;
    } else {
      bidderId = `s${marketDef.bidders.filter((b) => b.side === 'sell').length + 1}-${Date.now().toString(36).slice(-3)}`;
      marketDef.bidders.push({ id: bidderId, name: sellerName, side: 'sell' });
    }
  }
  if (!marketDef.items.some((i) => i.id === quote.itemId)) {
    throw new MarketError(`未知品种 ${quote.itemId}`);
  }
  if (!Number.isInteger(Number(quote.qty)) || Number(quote.qty) < 1) {
    throw new MarketError('供给数量必须是正整数');
  }
  if (!Number.isInteger(Number(quote.unitPrice)) || Number(quote.unitPrice) < 1) {
    throw new MarketError('单价必须是正整数');
  }
  const id = quote.id?.trim() || `S-${900 + marketDef.sellQuotes.length + 1}`;
  if (marketDef.buyQuotes.some((q) => q.id === id) || marketDef.sellQuotes.some((q) => q.id === id)) {
    throw new MarketError(`报价编号 ${id} 已存在`);
  }
  marketDef.sellQuotes.push({
    id,
    bidderId,
    itemId: quote.itemId,
    qty: Number(quote.qty),
    unitPrice: Number(quote.unitPrice),
    note: quote.note?.trim() || '页面录入',
  });
  return { state: { ...state, marketDef }, message: `已录入供给分段 ${id}` };
}
