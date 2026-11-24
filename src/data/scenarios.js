/**
 * Built-in fictional markets. No real accounts, no real money: every amount is
 * in "清算点" (clearing credits) and every firm is invented.
 */

const terrain = {
  items: [
    { id: 'A', name: '铝合金支架', unit: '件', desc: '通用承力件，可按件拆供' },
    { id: 'T', name: '钛合金卡箍', unit: '件', desc: '高强度件，供应紧张' },
    { id: 'C', name: '铜触点', unit: '件', desc: '小件，供应商分段报价' },
  ],
  bidders: [
    { id: 'b1', name: '华擎装配', side: 'buy', budget: 400 },
    { id: 'b2', name: '蓝海机电', side: 'buy', budget: 220 },
    { id: 'b3', name: '锐驰工坊', side: 'buy', budget: 220 },
    { id: 'b4', name: '城东维修站', side: 'buy', budget: 100 },
    { id: 'b5', name: '备件联盟', side: 'buy', budget: 300 },
    { id: 'b6', name: '社区维修点', side: 'buy', budget: 50 },
    { id: 's1', name: '精工五金', side: 'sell' },
    { id: 's2', name: '远航金属', side: 'sell' },
    { id: 's3', name: '恒达零件', side: 'sell' },
  ],
  buyQuotes: [
    {
      id: 'Q-101',
      bidderId: 'b1',
      atoms: [{ itemId: 'A', qty: 2 }, { itemId: 'T', qty: 1 }],
      value: 280,
      note: '整机装配：支架与卡箍必须同一批到货',
    },
    { id: 'Q-102', bidderId: 'b2', atoms: [{ itemId: 'A', qty: 2 }], value: 130 },
    {
      id: 'Q-103',
      bidderId: 'b3',
      atoms: [{ itemId: 'C', qty: 3 }, { itemId: 'T', qty: 1 }],
      value: 210,
      altGroup: 'b3-替代',
      note: '触点+卡箍组合，与 Q-107 二选一',
    },
    { id: 'Q-104', bidderId: 'b4', atoms: [{ itemId: 'A', qty: 1 }, { itemId: 'C', qty: 1 }], value: 80 },
    { id: 'Q-105', bidderId: 'b5', atoms: [{ itemId: 'T', qty: 2 }], value: 240 },
    { id: 'Q-106', bidderId: 'b2', atoms: [{ itemId: 'C', qty: 2 }], value: 60 },
    {
      id: 'Q-107',
      bidderId: 'b3',
      atoms: [{ itemId: 'A', qty: 2 }, { itemId: 'C', qty: 2 }],
      value: 150,
      altGroup: 'b3-替代',
      note: '替代方案：以支架替代卡箍',
    },
    { id: 'Q-108', bidderId: 'b5', atoms: [{ itemId: 'C', qty: 3 }], value: 90 },
    { id: 'Q-109', bidderId: 'b1', atoms: [{ itemId: 'C', qty: 2 }], value: 55 },
    { id: 'Q-110', bidderId: 'b6', atoms: [{ itemId: 'A', qty: 1 }], value: 20 },
  ],
  sellQuotes: [
    { id: 'S-201', bidderId: 's1', itemId: 'A', qty: 4, unitPrice: 30 },
    { id: 'S-202', bidderId: 's1', itemId: 'T', qty: 2, unitPrice: 90 },
    { id: 'S-203', bidderId: 's2', itemId: 'A', qty: 3, unitPrice: 44 },
    { id: 'S-204', bidderId: 's2', itemId: 'C', qty: 6, unitPrice: 16 },
    { id: 'S-205', bidderId: 's3', itemId: 'T', qty: 3, unitPrice: 110 },
    { id: 'S-206', bidderId: 's3', itemId: 'C', qty: 5, unitPrice: 24 },
    { id: 'S-207', bidderId: 's3', itemId: 'A', qty: 5, unitPrice: 60 },
  ],
};

const noTrade = {
  items: [
    { id: 'A', name: '铝合金支架', unit: '件' },
    { id: 'C', name: '铜触点', unit: '件' },
  ],
  bidders: [
    { id: 'b1', name: '小批量试制组', side: 'buy', budget: 120 },
    { id: 's1', name: '精工五金', side: 'sell' },
  ],
  buyQuotes: [
    { id: 'Q-301', bidderId: 'b1', atoms: [{ itemId: 'A', qty: 2 }], value: 80, note: '出价低于任何可行采购成本' },
    { id: 'Q-302', bidderId: 'b1', atoms: [{ itemId: 'C', qty: 1 }], value: 10, note: '同样低于成本' },
  ],
  sellQuotes: [
    { id: 'S-401', bidderId: 's1', itemId: 'A', qty: 3, unitPrice: 50 },
    { id: 'S-402', bidderId: 's1', itemId: 'C', qty: 5, unitPrice: 30 },
  ],
};

