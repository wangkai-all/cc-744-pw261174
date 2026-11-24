import { buildMarket } from '../engine/market.js';
import { computeSettlement, MECHANISMS, getMechanism } from '../engine/solver.js';
import { getScenario, SCENARIOS, SUPPLY_SHOCK } from '../data/scenarios.js';
import { explainQuote, compareSupply } from '../engine/explain.js';
import {
  createRoundState,
  startClearing,
  requestWithdrawal,
  requestSupplyChange,
  nextRound,
  adoptSupplyAsNextRound,
  addBuyQuote,
  addSellQuote,
} from '../engine/rounds.js';
import { bruteForceVerification } from '../engine/verify.js';
import { h, mount, clear, fmt, signed, itemPill, itemColor, download, esc } from './dom.js';
import { openDrawer, openModal, toast, closeOverlay } from './overlays.js';

/* ------------------------------------------------------------------ state */

const state = {
  scenarioId: 'base',
  scenario: null,
  round: null,
  selectedQuoteId: null,
  mechanismId: 'vcg',
  nodeLimit: null,
  faultInject: null,
  compareMod: { ...SUPPLY_SHOCK.base },
  compareResult: null,
  brute: null,
  activeSection: 'outcome',
  entryOpen: false,
};

const els = {
  nav: document.getElementById('scenario-nav'),
  sidebar: document.getElementById('sidebar'),
  content: document.getElementById('content'),
  roundPill: document.getElementById('round-pill'),
  theme: document.getElementById('theme-toggle'),
};

/* --------------------------------------------------------------- bootstrap */

function loadScenario(id, { keepRound = false } = {}) {
  state.scenarioId = id;
  state.scenario = getScenario(id);
  state.round = createRoundState(state.scenario.market, { nodeLimit: state.scenario.nodeLimit });
  state.nodeLimit = state.scenario.nodeLimit;
  state.mechanismId = 'vcg';
  state.faultInject = null;
  state.selectedQuoteId = null;
  state.compareResult = null;
  state.brute = null;
  state.entryOpen = false;
  state.compareMod = { ...SUPPLY_SHOCK.base };
  renderAll();
}

function marketNow() {
  return buildMarket(state.round.marketDef);
}

function settlementNow() {
  return state.round.settlement;
}

/* ------------------------------------------------------------------ render */

function renderAll() {
  renderNav();
  renderSidebar();
  renderContent();
  renderRoundPill();
}

function renderRoundPill() {
  const frozen = state.round.frozen;
  els.roundPill.textContent = `第 ${state.round.round} 轮 · ${frozen ? '已冻结并清算' : '草稿（可编辑）'}`;
  els.roundPill.classList.toggle('frozen', frozen);
}

function renderNav() {
  mount(
    els.nav,
    SCENARIOS.map((sc) =>
      h(
        'button',
        {
          class: 'scenario-btn',
          type: 'button',
          'aria-current': String(sc.id === state.scenarioId),
          title: sc.tagline,
          onclick: () => {
            if (sc.id === state.scenarioId) return;
            loadScenario(sc.id);
            toast(`已切换到场景「${sc.name}」`);
          },
        },
        sc.name,
      ),
    ),
  );
}

/* ----------------------------------------------------------------- sidebar */

const ADVANCED_OPEN = { value: false };

function renderSidebar() {
  const s = state.scenario;
  const round = state.round;
  const frozen = round.frozen;
  const settlement = round.settlement;
  const market = marketNow();

  const readiness = buildReadiness(market, settlement);

  const side = h(
    'div',
    { class: 'stack', style: { gap: '14px' } },

    // clearing control
    h(
      'section',
      { class: 'card side-card' },
      h(
        'div',
        { class: 'card-body stack' },
        h('div', { class: 'row spread' }, h('h3', null, '清算控制')),
        h(
          'div',
          { class: 'round-actions' },
          h(
            'button',
            {
              class: 'btn btn-primary btn-block',
              type: 'button',
              disabled: frozen,
              onclick: () => doStartClearing(),
            },
            frozen ? '本轮已清算（报价冻结）' : '冻结报价并开始清算',
          ),
          h(
            'button',
            {
              class: 'btn btn-block',
              type: 'button',
              disabled: !frozen,
              onclick: () => doNextRound(),
            },
            round.pendingWithdrawals.length + round.pendingSupplyChanges.length > 0
              ? `开启第 ${round.round + 1} 轮（应用 ${round.pendingWithdrawals.length + round.pendingSupplyChanges.length} 项变更）`
              : `开启第 ${round.round + 1} 轮`,
          ),
        ),
        h(
          'p',
          { class: 'side-note' },
          frozen
            ? '报价已冻结。此时撤单或改供给不会影响本轮，只会进入下一轮的待生效清单。'
            : '草稿轮：可直接撤回报价、修改供给；开始清算后报价冻结。',
        ),
        pendingBlock(round),
        freezeLog(round),
      ),
    ),

    // readiness
    h(
      'section',
      { class: 'card side-card' },
      h(
        'div',
        { class: 'card-body stack' },
        h('h3', null, '出清前检查'),
        h(
          'div',
          { class: 'readiness' },
          readiness.map((item) =>
            h(
              'div',
              { class: `ready-item ${item.state}` },
              h('span', { class: 'mark', 'aria-hidden': 'true' }, item.state === 'bad' ? '✕' : item.state === 'warn' ? '!' : '✓'),
              h('span', { class: 'txt' }, h('strong', null, item.title), ' · ', item.detail),
            ),
          ),
        ),
      ),
    ),

    // parameters
    h(
      'section',
      { class: 'card side-card' },
      h(
        'div',
        { class: 'card-body stack' },
        h('h3', null, '求解参数'),
        h(
          'div',
          { class: 'field' },
          h('label', { for: 'mechanism-select' }, '支付机制'),
          h(
            'select',
            {
              id: 'mechanism-select',
              disabled: frozen,
              onchange: (event) => {
                state.mechanismId = event.target.value;
                renderSidebar();
              },
            },
            Object.values(MECHANISMS).map((m) =>
              h('option', { value: m.id, selected: m.id === state.mechanismId }, m.name),
            ),
          ),
        ),
        h('p', { class: 'xsmall muted' }, getMechanism(state.mechanismId).description),
        h(
          'div',
          { class: 'field' },
          h('label', { for: 'node-limit' }, '共享枚举节点预算'),
          h('input', {
            id: 'node-limit',
            type: 'number',
            min: '1000',
            step: '1000',
            value: String(state.nodeLimit),
            disabled: frozen,
            onchange: (event) => {
              const value = Number(event.target.value);
              if (!Number.isInteger(value) || value < 1000) {
                toast('节点预算至少 1000 的整数', 'bad');
                event.target.value = String(state.nodeLimit);
                return;
              }
              state.nodeLimit = value;
              renderSidebar();
            },
          }),
        ),
        h(
          'details',
          { class: 'disclose' },
          h('summary', null, '演练与诊断'),
          h(
            'div',
            { class: 'stack', style: { marginTop: '8px' } },
            h(
              'label',
              { class: 'row', style: { gap: '7px', fontSize: '12.5px', cursor: frozen ? 'not-allowed' : 'pointer' } },
              h('input', {
                type: 'checkbox',
                checked: Boolean(state.faultInject),
                disabled: frozen,
                onchange: (event) => {
                  state.faultInject = event.target.checked ? { at: 2, reason: '演练：反事实子任务失败' } : null;
                  renderSidebar();
                },
              }),
              h('span', null, '演练：让第 2 个反事实子任务失败'),
            ),
            h(
              'p',
              { class: 'xsmall muted' },
              '用于验证“子任务失败 → 整张结算单不发布”。节点预算耗尽也会触发同样的拒发路径。',
            ),
            h(
              'button',
              {
                class: 'btn btn-sm',
                type: 'button',
                onclick: () => showSelfCheck(),
              },
              '独立暴力校验当前轮',
            ),
          ),
        ),
      ),
    ),

    // round history
    round.history.length > 0
      ? h(
          'section',
          { class: 'card side-card' },
          h(
            'div',
            { class: 'card-body stack' },
            h('h3', null, '轮次记录'),
            ...round.history.map((entry) =>
              h(
                'div',
                { class: 'small ink2' },
                h(
                  'div',
                  { class: 'row spread' },
                  h('strong', null, `第 ${entry.round} 轮`),
                  h(
                    'span',
                    { class: `pill ${entry.status === 'ok' ? 'good' : entry.status === 'no-trade' ? '' : 'critical'}` },
                    statusLabel(entry.status),
                  ),
                ),
                h('div', { class: 'xsmall muted' }, `福利 ${fmt(entry.welfare)} · 赢家 ${entry.winnerIds.length} 条`),
                entry.appliedChanges.length
                  ? h('div', { class: 'xsmall muted' }, `本轮起生效：${entry.appliedChanges.join('；')}`)
                  : null,
              ),
            ),
          ),
        )
      : null,
  );

  mount(els.sidebar, side);
}

