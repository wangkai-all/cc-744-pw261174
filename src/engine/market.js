/**
 * Market primitives for the multi-item clearing desk.
 *
 * A market is a set of items, bidders and quotes:
 *   - buy quote: one buyer (bidder) demands an exact bundle of items and
 *     states the maximum total value it is worth to them.
 *   - sell quote: one supplier offers a *segment*: up to `qty` units of a
 *     single item at `unitPrice` per unit. A supplier may submit several
 *     segments (a piecewise supply curve). Segments may be partially used.
 *
 * All quantities and money amounts are integers. Money is a fictional unit.
 */

export class MarketError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MarketError';
  }
}

export const MAX_BUY_QUOTES = 16;

function cmpId(a, b) {
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function assertInt(value, label, { min = 1 } = {}) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min) {
    throw new MarketError(`${label} 必须是大于等于 ${min} 的整数`);
  }
}

function assertString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MarketError(`${label} 不能为空`);
  }
}

/**
 * Build a normalized, validated market.
 * @param {{items:Array, bidders:Array, buyQuotes:Array, sellQuotes:Array}} input
 */
export function buildMarket(input) {
  const items = (input.items || []).map((item) => {
    assertString(item.id, '品种编号');
    assertString(item.name, '品种名称');
    return {
      id: item.id,
      name: item.name,
      unit: item.unit || '件',
      desc: item.desc || '',
    };
  });
  if (items.length === 0) throw new MarketError('市场至少需要一个品种');
  const itemIds = new Set();
  for (const item of items) {
    if (itemIds.has(item.id)) throw new MarketError(`重复的品种编号：${item.id}`);
    itemIds.add(item.id);
  }

  const bidders = (input.bidders || []).map((bidder) => {
    assertString(bidder.id, '交易方编号');
    assertString(bidder.name, '交易方名称');
    if (bidder.side !== 'buy' && bidder.side !== 'sell') {
      throw new MarketError(`交易方 ${bidder.id} 的 side 必须是 buy 或 sell`);
    }
    const out = { id: bidder.id, name: bidder.name, side: bidder.side };
    if (bidder.side === 'buy') {
      if (bidder.budget !== undefined) {
        assertInt(bidder.budget, `买方 ${bidder.name} 的预算`);
        out.budget = bidder.budget;
      } else {
        out.budget = Number.MAX_SAFE_INTEGER;
      }
    }
    return out;
  });
  const bidderById = new Map();
  for (const bidder of bidders) {
    if (bidderById.has(bidder.id)) throw new MarketError(`重复的交易方编号：${bidder.id}`);
    bidderById.set(bidder.id, bidder);
  }

  const buyQuotes = (input.buyQuotes || []).map((quote) => {
    assertString(quote.id, '报价编号');
    assertString(quote.bidderId, '报价的买方');
    const bidder = bidderById.get(quote.bidderId);
    if (!bidder) throw new MarketError(`报价 ${quote.id} 引用了未知买方 ${quote.bidderId}`);
    if (bidder.side !== 'buy') throw new MarketError(`报价 ${quote.id} 的买方 ${quote.bidderId} 不是买方`);
    if (!Array.isArray(quote.atoms) || quote.atoms.length === 0) {
      throw new MarketError(`报价 ${quote.id} 至少需要一个品种`);
    }
    const merged = new Map();
    for (const atom of quote.atoms) {
      if (!itemIds.has(atom.itemId)) {
        throw new MarketError(`报价 ${quote.id} 引用了未知品种 ${atom.itemId}`);
      }
      assertInt(atom.qty, `报价 ${quote.id} 的 ${atom.itemId} 数量`);
      merged.set(atom.itemId, (merged.get(atom.itemId) || 0) + atom.qty);
    }
    assertInt(quote.value, `报价 ${quote.id} 的价值`);
    let altGroup = null;
    if (quote.altGroup !== undefined && quote.altGroup !== null) {
      assertString(quote.altGroup, `报价 ${quote.id} 的替代组`);
      altGroup = quote.altGroup;
    }
    return {
      id: quote.id,
      bidderId: quote.bidderId,
      side: 'buy',
      atoms: [...merged.entries()].map(([itemId, qty]) => ({ itemId, qty })),
      value: quote.value,
      altGroup,
      note: quote.note || '',
    };
  });

  const sellQuotes = (input.sellQuotes || []).map((quote) => {
    assertString(quote.id, '报价编号');
    assertString(quote.bidderId, '报价的卖方');
    const bidder = bidderById.get(quote.bidderId);
    if (!bidder) throw new MarketError(`报价 ${quote.id} 引用了未知卖方 ${quote.bidderId}`);
    if (bidder.side !== 'sell') throw new MarketError(`报价 ${quote.id} 的卖方 ${quote.bidderId} 不是卖方`);
    if (!itemIds.has(quote.itemId)) throw new MarketError(`报价 ${quote.id} 引用了未知品种 ${quote.itemId}`);
    assertInt(quote.qty, `报价 ${quote.id} 的数量`);
    assertInt(quote.unitPrice, `报价 ${quote.id} 的单价`);
    return {
      id: quote.id,
      bidderId: quote.bidderId,
      side: 'sell',
      itemId: quote.itemId,
      qty: quote.qty,
      unitPrice: quote.unitPrice,
      note: quote.note || '',
    };
  });

  if (buyQuotes.length > MAX_BUY_QUOTES) {
    throw new MarketError(`买方报价 ${buyQuotes.length} 条，超过完全枚举上限 ${MAX_BUY_QUOTES} 条`);
  }

  // An alternative group must belong to exactly one buyer.
  const groupOwner = new Map();
  for (const quote of buyQuotes) {
    if (!quote.altGroup) continue;
    const owner = groupOwner.get(quote.altGroup);
    if (owner && owner !== quote.bidderId) {
      throw new MarketError(`替代组 ${quote.altGroup} 同时属于 ${owner} 和 ${quote.bidderId}`);
    }
    groupOwner.set(quote.altGroup, quote.bidderId);
  }

  const allIds = new Set();
  for (const quote of [...buyQuotes, ...sellQuotes]) {
    if (allIds.has(quote.id)) throw new MarketError(`重复的报价编号：${quote.id}`);
    allIds.add(quote.id);
  }

  buyQuotes.sort((a, b) => cmpId(a.id, b.id));
  sellQuotes.sort((a, b) => cmpId(a.id, b.id));

  return {
    items,
    bidders,
    buyQuotes,
    sellQuotes,
    itemById: new Map(items.map((item) => [item.id, item])),
    bidderById,
    quoteById: new Map([...buyQuotes, ...sellQuotes].map((quote) => [quote.id, quote])),
  };
}

/** Demand vector (Map itemId -> units) of a list of buy quotes. */
export function demandOfBuyQuotes(quotes) {
  const demand = new Map();
  for (const quote of quotes) {
    for (const atom of quote.atoms) {
      demand.set(atom.itemId, (demand.get(atom.itemId) || 0) + atom.qty);
    }
  }
  return demand;
}

export { cmpId };