const tie = {
  items: [{ id: 'A', name: '铝合金支架', unit: '件' }],
  bidders: [
    { id: 'b1', name: '并列买方一', side: 'buy', budget: 150 },
    { id: 'b2', name: '并列买方二', side: 'buy', budget: 150 },
    { id: 's1', name: '唯一供应商', side: 'sell' },
  ],
  buyQuotes: [
    { id: 'Q-501', bidderId: 'b1', atoms: [{ itemId: 'A', qty: 1 }], value: 100, note: '与 Q-502 福利完全相同' },
    { id: 'Q-502', bidderId: 'b2', atoms: [{ itemId: 'A', qty: 1 }], value: 100, note: '与 Q-501 福利完全相同' },
  ],
  sellQuotes: [{ id: 'S-601', bidderId: 's1', itemId: 'A', qty: 1, unitPrice: 40 }],
};

const buyQuotesTimeout = Array.from({ length: 14 }, (_, index) => ({
  id: `Q-7${String(index + 1).padStart(2, '0')}`,
  bidderId: `tb${index + 1}`,
  atoms: [{ itemId: 'A', qty: 2 }],
  value: 100,
  note: '独立买方；供给充足，子任务数量大',
}));

const timeout = {
  items: [{ id: 'A', name: '铝合金支架', unit: '件' }],
  bidders: [
    ...Array.from({ length: 14 }, (_, index) => ({
      id: `tb${index + 1}`,
      name: `批量买方 ${index + 1}`,
      side: 'buy',
      budget: 500,
    })),
    { id: 'ts1', name: '西线金属', side: 'sell' },
    { id: 'ts2', name: '东线金属', side: 'sell' },
  ],
  buyQuotes: buyQuotesTimeout,
  sellQuotes: [
    { id: 'S-701', bidderId: 'ts1', itemId: 'A', qty: 50, unitPrice: 10 },
    { id: 'S-702', bidderId: 'ts2', itemId: 'A', qty: 50, unitPrice: 10 },
  ],
  nodeLimit: 70000,
};

export const SCENARIOS = [
  {
    id: 'base',
    name: '组合 · 替代 · 预算',
    tagline: '10 条买方报价、7 个供给分段；组合、替代组和预算同时约束',
    note:
      '基准小市场，可完全枚举。Q-103 与 Q-107 是同一买方的二选一方案；' +
      'Q-105 与 Q-108 同属备件联盟，合并申报超过其预算；' +
      'Q-110 的申报价值低于最便宜的支架分段单价，单独接受会买入即亏；' +
      '分段供给按单价从低到高取用，S-207 是高于所有买方估值的最高价档。',
    $def: terrain,
    nodeLimit: 2_000_000,
  },
  {
    id: 'no-trade',
    name: '未成交',
    tagline: '所有报价的申报价值都低于采购成本，最优福利为 0',
    note: '系统不应发布任何成交或支付条目。',
    $def: noTrade,
    nodeLimit: 200_000,
  },
  {
    id: 'tie',
    name: '并列最优',
    tagline: '两条报价带来完全相同的福利与申报价值，由编号决胜规则选择',
    note: '并列方案全部列出；决胜顺序：福利 → 申报买方价值 → 报价编号字典序。',
    $def: tie,
    nodeLimit: 200_000,
  },
  {
    id: 'timeout',
    name: '计算超时',
    tagline: '主问题可解，但逐报价反事实耗尽共享节点预算',
    note:
      '共享节点预算 70,000。主问题与部分反事实完成后预算耗尽；系统必须拒绝发布' +
      '只有部分赢家支付条目的结算单。可在“演练与求解参数”中调大预算再试。',
    $def: timeout,
    nodeLimit: 70000,
  },
];

export function getScenario(id) {
  const scenario = SCENARIOS.find((item) => item.id === id);
  if (!scenario) throw new Error(`未知场景：${id}`);
  // Materialize a fresh, mutable market definition.
  return {
    id: scenario.id,
    name: scenario.name,
    tagline: scenario.tagline,
    note: scenario.note,
    nodeLimit: scenario.nodeLimit,
    market: JSON.parse(JSON.stringify(scenario.$def)),
  };
}

/** The two-round supply comparison preset used by the UI. */
export const SUPPLY_SHOCK = {
  base: { quoteId: 'S-205', field: 'qty', newValue: 1, label: '恒达 T 段减供至 1 件（原 3 件）' },
  alt: { quoteId: 'S-201', field: 'qty', newValue: 2, label: '精工 A 段减供至 2 件（原 4 件）' },
};