function pendingBlock(round) {
  const items = [
    ...round.pendingWithdrawals.map((id) => ({ kind: 'withdraw', id })),
    ...round.pendingSupplyChanges.map((c) => ({ kind: 'supply', id: c.quoteId, change: c })),
  ];
  if (items.length === 0) return null;
  return h(
    'div',
    { class: 'stack', style: { gap: '6px' } },
    h('h3', null, `第 ${round.round + 1} 轮待生效`),
    h(
      'div',
      { class: 'pending-list' },
      items.map((item) =>
        h(
          'div',
          { class: 'pending-item' },
          h(
            'span',
            { class: 'txt' },
            item.kind === 'withdraw'
              ? `撤回 ${item.id}`
              : `${item.id} ${item.change.field === 'qty' ? '数量' : '单价'} → ${item.change.newValue}`,
          ),
          h(
            'button',
            {
              type: 'button',
              'aria-label': `移除待生效项 ${item.id}`,
              onclick: () => {
                if (item.kind === 'withdraw') {
                  state.round.pendingWithdrawals = state.round.pendingWithdrawals.filter((x) => x !== item.id);
                } else {
                  state.round.pendingSupplyChanges = state.round.pendingSupplyChanges.filter((x) => x !== item.change);
                }
                renderAll();
                toast('已从待生效清单移除');
              },
            },
            '✕',
          ),
        ),
      ),
    ),
  );
}

function freezeLog(round) {
  if (!round.frozen) return null;
  return h(
    'p',
    { class: 'xsmall muted' },
    `冻结时间：${new Date(round.clearingStartedAt).toLocaleTimeString('zh-CN', { hour12: false })} · `,
    `节点用量 ${fmt(round.settlement?.nodes.used ?? 0)} / ${fmt(round.settlement?.nodes.limit ?? state.nodeLimit)}`,
  );
}

function buildReadiness(market, settlement) {
  const buyQuotes = market.buyQuotes.length;
  const sellQuotes = market.sellQuotes.length;
  const groups = new Map();
  for (const q of market.buyQuotes) {
    if (!q.altGroup) continue;
    groups.set(q.altGroup, (groups.get(q.altGroup) || 0) + 1);
  }
  const withBudget = market.bidders.filter((b) => b.side === 'buy' && b.budget !== Number.MAX_SAFE_INTEGER).length;
  const items = [
    {
      state: buyQuotes > 0 ? 'ok' : 'bad',
      title: `${buyQuotes} 条买方报价`,
      detail: buyQuotes <= 16 ? '在完全枚举上限内' : '超过 16 条',
    },
    {
      state: sellQuotes > 0 ? 'ok' : 'bad',
      title: `${sellQuotes} 个供给分段`,
      detail: '分段可部分使用',
    },
    {
      state: 'ok',
      title: `${groups.size} 个替代组`,
      detail: groups.size ? [...groups.entries()].map(([g, n]) => `${g}(${n})`).join('、') : '无',
    },
    {
      state: 'ok',
      title: `${withBudget} 位买方设了预算`,
      detail: '按申报价值占用',
    },
  ];
  if (settlement) {
    items.push({
      state: settlement.status === 'ok' ? 'ok' : settlement.status === 'no-trade' ? 'warn' : 'bad',
      title: `清算状态：${statusLabel(settlement.status)}`,
      detail:
        settlement.status === 'ok'
          ? '已发布完整结算单'
          : settlement.status === 'no-trade'
            ? '无成交，无支付'
            : '结算单未发布（部分结果不可用）',
    });
  }
  return items;
}

function statusLabel(status) {
  return {
    ok: '完整结算',
    'no-trade': '无成交',
    timeout: '超时·未发布',
    failed: '失败·未发布',
    none: '未清算',
  }[status] || status;
}

/* ------------------------------------------------------------- interactions */

function doStartClearing() {
  try {
    state.round = startClearing(state.round, {
      nodeLimit: state.nodeLimit,
      faultInject: state.faultInject,
      mechanism: state.mechanismId,
    });
    const settlement = state.round.settlement;
    if (settlement.status === 'ok') toast('清算完成，结算单已发布', 'good');
    else if (settlement.status === 'no-trade') toast('清算完成：没有可盈利的成交');
    else toast(`清算未完成：${settlement.error?.message || '未知错误'}；结算单未发布`, 'bad');
    renderAll();
  } catch (error) {
    toast(error.message, 'bad');
  }
}

function doNextRound() {
  try {
    state.round = nextRound(state.round);
    state.compareResult = null;
    state.brute = null;
    toast(`已开启第 ${state.round.round} 轮，上一轮报价已归档`);
    renderAll();
  } catch (error) {
    toast(error.message, 'bad');
  }
}

function withdrawQuote(quoteId) {
  try {
    const out = requestWithdrawal(state.round, quoteId);
    state.round = out.state;
    renderAll();
    toast(out.message, out.applied ? 'good' : '');
    if (!out.applied) closeOverlay();
  } catch (error) {
    toast(error.message, 'bad');
  }
}

function editSupply(quoteId, field, value) {
  try {
    const out = requestSupplyChange(state.round, {
      quoteId,
      field,
      newValue: value,
      value,
    });
    state.round = out.state;
    renderAll();
    toast(out.message, out.applied ? 'good' : '');
  } catch (error) {
    toast(error.message, 'bad');
  }
}

function showSelfCheck() {
  try {
    const market = marketNow();
    const brute = bruteForceVerification(state.round.marketDef, { subsetLimit: 1 << 12 });
    state.brute = brute;
    const settlement = settlementNow();
    const solved = settlement?.main?.welfare ?? null;
    const match = solved !== null && solved === brute.bestWelfare;
    openModal({
      title: '独立暴力校验',
      subtitle: '另写一套不共享求解器代码的枚举，直接复查福利与分配',
      width: 'min(680px, 100%)',
      build: (close) => [
        h(
          'div',
          { class: `callout ${match ? 'good' : solved === null ? 'warn' : 'critical'}` },
          match
            ? `通过：暴力枚举最优福利 ${fmt(brute.bestWelfare)} 与求解器${settlement.status === 'ok' ? '结算单' : '主问题'}一致。`
            : solved === null
              ? `当前轮没有可比较的已发布结算（状态 ${statusLabel(settlement?.status || 'none')}）。暴力枚举最优福利为 ${fmt(brute.bestWelfare)}。`
              : `不一致：暴力枚举 ${fmt(brute.bestWelfare)}，求解器 ${fmt(solved)}。`,
        ),
        h(
          'div',
          { class: 'stack' },
          h('div', { class: 'kv' }, h('span', { class: 'k' }, '枚举可行子集数'), h('span', { class: 'v' }, fmt(brute.evaluated))),
          h('div', { class: 'kv' }, h('span', { class: 'k' }, '最优福利'), h('span', { class: 'v' }, fmt(brute.bestWelfare))),
          h(
            'div',
            { class: 'kv' },
            h('span', { class: 'k' }, '最优分配是否唯一'),
            h('span', { class: 'v' }, brute.isUnique ? '唯一' : `并列 ${brute.ties.length} 个`),
          ),
          h(
            'div',
            { class: 'kv' },
            h('span', { class: 'k' }, '最优分配'),
            h('span', { class: 'v mono' }, brute.best?.ids.join(', ') || '∅'),
          ),
          brute.ties.length > 1
            ? h(
                'div',
                { class: 'stack', style: { gap: '4px', marginTop: '6px' } },
                h('div', { class: 'small muted' }, '并列最优：'),
                ...brute.ties.map((t) =>
                  h('div', { class: 'formula' }, `${t.ids.join(', ') || '∅'} → 福利 ${fmt(t.welfare)}`),
                ),
              )
            : null,
        ),
        h(
          'div',
          { class: 'small muted' },
          '暴力枚举逐个子集重算“同品种分段按单价升序取用”的最低采购成本，并检查预算与替代组约束；' +
            '16 条买方报价即 65,536 个子集以内。',
        ),
        h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: close }, '关闭')),
      ],
    });
  } catch (error) {
    toast(error.message, 'bad');
  }
}

/* --------------------------------------------------------------- content */

function renderContent() {
  const scenario = state.scenario;
  const round = state.round;
  const settlement = round.settlement;
  const market = marketNow();

  const sections = [
    scenarioBanner(scenario),
    settlement ? outcomeSection(market, settlement) : draftSection(market),
    quotesSection(market, settlement),
    supplySection(market, settlement),
    compareSection(market),
    settlement ? validationSection(market, settlement) : null,
    h(
      'footer',
      { class: 'xsmall muted', style: { padding: '6px 2px 0' } },
      '所有订单、企业名称与金额均为虚构；清算点不连接任何真实资金账户。' +
        '求解在浏览器内完成，无外部请求。',
    ),
  ];

  mount(els.content, sections);
}

function scenarioBanner(scenario) {
  return h(
    'section',
    { class: 'scenario-banner' },
    h('span', { class: 'badge' }, '内置场景'),
    h(
      'div',
      null,
      h('h1', null, scenario.name),
      h('p', null, scenario.tagline),
      h('p', { class: 'xsmall muted', style: { marginTop: '5px' } }, scenario.note),
    ),
  );
}

