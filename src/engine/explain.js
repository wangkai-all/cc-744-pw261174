/**
 * Plain-language explanation for every quote: why a winning quote was
 * accepted, and what would happen if a rejected buy quote had to be accepted.
 *
 * The "treated" solve pins the quote into the allocation (requiredBuyIds).
 * If the treated welfare is no better than the free optimum, the free optimum
 * is still reachable with the quote accepted, so the quote was weakly
 * dominated rather than infeasible.
 */

import { buildMarket } from './market.js';
import { NodeBudget, computeSettlement, solveAllocation, cheapestProcurement, supplyIndexFor } from './solver.js';

function demandMapOf(quotes) {
  const demand = new Map();
  for (const quote of quotes) {
    for (const atom of quote.atoms) demand.set(atom.itemId, (demand.get(atom.itemId) || 0) + atom.qty);
  }
  return demand;
}

function formatDemand(market, demand) {
  const parts = [];
  for (const [itemId, qty] of demand) {
    if (!qty) continue;
    parts.push(`${market.itemById.get(itemId)?.name || itemId} × ${qty}`);
  }
  return parts.length ? parts.join(' + ') : '∅';
}

function supplyDownstream(market) {
  const byItem = supplyIndexFor(market.sellQuotes);
  const totals = new Map();
  for (const [itemId, offers] of byItem) {
    totals.set(itemId, offers.reduce((sum, offer) => sum + offer.qty, 0));
  }
  return { byItem, totals };
}

/**
 * @param {object} market
 * @param {object} settlementResult result of computeSettlement(market)
 * @param {string} quoteId
 * @param {{nodeLimit?:number}} options
 */