function draftSection(market) {
  const groups = market.buyQuotes.length;
  return h(
    'section',
    { class: 'card', id: 'outcome' },
    h(
      'div',
      { class: 'card-head' },
      h(
        'div',
        null,
        h('h2', null, '尚未清算'),
        h('div', { class: 'sub' }, '报价处于草稿轮，可自由撤回或修改供给；点击“冻结报价并开始清算”生成结算单。'),
      ),
      h(
        'div',
        { class: 'head-right' },
        h('span', { class: 'pill' }, `${groups} 条买方报价`),
        h('span', { class: 'pill' }, `${market.sellQuotes.length} 个供给分段`),
      ),
    ),
    h(
      'div',
      { class: 'card-body stack' },
      h(
        'div',
        { class: 'empty-state' },
        h('div', { style: { fontSize: '15px', color: 'var(--ink)', marginBottom: '4px' } }, '等待清算'),
        h('div', null, '先浏览下方报价簿，或直接开始清算。'),
        h(
          'div',
          { style: { marginTop: '12px' } },
          h('button', { class: 'btn btn-primary', type: 'button', onclick: () => doStartClearing() }, '冻结报价并开始清算'),
        ),
      ),
    ),
  );
}

function outcomeSection(market, settlement) {
  if (settlement.status !== 'ok' && settlement.status !== 'no-trade') {
    return failureSection(settlement);
  }
  if (settlement.status === 'no-trade') {
    return h(
      'section',
      { class: 'card', id: 'outcome' },
      h(
        'div',
        { class: 'card-head' },
        h('div', null, h('h2', null, '清算结果：无成交'), h('div', { class: 'sub' }, '所有报价组合的最优福利为 0，系统不生成任何成交或支付条目。')),
        h('div', { class: 'head-right' }, h('span', { class: 'pill warn' }, '最优福利 0')),
      ),
      h(
        'div',
        { class: 'card-body stack' },
        h(
          'div',
          { class: 'callout' },
          '没有报价能在覆盖采购成本后仍带来正福利。结算单为空：0 位赢家、0 笔买方支付、0 笔卖方收款。',
        ),
        h(
          'div',
          { class: 'stat-row' },
          stat('最优福利', '0', { foot: '未产生交易剩余' }),
          stat('成交买方', '0', { foot: '无赢家' }),
          stat('采购成本', '0', { foot: '未动用供给' }),
          stat('资金缺口', '0', { foot: '无资金流动' }),
        ),
      ),
    );
  }

  const s = settlement.settlements;
  const gapKind = s.gap > 0 ? 'critical' : s.gap < 0 ? 'warn' : 'good';

  return h(
    'section',
    { class: 'card', id: 'outcome' },
    h(
      'div',
      { class: 'card-head' },
      h(
        'div',
        null,
        h('h2', null, '清算结果'),
        h(
          'div',
          { class: 'sub' },
          `第 ${state.round.round} 轮 · ${settlement.mechanism.name} · 用时 ${settlement.durationMs} ms · 节点 ${fmt(settlement.nodes.used)} / ${fmt(settlement.nodes.limit)}`,
        ),
      ),
      h(
        'div',
        { class: 'head-right' },
        settlement.main.tieCount > 1
          ? h('span', { class: 'pill warn', title: '存在并列最优分配，按既定决胜规则选择' }, `并列最优 ${settlement.main.tieCount} 个`)
          : null,
        h('span', { class: 'pill good' }, `校验 ${settlement.validation.ok ? '全部通过' : '未通过'}`),
        h(
          'button',
          { class: 'btn btn-sm', type: 'button', onclick: () => exportSettlement(market, settlement) },
          '导出结算 JSON',
        ),
      ),
    ),
    h(
      'div',
      { class: 'card-body stack', style: { gap: '16px' } },
      h(
        'div',
        { class: 'stat-row five' },
        stat('交易剩余（福利）', fmt(s.welfare), {
          hero: true,
          foot: `买方价值 ${fmt(s.totalBuyerValue)} − 采购成本 ${fmt(s.procurementCost)}`,
          id: 'stat-welfare',
        }),
        stat('买方支付合计', fmt(s.totalBuyerPaid), { foot: `${s.buyPayments.length} 位赢家` }),
        stat('卖方收款合计', fmt(s.totalSupplierReceived), { foot: `${s.supplierReceipts.length} 个供给分段` }),
        stat('资金缺口', signed(s.gap), {
          tone: s.gap > 0 ? 'neg' : s.gap < 0 ? '' : 'pos',
          foot: s.gap === 0 ? '预算恰好平衡' : s.gap > 0 ? '机制支出超出收入' : '机制形成盈余',
          id: 'stat-gap',
        }),
        stat('成交数量', fmt(s.supplies.reduce((sum, x) => sum + x.qty, 0)), { foot: `${s.buys.length} 条买方组合` }),
      ),

      h(
        'div',
        { class: `callout ${gapKind}` },
        h('strong', null, s.gap === 0 ? '预算平衡' : s.gap > 0 ? `资金缺口 ${fmt(s.gap)} 清算点，需外部补足` : `机制盈余 ${fmt(-s.gap)} 清算点`),
        h('div', { style: { marginTop: '3px' } }, s.gapMeaning, '。支付按反事实公式原样发布，未做任何“凑平”调整。'),
      ),

      gapVisual(s),

      h(
        'div',
        { class: 'row spread', style: { marginTop: '2px' } },
        h('h3', { style: { fontSize: '13.5px' } }, '成交明细'),
        h('span', { class: 'xsmall muted' }, '点击任意行查看该笔支付的反事实计算'),
      ),
      h('div', { class: 'table-hint' }, '表格可横向滑动查看全部列 →'),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'data' },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', null, '买方报价'),
              h('th', null, '成交组合（必须整组获得）'),
              h('th', { class: 'num' }, '申报价值'),
              h('th', { class: 'num' }, '接受后福利 W'),
              h('th', { class: 'num' }, '反事实 W(−b)'),
              h('th', { class: 'num' }, '支付'),
              h('th', { class: 'num' }, '买方剩余'),
              h('th', null, ''),
            ),
          ),
          h(
            'tbody',
            null,
            ...s.buys.map((buy, index) => {
              const pay = s.buyPayments.find((p) => p.quoteId === buy.quoteId);
              const q = market.quoteById.get(buy.quoteId);
              return h(
                'tr',
                {
                  class: 'winner',
                  style: { cursor: 'pointer' },
                  tabindex: '0',
                  role: 'button',
                  'aria-label': `查看 ${buy.quoteId} 的反事实支付`,
                  onclick: () => showPayment(buy.quoteId),
                  onkeydown: (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      showPayment(buy.quoteId);
                    }
                  },
                },
                h(
                  'td',
                  null,
                  h('div', { class: 'mono small' }, buy.quoteId),
                  h('div', { class: 'xsmall muted' }, market.bidderById.get(buy.bidderId)?.name),
                ),
                h(
                  'td',
                  null,
                  h(
                    'div',
                    { class: 'row', style: { gap: '4px' } },
                    q.atoms.map((atom) =>
                      h(
                        'span',
                        { class: 'pill item' },
                        h('span', { class: 'dot', style: { background: itemColor(atom.itemId, index) } }),
                        `${market.itemById.get(atom.itemId)?.name}×${atom.qty}`,
                      ),
                    ),
                  ),
                ),
                h('td', { class: 'num' }, fmt(buy.value)),
                h('td', { class: 'num' }, fmt(s.welfare)),
                h('td', { class: 'num muted' }, fmt(pay.counterfactual.welfare)),
                h('td', { class: 'num', style: { fontWeight: '600' } }, fmt(pay.payment)),
                h('td', { class: 'num', style: { color: 'var(--good-text)' } }, fmt(buy.value - pay.payment)),
                h('td', null, h('span', { class: 'btn-link' }, '反事实 ›')),
              );
            }),
          ),
        ),
      ),

      h(
        'div',
        { class: 'row spread', style: { marginTop: '4px' } },
        h('h3', { style: { fontSize: '13.5px' } }, '供给与卖方收款'),
        h('span', { class: 'xsmall muted' }, '收款 = W + 成交成本 − W(−s)，不是“单价 × 数量”'),
      ),
      h('div', { class: 'table-hint' }, '表格可横向滑动查看全部列 →'),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'data' },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', null, '供给分段'),
              h('th', null, '品种'),
              h('th', { class: 'num' }, '取用 / 可供'),
              h('th', { class: 'num' }, '单价'),
              h('th', { class: 'num' }, '成交成本'),
              h('th', { class: 'num' }, '反事实 W(−s)'),
              h('th', { class: 'num' }, '卖方收款'),
              h('th', null, ''),
            ),
          ),
          h(
            'tbody',
            null,
            ...s.supplies.map((sup) => {
              const rec = s.supplierReceipts.find((x) => x.quoteId === sup.quoteId);
              return h(
                'tr',
                {
                  class: 'winner',
                  style: { cursor: 'pointer' },
                  tabindex: '0',
                  role: 'button',
                  'aria-label': `查看 ${sup.quoteId} 的收款反事实`,
                  onclick: () => showPayment(sup.quoteId),
                  onkeydown: (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      showPayment(sup.quoteId);
                    }
                  },
                },
                h(
                  'td',
                  null,
                  h('div', { class: 'mono small' }, sup.quoteId),
                  h('div', { class: 'xsmall muted' }, market.bidderById.get(sup.bidderId)?.name),
                ),
                h('td', null, itemPill(market, sup.itemId)),
                h('td', { class: 'num' }, `${sup.qty} / ${sup.offeredQty}`),
                h('td', { class: 'num' }, fmt(sup.unitPrice)),
                h('td', { class: 'num' }, fmt(sup.cost)),
                h('td', { class: 'num muted' }, fmt(rec.counterfactual.welfare)),
                h('td', { class: 'num', style: { fontWeight: '600' } }, fmt(rec.receipt)),
                h('td', null, h('span', { class: 'btn-link' }, '反事实 ›')),
              );
            }),
          ),
        ),
      ),

      h(
        'details',
        { class: 'disclose' },
        h('summary', null, '为什么不能直接用最后一笔成交价 / 统一价？'),
        h(
          'p',
          { class: 'small ink2' },
          '多品种组合拍卖里，“最后一笔成交价”没有唯一含义：不同品种、不同分段、不同组合互相牵制，' +
            '单看某条成交报价会低估它对其他赢家的替代作用。本页对每个赢家报价单独撤除后重新求最优分配，' +
            '支付等于“撤除它造成的福利损失”，因此能体现替代品、组合与预算的相互影响。',
        ),
      ),
      tieDetail(s),
    ),
  );
}

function tieDetail(s) {
  if (!s.tie || s.tie.count <= 1) return null;
  return h(
    'div',
    { class: 'callout warn' },
    h('strong', null, `存在 ${s.tie.count} 个并列最优分配`),
    h('div', { class: 'small', style: { marginTop: '3px' } }, '按“福利 → 申报买方价值 → 报价编号字典序”选择；其余并列方案：'),
    ...s.tie.alternatives.map((alt) =>
      h(
        'div',
        { class: 'formula', style: { marginTop: '6px' } },
        `${alt.selectedIds.join(', ') || '∅'} → 买方价值 ${fmt(alt.buyValue)}，成本 ${fmt(alt.cost)}，福利 ${fmt(alt.buyValue - alt.cost)}`,
      ),
    ),
  );
}

function gapVisual(s) {
  const max = Math.max(s.totalBuyerPaid, s.totalSupplierReceived, 1);
  const bar = (label, value, color, note) =>
    h(
      'div',
      { class: 'stack', style: { gap: '3px' } },
      h(
        'div',
        { class: 'row spread xsmall' },
        h('span', { class: 'row', style: { gap: '5px' } }, h('span', { style: { width: '8px', height: '8px', borderRadius: '2px', background: color } }), label),
        h('span', { class: 'num ink2' }, `${fmt(value)}${note ? ` · ${note}` : ''}`),
      ),
      h(
        'div',
        { style: { height: '10px', background: 'var(--surface-2)', borderRadius: '3px', overflow: 'hidden', border: '1px solid var(--border)' } },
        h('div', { style: { width: `${(value / max) * 100}%`, height: '100%', background: color, borderRadius: '3px' } }),
      ),
    );
  return h(
    'div',
    { class: 'stack', style: { gap: '7px' } },
    bar('买方支付（流入机制）', s.totalBuyerPaid, 'var(--item-a)'),
    bar('卖方收款（机制流出）', s.totalSupplierReceived, 'var(--item-t)'),
  );
}

function failureSection(settlement) {
  const isTimeout = settlement.status === 'timeout';
  const done = settlement.counterfactualsDone ?? settlement.counterfactuals.filter((c) => c.status === 'ok').length;
  const total = settlement.counterfactualTotal || 0;
  return h(
    'section',
    { class: 'card', id: 'outcome' },
    h(
      'div',
      { class: 'card-head' },
      h(
        'div',
        null,
        h('h2', null, isTimeout ? '清算超时：结算单未发布' : '清算失败：结算单未发布'),
        h('div', { class: 'sub' }, '根据发布规则，任一反事实子任务失败时不得发布部分赢家的支付。'),
      ),
      h('div', { class: 'head-right' }, h('span', { class: 'pill critical' }, '无结算单')),
    ),
    h(
      'div',
      { class: 'card-body stack' },
      h(
        'div',
        { class: 'callout critical' },
        h('strong', null, settlement.error?.message || '未知错误'),
        h(
          'div',
          { class: 'small', style: { marginTop: '4px' } },
          `已完成反事实子任务 ${done} / ${total || '—'}；` +
            `节点预算 ${fmt(settlement.error?.limit ?? settlement.nodes.limit)}，已用 ${fmt(settlement.nodes.used)}。`,
        ),
      ),
      h(
        'div',
        { class: 'stat-row' },
        stat('主问题状态', settlement.mainSummary ? '已求解' : '未完成', {
          foot: settlement.mainSummary ? `最优福利 ${fmt(settlement.mainSummary.welfare)}` : '无',
        }),
        stat('反事实完成', `${done}${total ? ` / ${total}` : ''}`, { foot: '失败即拒发' }),
        stat('已发布支付', '0 笔', { foot: '不发布部分支付' }),
        stat('本轮赢家（未支付）', fmt(settlement.mainSummary?.winnerIds.length ?? 0), { foot: '仅在内存中' }),
      ),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'data' },
          h(
            'thead',
            null,
            h('tr', null, h('th', null, '序号'), h('th', null, '子任务'), h('th', null, '状态'), h('th', null, '说明')),
          ),
          h(
            'tbody',
            null,
            settlement.counterfactuals.length === 0
              ? h('tr', null, h('td', { colspan: '4', class: 'muted' }, '尚未开始任何反事实子任务'))
              : settlement.counterfactuals.map((cf) =>
                  h(
                    'tr',
                    null,
                    h('td', { class: 'num' }, cf.index),
                    h('td', null, cf.label),
                    h(
                      'td',
                      null,
                      h('span', { class: `pill ${cf.status === 'ok' ? 'good' : 'critical'}` }, cf.status === 'ok' ? '完成' : '失败'),
                    ),
                    h(
                      'td',
                      { class: 'small ink2' },
                      cf.status === 'ok' ? `W(−) = ${fmt(cf.welfare)}；赢家 ${cf.winnerIds.length} 条` : cf.error,
                    ),
                  ),
                ),
          ),
        ),
      ),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            class: 'btn btn-primary',
            type: 'button',
            onclick: () => {
              state.nodeLimit = Math.max(state.nodeLimit * 20, 1_400_000);
              toast(`节点预算已调至 ${fmt(state.nodeLimit)}，重新开始本轮清算`);
              state.round = { ...state.round, frozen: false, settlement: null };
              renderAll();
              doStartClearing();
            },
          },
          `将节点预算调至 ${fmt(Math.max(state.nodeLimit * 20, 1_400_000))} 并重算本轮`,
        ),
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: () => {
              state.round = { ...state.round, frozen: false, settlement: null };
              renderAll();
            },
          },
          '返回草稿轮（放弃本次清算）',
        ),
      ),
      h(
        'p',
        { class: 'xsmall muted' },
        '注意：重算本轮会解除冻结；在真实运营中，报价冻结与重算应有独立审计记录。',
      ),
    ),
  );
}

/* --------------------------------------------------------------- quotes */

function quotesSection(market, settlement) {
  return h(
    'section',
    { class: 'card', id: 'quotes' },
    h(
      'div',
      { class: 'card-head' },
      h(
        'div',
        null,
        h('h2', null, '报价簿'),
        h('div', { class: 'sub' }, '点击任意报价查看“为什么被接受 / 为什么未成交”，以及被强制接受时的反事实。'),
      ),
      h(
        'div',
        { class: 'head-right' },
        h('span', { class: 'pill', title: '报价冻结后不能改动' }, state.round.frozen ? '已冻结' : '可编辑'),
      ),
    ),
    h(
      'div',
      { class: 'card-body stack', style: { gap: '16px' } },
      h(
        'div',
        { class: 'row spread' },
        h('h3', { style: { fontSize: '13px' } }, '买方报价'),
        h('span', { class: 'xsmall muted' }, '整组获得；同买方可设替代组与预算'),
      ),
      h(
        'div',
        { class: 'quote-grid' },
        ...market.buyQuotes.map((quote) => buyQuoteCard(market, settlement, quote)),
      ),
      entryPanel(market),
      h('div', { style: { height: '2px' } }),
    ),
  );
}

/* ------------------------------------------------------------ quote entry */