export function explainQuote(market, settlementResult, quoteId, options = {}) {
  const quote = market.quoteById.get(quoteId);
  if (!quote) throw new Error(`未知报价 ${quoteId}`);
  const nodeLimit = options.nodeLimit ?? settlementResult.nodes.limit;
  const explanation = {
    quoteId,
    side: quote.side,
    bidderName: market.bidderById.get(quote.bidderId)?.name || quote.bidderId,
    status: 'unknown',
    reasons: [],
    blocking: null,
    counterfactual: null,
    computedAt: new Date().toISOString(),
  };

  if (!settlementResult.settlements) {
    explanation.status = 'unavailable';
    explanation.reasons.push({
      kind: 'no-settlement',
      text: `当前轮次没有可用的结算单（${settlementResult.status}），无法给出接受原因。`,
    });
    return explanation;
  }

  const s = settlementResult.settlements;
  const winnerIds = new Set(s.buys.map((b) => b.quoteId));

  if (quote.side === 'buy') {
    if (winnerIds.has(quote.id)) {
      explanation.status = 'accepted';
      explanation.reasons.push({
        kind: 'welfare',
        text: `接受该报价使最优福利从 W(−${quote.id}) = ${s.buyPayments.find((p) => p.quoteId === quote.id)?.counterfactual.welfare ?? '?'} 提升到 W = ${s.welfare}。`,
      });
      if (quote.value > 0) {
        const pay = s.buyPayments.find((p) => p.quoteId === quote.id);
        if (pay) {
          explanation.reasons.push({
            kind: 'value',
            text: `申报价值 ${quote.value}；机制对其收取 ${pay.payment}（不超过申报价值 ${pay.value}）。`,
          });
        }
      }
      const atoms = quote.atoms
        .map((atom) => `${market.itemById.get(atom.itemId)?.name || atom.itemId} × ${atom.qty}`)
        .join(' + ');
      explanation.reasons.push({
        kind: 'bundle',
        text: `需求组合（必须整体获得）：${atoms}；卖方分段按单价从低到高拆供满足。`,
      });
      if (quote.altGroup) {
        const siblings = market.buyQuotes.filter((q) => q.altGroup === quote.altGroup && q.id !== quote.id);
        explanation.reasons.push({
          kind: 'alternative',
          text:
            siblings.length > 0
              ? `与 ${siblings.map((q) => q.id).join('、')} 同属替代组「${quote.altGroup}」，本方案福利更高，替代方案未被选中。`
              : `属于替代组「${quote.altGroup}」。`,
        });
      }
      return explanation;
    }

    // Rejected buy quote: force it in.
    explanation.status = 'rejected';
    const budget = new NodeBudget(nodeLimit);
    const treated = solveAllocation(market, { budget, requiredBuyIds: [quote.id] });
    const free = settlementResult.main;
    let blockReason = null;
    const { byItem, totals } = supplyDownstream(market);

    // Diagnosis 1: supply.
    const ownDemand = new Map();
    for (const atom of quote.atoms) ownDemand.set(atom.itemId, atom.qty);
    const shortItems = [];
    for (const [itemId, qty] of ownDemand) {
      if ((totals.get(itemId) || 0) < qty) shortItems.push({ itemId, qty, available: totals.get(itemId) || 0 });
    }
    if (shortItems.length > 0) {
      blockReason = {
        kind: 'supply',
        text: `单品供给不足：${shortItems
          .map((x) => `${market.itemById.get(x.itemId)?.name || x.itemId} 需要 ${x.qty}、市场仅 ${x.available}`)
          .join('；')}。`,
      };
    }

    // Diagnosis 2: combined demand with the rest of the winner set.
    if (!blockReason) {
      const winnerBuys = s.buys.map((b) => market.quoteById.get(b.quoteId));
      const combined = demandMapOf([...winnerBuys, quote]);
      const procurement = cheapestProcurement(combined, byItem);
      if (!procurement.feasible) {
        const shortage = [...combined.entries()]
          .filter(([itemId, qty]) => (totals.get(itemId) || 0) < qty)
          .map(([itemId, qty]) => `${market.itemById.get(itemId)?.name || itemId} 需 ${qty}、供给 ${totals.get(itemId) || 0}`);
        blockReason = {
          kind: 'joint-supply',
          text: `与当前赢家组合后供给不足：${shortage.join('；') || '联合需求超过分段供给'}。`,
        };
      } else {
        // Diagnosis 3: budget with the same bidder's other accepted quotes.
        const sameBidder = winnerBuys.filter((q) => q.bidderId === quote.bidderId);
        const bidder = market.bidderById.get(quote.bidderId);
        const spend = sameBidder.reduce((sum, q) => sum + q.value, 0) + quote.value;
        if (bidder && spend > (bidder.budget ?? Number.MAX_SAFE_INTEGER)) {
          blockReason = {
            kind: 'budget',
            text: `预算不足：同买方已成交报价申报值合计 ${spend - quote.value}，加上本报价 ${quote.value} 达到 ${spend}，超过预算 ${bidder.budget}。`,
          };
        }
      }
    }

    // Diagnosis 4: alternative group.
    if (!blockReason && quote.altGroup) {
      const clash = s.buys.find((b) => {
        const other = market.quoteById.get(b.quoteId);
        return other.altGroup === quote.altGroup;
      });
      if (clash) {
        blockReason = {
          kind: 'alternative',
          text: `替代组冲突：同一买方的 ${clash.quoteId} 已被选中，组内方案互斥。`,
        };
      }
    }

    // Diagnosis 5: welfare / outbid.
    if (!blockReason) {
      if (treated.requiredInfeasible) {
        blockReason = {
          kind: 'combined-infeasible',
          text: '强制接受该报价后，与供给、预算或互斥组联合不可行。',
        };
      } else if (treated.bestWelfare < free.welfare) {
        blockReason = {
          kind: 'outbid',
          text: `强制接受后最优福利降为 ${treated.bestWelfare}，低于现状 W = ${free.welfare}（差额 ${free.welfare - treated.bestWelfare}）。虽然可行，但不是福利最优分配。`,
        };
      } else if (treated.bestWelfare === free.welfare) {
        blockReason = {
          kind: 'tie-lost',
          text: `强制接受后福利不变（${treated.bestWelfare}），但该配置申报买方价值 ${treated.winner?.buyValue ?? 0} 不高于当前赢家 ${free.winner?.buyValue ?? 0}，按“申报价值 → 报价编号”决胜规则未入选。`,
        };
      } else {
        blockReason = {
          kind: 'unexpected',
          text: `强制接受后福利 ${treated.bestWelfare} 高于现状 ${free.welfare}；这不应发生，请检查求解器。`,
        };
      }
    }

    explanation.blocking = blockReason;
    explanation.reasons.push({ kind: 'rejected', text: blockReason.text });
    explanation.reasons.push({
      kind: 'rule',
      text: '清算按“总福利 = 买方申报价值 − 最低采购成本”最大化；单条报价被接受的前提是它出现在最优分配中，而不是被单独比较成交价。',
    });
    explanation.counterfactual = {
      forcedWelfare: treated.requiredInfeasible ? null : treated.bestWelfare,
      forcedWinnerIds: treated.winner ? treated.winner.selectedIds : [],
      forcedInfeasible: treated.requiredInfeasible,
      freeWelfare: free.welfare,
      welfareDelta: treated.requiredInfeasible ? null : treated.bestWelfare - free.welfare,
      demandCombined: formatDemand(market, demandMapOf([quote])),
    };
    return explanation;
  }

  // Sell quote.
  const used = s.supplies.find((x) => x.quoteId === quote.id);
  if (used) {
    explanation.status = 'accepted';
    explanation.reasons.push({
      kind: 'supply',
      text: `接受该分段：${market.itemById.get(quote.itemId)?.name || quote.itemId} 取用 ${used.qty} / ${quote.qty} 件，单价 ${quote.unitPrice}，采购成本 ${used.cost}。`,
    });
    explanation.reasons.push({
      kind: 'cost',
      text: `该分段与其他同品种分段按单价升序竞争；最终成交数量取其排名靠前的部分。`,
    });
    explanation.reasons.push({
      kind: 'receipt',
      text: `供应商收款按反事实公式 W + 成交成本 − W(−${quote.id}) 计算，不等于成交价 ${quote.unitPrice} × ${used.qty}。`,
    });
    return explanation;
  }

  explanation.status = 'rejected';
  const sameItemSupply = market.sellQuotes
    .filter((q) => q.itemId === quote.itemId)
    .sort((a, b) => a.unitPrice - b.unitPrice || a.id.localeCompare(b.id));
  const cheaper = sameItemSupply.filter((q) => q.unitPrice < quote.unitPrice);
  const reasons = [];
  reasons.push({
    kind: 'supply',
    text: `本段未被取用。${market.itemById.get(quote.itemId)?.name || quote.itemId} 的供给按单价升序使用；同品种更便宜的分段${cheaper.length ? `（${cheaper.map((q) => `${q.id}@${q.unitPrice}`).join('、')}）` : '无'}已覆盖成交需求。`,
  });
  if (quote.unitPrice === Math.min(...sameItemSupply.map((q) => q.unitPrice))) {
    reasons.push({
      kind: 'cost',
      text: '该段属于同品种最低价档，但成交需求已被同价更早编号的分段填满；并列价格按分段编号取用。',
    });
  }
  explanation.reasons = reasons;
  return explanation;
}