function entryPanel(market) {
  const frozen = state.round.frozen;
  const body = frozen
    ? h(
        'div',
        { class: 'callout' },
        '本轮报价已冻结：新报价不能写入正在清算的轮次。点击左侧“开启下一轮”后可继续录入。',
      )
    : h(
        'div',
        { class: 'entry-tabs', id: 'entry-panel' },
        entryBuyForm(market),
        entrySellForm(market),
      );
  return h(
    'details',
    {
      class: 'disclose entry-disclose',
      open: state.entryOpen,
      // Keep the panel open across re-renders (e.g. after submitting a quote).
      ontoggle: (event) => {
        state.entryOpen = event.currentTarget.open;
      },
    },
    h('summary', null, '录入新报价（虚构）'),
    h('div', { class: 'stack', style: { marginTop: '8px' } }, body),
  );
}

function entryBuyForm(market) {
  const atoms = new Map(market.items.map((item) => [item.id, h('input', {
    type: 'number',
    min: '0',
    step: '1',
    value: '0',
    'aria-label': `${item.name} 数量`,
    style: { width: '74px' },
  })]));
  const bidderSelect = h(
    'select',
    { 'aria-label': '买方' },
    h('option', { value: '' }, '— 新买方 —'),
    market.bidders
      .filter((b) => b.side === 'buy')
      .map((b) => h('option', { value: b.id }, b.name)),
  );
  const newName = h('input', { type: 'text', placeholder: '新买方名称', 'aria-label': '新买方名称' });
  const budget = h('input', { type: 'number', min: '1', step: '1', value: '300', 'aria-label': '新买方预算' });
  const value = h('input', { type: 'number', min: '1', step: '1', value: '100', 'aria-label': '申报价值' });
  const altGroup = h('input', { type: 'text', placeholder: '可留空', 'aria-label': '替代组' });
  const note = h('input', { type: 'text', placeholder: '可选备注', 'aria-label': '备注' });

  const submit = () => {
    try {
      const chosen = bidderSelect.value;
      const out = addBuyQuote(state.round, {
        bidderId: chosen || undefined,
        bidderName: chosen ? undefined : newName.value,
        budget: Number(budget.value) || 300,
        atoms: market.items.map((item) => ({ itemId: item.id, qty: Number(atoms.get(item.id).value) || 0 })),
        value: Number(value.value),
        altGroup: altGroup.value,
        note: note.value,
      });
      state.round = out.state;
      state.selectedQuoteId = null;
      state.entryOpen = true;
      renderAll();
      toast(out.message, 'good');
    } catch (error) {
      toast(error.message, 'bad');
    }
  };

  return h(
    'div',
    { class: 'entry-form' },
    h('h4', null, '买方组合报价'),
    h(
      'div',
      { class: 'entry-grid' },
      h('label', { class: 'field' }, '买方', bidderSelect),
      h('label', { class: 'field' }, '或新买方', newName),
      h('label', { class: 'field' }, '新买方预算', budget),
      ...market.items.map((item) =>
        h('label', { class: 'field' }, `${item.name} 数量`, atoms.get(item.id)),
      ),
      h('label', { class: 'field' }, '申报价值', value),
      h('label', { class: 'field' }, '替代组', altGroup),
      h('label', { class: 'field' }, '备注', note),
    ),
    h(
      'div',
      { class: 'row', style: { marginTop: '8px' } },
      h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: submit }, '录入买方报价'),
      h('span', { class: 'xsmall muted' }, '数量为 0 的品种自动忽略；整组必须一起成交。'),
    ),
  );
}

function entrySellForm(market) {
  const sellerSelect = h(
    'select',
    { 'aria-label': '卖方' },
    h('option', { value: '' }, '— 新卖方 —'),
    market.bidders
      .filter((b) => b.side === 'sell')
      .map((b) => h('option', { value: b.id }, b.name)),
  );
  const newName = h('input', { type: 'text', placeholder: '新卖方名称', 'aria-label': '新卖方名称' });
  const itemSelect = h(
    'select',
    { 'aria-label': '品种' },
    market.items.map((item) => h('option', { value: item.id }, item.name)),
  );
  const qty = h('input', { type: 'number', min: '1', step: '1', value: '2', 'aria-label': '可供数量' });
  const price = h('input', { type: 'number', min: '1', step: '1', value: '50', 'aria-label': '单价' });

  const submit = () => {
    try {
      const chosen = sellerSelect.value;
      const out = addSellQuote(state.round, {
        bidderId: chosen || undefined,
        bidderName: chosen ? undefined : newName.value,
        itemId: itemSelect.value,
        qty: Number(qty.value),
        unitPrice: Number(price.value),
      });
      state.round = out.state;
      state.entryOpen = true;
      renderAll();
      toast(out.message, 'good');
    } catch (error) {
      toast(error.message, 'bad');
    }
  };

  return h(
    'div',
    { class: 'entry-form' },
    h('h4', null, '卖方分段供给'),
    h(
      'div',
      { class: 'entry-grid' },
      h('label', { class: 'field' }, '卖方', sellerSelect),
      h('label', { class: 'field' }, '或新卖方', newName),
      h('label', { class: 'field' }, '品种', itemSelect),
      h('label', { class: 'field' }, '可供数量', qty),
      h('label', { class: 'field' }, '单价', price),
    ),
    h(
      'div',
      { class: 'row', style: { marginTop: '8px' } },
      h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: submit }, '录入供给分段'),
      h('span', { class: 'xsmall muted' }, '同一卖方可以多次录入，形成分段供给曲线。'),
    ),
  );
}

function buyQuoteCard(market, settlement, quote) {
  const settled = settlement?.status === 'ok' || settlement?.status === 'no-trade';
  const winnerIds = new Set(settled ? settlement.settlements?.buys?.map((b) => b.quoteId) || [] : []);
  const isWinner = winnerIds.has(quote.id);
  const bidder = market.bidderById.get(quote.bidderId);
  const status = !settled ? (settlement ? 'unresolved' : 'draft') : isWinner ? 'accepted' : 'rejected';
  const statusPill =
    status === 'accepted'
      ? h('span', { class: 'pill good' }, '接受')
      : status === 'rejected'
        ? h('span', { class: 'pill' }, '未成交')
        : status === 'unresolved'
          ? h('span', { class: 'pill warn' }, '未判定')
          : h('span', { class: 'pill' }, '待清算');

  return h(
    'button',
    {
      class: `quote-card ${isWinner ? 'is-winner' : ''}`,
      type: 'button',
      'aria-pressed': String(state.selectedQuoteId === quote.id),
      onclick: () => {
        state.selectedQuoteId = quote.id;
        showQuote(quote.id);
      },
    },
    h('div', { class: 'q-top' }, h('span', { class: 'q-id' }, quote.id), statusPill),
    h('div', { class: 'q-bidder' }, bidder?.name || quote.bidderId),
    h(
      'div',
      { class: 'q-bundle' },
      quote.atoms.map((atom) =>
        h(
          'span',
          { class: 'pill item' },
          h('span', { class: 'dot', style: { background: itemColor(atom.itemId) } }),
          `${market.itemById.get(atom.itemId)?.name} × ${atom.qty}`,
        ),
      ),
      quote.altGroup ? h('span', { class: 'pill', title: '替代组：同组方案互斥' }, `替代组 ${quote.altGroup}`) : null,
    ),
    quote.note ? h('div', { class: 'q-note' }, quote.note) : null,
    h(
      'div',
      { class: 'q-foot' },
      h('div', { class: 'q-value' }, fmt(quote.value), h('small', null, '清算点')),
      settled && isWinner
        ? h(
            'span',
            { class: 'xsmall', style: { color: 'var(--good-text)' } },
            `支付 ${fmt(settlement.settlements.buyPayments.find((p) => p.quoteId === quote.id)?.payment ?? 0)}`,
          )
        : h(
            'span',
            { class: 'xsmall muted' },
            status === 'unresolved'
              ? '本轮未发布结算'
              : bidder?.budget
                ? `预算 ${fmt(bidder.budget)}`
                : '无预算上限',
          ),
    ),
  );
}

function supplySection(market, settlement) {
  const byItem = new Map();
  for (const quote of market.sellQuotes) {
    if (!byItem.has(quote.itemId)) byItem.set(quote.itemId, []);
    byItem.get(quote.itemId).push(quote);
  }
  const usedByQuote = new Map();
  for (const sup of settlement?.settlements?.supplies || []) usedByQuote.set(sup.quoteId, sup.qty);

  const rows = [];
  for (const item of market.items) {
    const segments = (byItem.get(item.id) || []).slice().sort((a, b) => a.unitPrice - b.unitPrice || a.id.localeCompare(b.id));
    if (segments.length === 0) {
      rows.push(h('div', { class: 'small muted' }, `${item.name}：无供给报价`));
      continue;
    }
    const maxQty = Math.max(...segments.map((x) => x.qty), 1);
    rows.push(
      h(
        'div',
        { class: 'row', style: { gap: '6px', marginTop: '4px' } },
        itemPill(market, item.id),
        h('span', { class: 'xsmall muted' }, `${segments.reduce((sum, x) => sum + x.qty, 0)} 件可供`),
      ),
    );
    for (const segment of segments) {
      const used = usedByQuote.get(segment.id) || 0;
      const seller = market.bidderById.get(segment.bidderId)?.name;
      rows.push(
        h(
          'div',
          {
            class: `supply-row ${used === 0 ? 'unused' : ''}`,
            role: 'button',
            tabindex: '0',
            'aria-label': `供给分段 ${segment.id}，${item.name}，可供 ${segment.qty}，单价 ${segment.unitPrice}${used ? `，已取用 ${used}` : ''}`,
            onclick: () => showSegment(segment.id),
            onkeydown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                showSegment(segment.id);
              }
            },
          },
          h(
            'div',
            { class: 'seg-label' },
            h('span', { class: 'name' }, segment.id),
            h('span', { class: 'xsmall muted' }, seller),
          ),
          h(
            'div',
            { class: 'supply-track' },
            h('div', {
              class: 'supply-fill',
              style: { width: `${(segment.qty / maxQty) * 100}%`, background: `color-mix(in srgb, ${itemColor(segment.itemId)} 34%, var(--surface-1))` },
            }),
            used
              ? h('div', {
                  class: 'supply-used',
                  style: { width: `${(used / maxQty) * 100}%`, background: itemColor(segment.itemId) },
                })
              : null,
          ),
          h(
            'div',
            { class: 'seg-meta' },
            h('div', null, `@${segment.unitPrice}`),
            h('div', { class: 'xsmall muted' }, used ? `用 ${used}/${segment.qty}` : `未用 0/${segment.qty}`),
          ),
        ),
      );
    }
  }

  return h(
    'section',
    { class: 'card', id: 'supply' },
    h(
      'div',
      { class: 'card-head' },
      h(
        'div',
        null,
        h('h2', null, '分段供给'),
        h('div', { class: 'sub' }, '同品种分段按单价升序取用；深色部分为本轮实际取用量。点击分段可修改或查看原因。'),
      ),
    ),
    h('div', { class: 'card-body stack' }, ...rows),
  );
}

/* --------------------------------------------------------------- compare */

function compareSection(market) {
  const frozen = state.round.frozen;
  const mod = state.compareMod;
  const segment = market.sellQuotes.find((q) => q.id === mod.quoteId) || market.sellQuotes[0];
  const currentValue = segment ? segment[mod.field] : 0;

  const inputs = h(
    'div',
    { class: 'stack', style: { gap: '10px' } },
    h(
      'div',
      { class: 'row', style: { gap: '10px', alignItems: 'flex-end' } },
      h(
        'label',
        { class: 'field', style: { flex: '1 1 150px' } },
        '供给分段',
        h(
          'select',
          {
            onchange: (event) => {
              state.compareMod = { ...state.compareMod, quoteId: event.target.value };
              state.compareResult = null;
              renderContent();
            },
          },
          market.sellQuotes.map((q) =>
            h(
              'option',
              { value: q.id, selected: q.id === mod.quoteId },
              `${q.id} · ${market.itemById.get(q.itemId)?.name} · ${market.bidderById.get(q.bidderId)?.name}`,
            ),
          ),
        ),
      ),
      h(
        'label',
        { class: 'field', style: { flex: '0 0 110px' } },
        '字段',
        h(
          'select',
          {
            onchange: (event) => {
              state.compareMod = { ...state.compareMod, field: event.target.value };
              state.compareResult = null;
              renderContent();
            },
          },
          h('option', { value: 'qty', selected: mod.field === 'qty' }, '供给数量'),
          h('option', { value: 'unitPrice', selected: mod.field === 'unitPrice' }, '单价'),
        ),
      ),
      h(
        'label',
        { class: 'field', style: { flex: '0 0 120px' } },
        `新值（现 ${fmt(currentValue)}）`,
        h('input', {
          type: 'number',
          min: '1',
          step: '1',
          value: String(mod.newValue),
          oninput: (event) => {
            const v = Number(event.target.value);
            if (Number.isInteger(v) && v >= 1) {
              state.compareMod = { ...state.compareMod, newValue: v };
            }
          },
        }),
      ),
      h(
        'button',
        {
          class: 'btn btn-primary',
          type: 'button',
          onclick: () => runCompare(),
        },
        '比较两轮',
      ),
    ),
    h(
      'div',
      { class: 'row', style: { gap: '6px' } },
      h('span', { class: 'xsmall muted' }, '预设：'),
      h(
        'button',
        {
          class: 'btn btn-sm',
          type: 'button',
          onclick: () => {
            state.compareMod = { ...SUPPLY_SHOCK.base };
            state.compareResult = null;
            renderContent();
          },
        },
        SUPPLY_SHOCK.base.label,
      ),
      h(
        'button',
        {
          class: 'btn btn-sm',
          type: 'button',
          onclick: () => {
            state.compareMod = { ...SUPPLY_SHOCK.alt };
            state.compareResult = null;
            renderContent();
          },
        },
        SUPPLY_SHOCK.alt.label,
      ),
    ),
  );

  let resultBlock = null;
  if (state.compareResult) {
    const cmp = state.compareResult;
    resultBlock = h(
      'div',
      { class: 'stack', style: { gap: '12px' } },
      h(
        'div',
        { class: 'callout' },
        `变更：${cmp.modification.quoteId} 的${cmp.modification.field === 'qty' ? '数量' : '单价'} ` +
          `由 ${fmt(cmp.modification.previousValue)} 改为 ${fmt(cmp.modification.newValue)}` +
          `（对比基准为当前报价簿）。前后两轮均按相同规则独立求解。`,
      ),
      h(
        'div',
        { class: 'compare-grid' },
        roundBox('变更前', cmp.before),
        roundBox('变更后', cmp.after),
      ),
      h(
        'div',
        { class: 'stack', style: { gap: '6px' } },
        h('h4', { style: { fontSize: '12.5px' } }, '赢家变化'),
        cmp.diff.length === 0
          ? h('div', { class: 'small muted' }, '赢家集合没有变化；差异体现在支付、成本或缺口。')
          : h(
              'div',
              { class: 'row', style: { gap: '6px' } },
              ...cmp.diff.map((d) =>
                h(
                  'span',
                  { class: `diff-chip ${d.after ? 'gain' : 'loss'}`, title: d.after ? '新进入赢家集合' : '退出赢家集合' },
                  d.quoteId,
                  d.after ? ' 新成交' : ' 落选',
                ),
              ),
            ),
        cmp.before.status !== cmp.after.status
          ? h(
              'div',
              { class: 'callout warn' },
              `状态变化：${statusLabel(cmp.before.status)} → ${statusLabel(cmp.after.status)}。` +
                (cmp.after.status !== 'ok' ? '变更后无法发布完整结算单，因此不能直接采纳为本轮结果。' : ''),
            )
          : null,
      ),
      h(
        'div',
        { class: 'row', style: { gap: '8px' } },
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            disabled: !frozen,
            title: frozen ? '' : '请先开始本轮清算',
            onclick: () => {
              try {
                state.round = adoptSupplyAsNextRound(state.round, {
                  quoteId: cmp.modification.quoteId,
                  field: cmp.modification.field,
                  newValue: cmp.modification.newValue,
                });
                state.compareResult = null;
                renderAll();
                toast(`已加入第 ${state.round.round + 1} 轮待生效清单；开启下一轮时应用`, 'good');
              } catch (error) {
                toast(error.message, 'bad');
              }
            },
          },
          '采纳为下一轮供给',
        ),
        !frozen ? h('span', { class: 'xsmall muted' }, '开始本轮清算后可采纳为下一轮') : null,
      ),
    );
  }

  return h(
    'section',
    { class: 'card', id: 'compare' },
    h(
      'div',
      { class: 'card-head' },
      h(
        'div',
        null,
        h('h2', null, '供给对比：两轮'),
        h('div', { class: 'sub' }, '改变一个供给分段的数量或单价，并排比较两轮的赢家、福利、成本与资金缺口。'),
      ),
    ),
    h('div', { class: 'card-body stack', style: { gap: '14px' } }, inputs, resultBlock),
  );
}

function runCompare() {
  try {
    const marketDef = state.round.marketDef;
    const segment = marketDef.sellQuotes.find((q) => q.id === state.compareMod.quoteId);
    if (!segment) throw new Error('报价簿中找不到该供给分段');
    state.compareResult = compareSupply(marketDef, state.compareMod, { nodeLimit: state.nodeLimit });
    renderContent();
    const after = state.compareResult.after;
    if (after.status === 'ok') toast('比较完成', 'good');
    else toast(`变更后无法完整清算：${statusLabel(after.status)}`, 'bad');
  } catch (error) {
    toast(error.message, 'bad');
  }
}

function roundBox(title, summary) {
  const rows = [
    ['状态', statusLabel(summary.status)],
    ['交易剩余', fmt(summary.welfare)],
    ['买方申报价值', fmt(summary.totalBuyerValue)],
    ['采购成本', fmt(summary.procurementCost)],
    ['买方支付', fmt(summary.totalBuyerPaid)],
    ['卖方收款', fmt(summary.totalSupplierReceived)],
    ['资金缺口', signed(summary.gap)],
    ['赢家', summary.winnerIds.length ? summary.winnerIds.join(', ') : '∅'],
    ['节点用量', fmt(summary.nodes.used)],
  ];
  return h(
    'div',
    { class: 'round-box' },
    h('h4', null, title),
    h(
      'div',
      null,
      ...rows.map(([k, v]) =>
        h('div', { class: 'kv' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v)),
      ),
    ),
  );
}