/**
 * Build and explain a two-round supply comparison. Returns both settlements
 * and the differences in winners, total buyer value, procurement cost, welfare
 * and payments.
 */
export function compareSupply(marketDef, modification, options = {}) {
  const before = buildMarket(marketDef);
  const afterDef = JSON.parse(JSON.stringify(marketDef));
  const target = afterDef.sellQuotes.find((q) => q.id === modification.quoteId);
  if (!target) throw new Error(`供给对比找不回报价 ${modification.quoteId}`);
  const field = modification.field || 'qty';
  if (!['qty', 'unitPrice'].includes(field)) throw new Error(`不支持的供给字段 ${field}`);
  const previousValue = target[field];
  target[field] = modification.newValue;

  const run = (m) =>
    computeSettlement(m, {
      nodeLimit: options.nodeLimit,
      faultInject: options.faultInject,
    });

  const resultBefore = run(before);
  const resultAfter = run(buildMarket(afterDef));

  const diff = [];
  const ids = new Set([
    ...(resultBefore.settlements?.buys || []).map((b) => b.quoteId),
    ...(resultAfter.settlements?.buys || []).map((b) => b.quoteId),
  ]);
  for (const id of [...ids].sort()) {
    const a = (resultBefore.settlements?.buys || []).some((b) => b.quoteId === id);
    const b = (resultAfter.settlements?.buys || []).some((x) => x.quoteId === id);
    if (a !== b) diff.push({ quoteId: id, before: a, after: b });
  }

  const summary = (r) => ({
    status: r.status,
    welfare: r.main?.welfare ?? null,
    totalBuyerValue: r.settlements?.totalBuyerValue ?? null,
    procurementCost: r.settlements?.procurementCost ?? null,
    totalBuyerPaid: r.settlements?.totalBuyerPaid ?? null,
    totalSupplierReceived: r.settlements?.totalSupplierReceived ?? null,
    gap: r.settlements?.gap ?? null,
    winnerIds: r.settlements?.buys.map((x) => x.quoteId) ?? [],
    nodes: r.nodes,
    durationMs: r.durationMs,
    error: r.error,
  });

  return {
    modification: { ...modification, field, previousValue, newValue: modification.newValue },
    before: summary(resultBefore),
    after: summary(resultAfter),
    diff,
    resultBefore,
    resultAfter,
  };
}