/* ------------------------------------------------------------ validation */

function validationSection(market, settlement) {
  const checks = settlement.validation?.checks || [];
  return h(
    'section',
    { class: 'card', id: 'validation' },
    h(
      'div',
      { class: 'card-head' },
      h(
        'div',
        null,
        h('h2', null, '不变量校验'),
        h('div', { class: 'sub' }, '每次清算后自动重算；校验失败不会静默放宽，而是标红。'),
      ),
      h(
        'div',
        { class: 'head-right' },
        h('span', { class: `pill ${checks.every((c) => c.ok) ? 'good' : 'critical'}` }, `${checks.filter((c) => c.ok).length} / ${checks.length} 通过`),
      ),
    ),
    h(
      'div',
      { class: 'card-body' },
      h(
        'div',
        { class: 'checklist' },
        ...checks.map((check) =>
          h(
            'div',
            { class: `check ${check.ok ? 'ok' : 'bad'}` },
            h('span', { class: 'ic', 'aria-hidden': 'true' }, check.ok ? '✓' : '✕'),
            h(
              'div',
              null,
              h('div', { class: 't' }, check.label),
              h('div', { class: 'd' }, check.detail),
            ),
          ),
        ),
      ),
    ),
  );
}

/* ------------------------------------------------------------------ stats */

function stat(label, value, { foot = '', hero = false, tone = '', id } = {}) {
  return h(
    'div',
    { class: `stat ${hero ? 'hero' : ''}`, id },
    h('div', { class: 'label' }, label),
    h('div', { class: `value ${tone}` }, value),
    foot ? h('div', { class: 'foot' }, foot) : null,
  );
}

/* ----------------------------------------------------------------- drawers */

function showQuote(quoteId) {
  const market = marketNow();
  const settlement = settlementNow();
  const quote = market.quoteById.get(quoteId);

  if (!settlement) {
    openDrawer({
      title: `${quote.id} · ${market.bidderById.get(quote.bidderId)?.name || ''}`,
      subtitle: '草稿轮尚未清算，暂无接受原因',
      build: (close) => [
        h('div', { class: 'callout' }, '开始清算后，这里会展示接受原因或未成交的具体阻断条件。'),
        quoteDetailBody(market, quote, close),
        actionBlock(market, quote, close),
      ],
    });
    return;
  }

  let explanation;
  try {
    explanation = explainQuote(market, settlement, quoteId, { nodeLimit: state.nodeLimit });
  } catch (error) {
    toast(error.message, 'bad');
    return;
  }

  openDrawer({
    title: `${quote.id} · ${explanation.bidderName}`,
    subtitle:
      quote.side === 'buy'
        ? `${explanation.status === 'accepted' ? '已接受' : explanation.status === 'rejected' ? '未成交' : '不可用'} · 申报价值 ${fmt(quote.value)}`
        : `${explanation.status === 'accepted' ? '已取用' : '未取用'} · ${market.itemById.get(quote.itemId)?.name} @${quote.unitPrice}`,
    build: (close) => [
      quoteDetailBody(market, quote, close, explanation),
      h('div', { class: 'stack' }, h('h3', { style: { fontSize: '13px' } }, '判定依据'), reasonList(explanation)),
      explanation.counterfactual ? forcedCounterfactual(market, explanation) : null,
      actionBlock(market, quote, close),
    ],
  });
}

function reasonList(explanation) {
  return h(
    'ul',
    { class: 'reason-list' },
    ...explanation.reasons.map((reason) =>
      h(
        'li',
        null,
        h('span', { class: 'tag' }, reasonTag(reason.kind)),
        h('span', null, reason.text),
      ),
    ),
  );
}

function reasonTag(kind) {
  return {
    welfare: '福利',
    value: '估值',
    bundle: '组合',
    alternative: '替代组',
    rejected: '阻断',
    rule: '规则',
    supply: '供给',
    cost: '成本',
    receipt: '收款',
    budget: '预算',
    'joint-supply': '联合供给',
    outbid: '被比下',
    'tie-lost': '决胜',
    unexpected: '异常',
    'no-settlement': '无结算',
  }[kind] || kind;
}

function quoteDetailBody(market, quote, close, explanation) {
  const bidder = market.bidderById.get(quote.bidderId);
  if (quote.side === 'buy') {
    return h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'row' },
        quote.atoms.map((atom) =>
          h(
            'span',
            { class: 'pill item' },
            h('span', { class: 'dot', style: { background: itemColor(atom.itemId) } }),
            `${market.itemById.get(atom.itemId)?.name} × ${atom.qty}`,
          ),
        ),
        quote.altGroup ? h('span', { class: 'pill' }, `替代组 ${quote.altGroup}`) : null,
      ),
      h(
        'div',
        { class: 'stack', style: { gap: '3px', marginTop: '4px' } },
        h('div', { class: 'kv' }, h('span', { class: 'k' }, '申报价值（整组上限）'), h('span', { class: 'v' }, `${fmt(quote.value)} 清算点`)),
        h('div', { class: 'kv' }, h('span', { class: 'k' }, '买方预算'), h('span', { class: 'v' }, bidder.budget === Number.MAX_SAFE_INTEGER ? '无上限' : `${fmt(bidder.budget)} 清算点`)),
        h('div', { class: 'kv' }, h('span', { class: 'k' }, '报价编号'), h('span', { class: 'v mono' }, quote.id)),
      ),
      quote.note ? h('div', { class: 'callout' }, quote.note) : null,
      explanation?.counterfactual
        ? h(
            'div',
            { class: 'stack', style: { gap: '4px' } },
            h('h3', { style: { fontSize: '13px' } }, '强行接受该报价会怎样'),
            h(
              'div',
              { class: 'formula' },
              explanation.counterfactual.forcedInfeasible
                ? '强制接受后无可行分配（供给 / 预算 / 替代组联合不可行）'
                : `强制接受后最优福利 ${fmt(explanation.counterfactual.forcedWelfare)} ` +
                  `（现状 ${fmt(explanation.counterfactual.freeWelfare)}，` +
                  `差额 ${signed(explanation.counterfactual.welfareDelta)}）\n` +
                  `该配置赢家：${explanation.counterfactual.forcedWinnerIds.join(', ') || '∅'}`,
            ),
          )
        : null,
    );
  }
  return h(
    'div',
    { class: 'stack' },
    h(
      'div',
      { class: 'row' },
      itemPill(market, quote.itemId),
      h('span', { class: 'pill' }, quote.qty, ' 件可供'),
      h('span', { class: 'pill' }, `单价 ${quote.unitPrice}`),
    ),
    h(
      'div',
      { class: 'stack', style: { gap: '3px', marginTop: '4px' } },
      h('div', { class: 'kv' }, h('span', { class: 'k' }, '卖方'), h('span', { class: 'v' }, bidder?.name || quote.bidderId)),
      h('div', { class: 'kv' }, h('span', { class: 'k' }, '分段编号'), h('span', { class: 'v mono' }, quote.id)),
      h('div', { class: 'kv' }, h('span', { class: 'k' }, '整段成本上限'), h('span', { class: 'v' }, `${fmt(quote.qty * quote.unitPrice)} 清算点`)),
    ),
    quote.note ? h('div', { class: 'callout' }, quote.note) : null,
  );
}

function forcedCounterfactual(market, explanation) {
  const cf = explanation.counterfactual;
  return h(
    'div',
    { class: 'stack', style: { gap: '6px' } },
    h('h3', { style: { fontSize: '13px' } }, '对照：强制接受 vs 当前最优'),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'data' },
        h('thead', null, h('tr', null, h('th', null, '方案'), h('th', { class: 'num' }, '最优福利'), h('th', null, '赢家集合'))),
        h(
          'tbody',
          null,
          h(
            'tr',
            null,
            h('td', null, '当前最优'),
            h('td', { class: 'num' }, fmt(cf.freeWelfare)),
            h('td', { class: 'mono xsmall' }, '见结算单'),
          ),
          h(
            'tr',
            null,
            h('td', null, '强制接受该报价'),
            h('td', { class: 'num' }, cf.forcedInfeasible ? '不可行' : fmt(cf.forcedWelfare)),
            h('td', { class: 'mono xsmall' }, cf.forcedInfeasible ? '—' : cf.forcedWinnerIds.join(', ') || '∅'),
          ),
        ),
      ),
    ),
  );
}

function actionBlock(market, quote, close) {
  const frozen = state.round.frozen;
  return h(
    'div',
    { class: 'stack', style: { gap: '6px', borderTop: '1px solid var(--border)', paddingTop: '12px' } },
    h(
      'div',
      { class: 'row', style: { gap: '8px' } },
      h(
        'button',
        {
          class: 'btn btn-danger-ghost btn-sm',
          type: 'button',
          onclick: () => {
            withdrawQuote(quote.id);
            close();
          },
        },
        frozen ? `撤回记入第 ${state.round.round + 1} 轮` : '撤回报价',
      ),
      quote.side === 'sell'
        ? h(
            'button',
            {
              class: 'btn btn-sm',
              type: 'button',
              onclick: () => {
                close();
                showSupplyEdit(quote.id);
              },
            },
            '修改供给',
          )
        : null,
    ),
    frozen
      ? h('p', { class: 'xsmall muted' }, '本轮已冻结：撤单/改供给不影响当前结算单，将在下一轮生效。')
      : h('p', { class: 'xsmall muted' }, '草稿轮：改动立即写入当前报价簿。'),
  );
}

function showSegment(segmentId) {
  const market = marketNow();
  const quote = market.sellQuotes.find((q) => q.id === segmentId);
  if (!quote) return;
  showQuote(segmentId);
}

function showSupplyEdit(segmentId) {
  const market = marketNow();
  const segment = market.sellQuotes.find((q) => q.id === segmentId);
  if (!segment) return;
  openModal({
    title: `修改供给 ${segment.id}`,
    subtitle: `${market.itemById.get(segment.itemId)?.name} · ${market.bidderById.get(segment.bidderId)?.name}`,
    build: (close) => {
      const qtyInput = h('input', { type: 'number', min: '1', step: '1', value: String(segment.qty) });
      const priceInput = h('input', { type: 'number', min: '1', step: '1', value: String(segment.unitPrice) });
      return [
        h(
          'div',
          { class: 'row', style: { gap: '10px' } },
          h('label', { class: 'field', style: { flex: 1 } }, '可供数量', qtyInput),
          h('label', { class: 'field', style: { flex: 1 } }, '单价（清算点）', priceInput),
        ),
        h(
          'p',
          { class: 'small muted' },
          state.round.frozen
            ? `本轮已冻结，修改将记入第 ${state.round.round + 1} 轮。`
            : '草稿轮，修改立即生效。',
        ),
        h(
          'div',
          { class: 'row' },
          h(
            'button',
            {
              class: 'btn btn-primary',
              type: 'button',
              onclick: () => {
                const qty = Number(qtyInput.value);
                const price = Number(priceInput.value);
                if (!Number.isInteger(qty) || qty < 1 || !Number.isInteger(price) || price < 1) {
                  toast('数量和单价都必须是正整数', 'bad');
                  return;
                }
                if (qty !== segment.qty) editSupply(segment.id, 'qty', qty);
                if (price !== segment.unitPrice) editSupply(segment.id, 'unitPrice', price);
                close();
              },
            },
            '保存修改',
          ),
          h('button', { class: 'btn', type: 'button', onclick: close }, '取消'),
        ),
      ];
    },
  });
}

function showPayment(quoteId) {
  const market = marketNow();
  const settlement = settlementNow();
  if (!settlement?.settlements) {
    toast('当前没有可查看的结算单', 'bad');
    return;
  }
  const buyPay = settlement.settlements.buyPayments.find((p) => p.quoteId === quoteId);
  const sellPay = settlement.settlements.supplierReceipts.find((p) => p.quoteId === quoteId);
  if (!buyPay && !sellPay) {
    toast('该报价不在本轮成交中', 'bad');
    return;
  }
  openDrawer({
    title: `${quoteId} 的反事实计算`,
    subtitle: buyPay
      ? `买方 · ${buyPay.bidderName} · 申报价值 ${fmt(buyPay.value)}`
      : `卖方 · ${sellPay.bidderName} · ${market.itemById.get(sellPay.itemId)?.name} × ${sellPay.qty}`,
    build: () => [
      h(
        'div',
        { class: 'callout' },
        buyPay
          ? '支付 = 撤除该报价后的最优福利 −（本轮福利 − 该报价的申报价值）。不是最后一笔成交价。'
          : '收款 = 本轮福利 + 该分段成交成本 − 撤除该分段后的最优福利。不是“单价 × 数量”。',
      ),
      h('div', { class: 'formula' }, buyPay ? buyPay.identity : sellPay.identity),
      h(
        'div',
        { class: 'stack', style: { gap: '3px' } },
        h('div', { class: 'kv' }, h('span', { class: 'k' }, '本轮最优福利 W'), h('span', { class: 'v' }, fmt(settlement.main.welfare))),
        buyPay
          ? h('div', { class: 'kv' }, h('span', { class: 'k' }, `撤除 ${quoteId} 后 W(−b)`), h('span', { class: 'v' }, fmt(buyPay.counterfactual.welfare)))
          : h('div', { class: 'kv' }, h('span', { class: 'k' }, `撤除 ${quoteId} 后 W(−s)`), h('span', { class: 'v' }, fmt(sellPay.counterfactual.welfare))),
        buyPay
          ? h('div', { class: 'kv' }, h('span', { class: 'k' }, '该报价申报价值 v'), h('span', { class: 'v' }, fmt(buyPay.value)))
          : h('div', { class: 'kv' }, h('span', { class: 'k' }, '该分段成交成本 c'), h('span', { class: 'v' }, fmt(sellPay.cost))),
        h(
          'div',
          { class: 'kv' },
          h('span', { class: 'k' }, buyPay ? '应支付' : '应支付给卖方'),
          h('span', { class: 'v', style: { fontWeight: '700' } }, fmt(buyPay ? buyPay.payment : sellPay.receipt)),
        ),
      ),
      h('h3', { style: { fontSize: '13px' } }, `撤除该报价后的最优分配`),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'data' },
          h(
            'thead',
            null,
            h('tr', null, h('th', null, '赢家'), h('th', { class: 'num' }, '申报价值'), h('th', { class: 'num' }, '采购成本'), h('th', { class: 'num' }, '福利')),
          ),
          h(
            'tbody',
            null,
            h(
              'tr',
              null,
              h('td', { class: 'mono xsmall' }, (buyPay || sellPay).counterfactual.winnerIds.join(', ') || '∅'),
              h('td', { class: 'num' }, fmt((buyPay || sellPay).counterfactual.solution.winner?.buyValue ?? 0)),
              h('td', { class: 'num' }, fmt((buyPay || sellPay).counterfactual.procurementCost)),
              h('td', { class: 'num' }, fmt((buyPay || sellPay).counterfactual.welfare)),
            ),
          ),
        ),
      ),
      h(
        'details',
        { class: 'disclose' },
        h('summary', null, '该反事实的求解统计'),
        h(
          'div',
          { class: 'small ink2' },
          `枚举叶节点 ${fmt((buyPay || sellPay).counterfactual.solution.exploredLeaves)}；` +
            `可行配置 ${fmt((buyPay || sellPay).counterfactual.solution.feasibleLeaves)}；` +
            `节点用量 ${fmt((buyPay || sellPay).counterfactual.solution.nodesUsed)}。`,
        ),
      ),
      h(
        'p',
        { class: 'xsmall muted' },
        '所有反事实子任务必须在发布结算单前成功；任一失败则不发布任何支付。',
      ),
    ],
  });
}

/* ----------------------------------------------------------------- export */

function exportSettlement(market, settlement) {
  const payload = {
    generatedAt: new Date().toISOString(),
    scenario: state.scenarioId,
    round: state.round.round,
    fictional: true,
    mechanism: settlement.mechanism,
    welfare: settlement.settlements.welfare,
    winners: settlement.settlements.buys,
    supplies: settlement.settlements.supplies,
    buyPayments: settlement.settlements.buyPayments.map((p) => ({
      quoteId: p.quoteId,
      bidder: p.bidderName,
      value: p.value,
      payment: p.payment,
      counterfactualWelfare: p.counterfactual.welfare,
    })),
    supplierReceipts: settlement.settlements.supplierReceipts.map((p) => ({
      quoteId: p.quoteId,
      supplier: p.bidderName,
      cost: p.cost,
      receipt: p.receipt,
      counterfactualWelfare: p.counterfactual.welfare,
    })),
    totals: {
      buyerPaid: settlement.settlements.totalBuyerPaid,
      supplierReceived: settlement.settlements.totalSupplierReceived,
      budgetGap: settlement.settlements.gap,
    },
    validation: settlement.validation,
    disclaimer: '虚构订单与虚构清算点，不连接真实资金账户。',
  };
  download(`clearing-round-${state.round.round}-${state.scenarioId}.json`, JSON.stringify(payload, null, 2));
  toast('结算 JSON 已导出', 'good');
}

/* ----------------------------------------------------------------- theme */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('clearing-theme', theme);
}

function initTheme() {
  const saved = localStorage.getItem('clearing-theme');
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  applyTheme(saved || (prefersDark ? 'dark' : 'light'));
  els.theme.addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });
}

/* ------------------------------------------------------------------- boot */

initTheme();
loadScenario('base');

window.__clearingDesk = {
  state,
  loadScenario,
  doStartClearing,
  doNextRound,
};
