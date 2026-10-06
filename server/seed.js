'use strict';
/** seed.js —— 首次启动时写入演示数据（仅当数据库为空）。 */
const { makeAnchor } = require('./redact');

function seed(store) {
  const { db, save, nextId, emptyChannels } = store;
  if (db.entries.length > 0) return false;

  const now = new Date().toISOString();
  db.works.push(
    { id: nextId('w'), title: 'Neo-Finance App', visibility: 'public', page: 'work-detail.html' },
    { id: nextId('w'), title: 'Solar 气象站', visibility: 'public', page: 'solar-detail.html' },
  );

  const sections = {
    problem: '实习第一周，我负责梳理 Neo-Finance 账单模块的遗留问题。导师王芳（工号 A1024）带我熟悉代码库，我的临时工位在 3 号楼 5 层。',
    action: '我重构了对账任务，把订单号 13800138000 的异常流水单独归档；遇到问题时通过 13912345678 联系运维张老师，也把进展同步到邮箱 linmo.intern@example.com。',
    result: '上线后账单延迟从 6 小时降到 20 分钟，对账错误率降到 0.02%，周报连续三次被团队引用。',
    reflection: '我意识到沟通比代码更重要。周末住在公司宿舍（滨江路 88 号）让我有更多时间复盘，也学会了先复述需求再动手。',
  };

  const entry = {
    id: nextId('e'),
    title: '在 Neo-Finance 的八周',
    workId: db.works[0].id,
    workTitleSnapshot: db.works[0].title, // 引用快照：项目改名/转私密后仍显示来源，不跳转到无关项目
    status: 'pending_review', // draft -> pending_review -> approved -> published / retracted
    original: { version: 1, sections, updatedBy: '林墨', updatedAt: now },
    spans: [],
    public: null,
    publicHistory: [],
    channels: emptyChannels(),
    attachments: [
      { id: nextId('a'), filename: 'images/work_ui_design.png', metaChecked: true, metaFindings: [], replacedAt: null },
    ],
    createdAt: now,
  };

  // 人工标注的敏感片段（含规则覆盖不到的：人名、地址）
  const humanMarks = [
    { section: 'problem', exact: '王芳', note: '同事真实姓名' },
    { section: 'action', exact: '13912345678', note: '运维老师手机号' },
    { section: 'action', exact: 'linmo.intern@example.com', note: '工作邮箱' },
    { section: 'reflection', exact: '滨江路 88 号', note: '宿舍地址' },
  ];
  for (const m of humanMarks) {
    const text = sections[m.section];
    const start = text.indexOf(m.exact);
    if (start === -1) throw new Error('seed 标注未命中: ' + m.exact);
    entry.spans.push({
      id: nextId('s'), section: m.section,
      anchor: makeAnchor(text, start, start + m.exact.length),
      start, end: start + m.exact.length,
      author: 'human', rule: null, status: 'pending', note: m.note, createdAt: now,
    });
  }

  db.entries.push(entry);
  store.audit('seed: 初始化演示数据');
  save();
  return true;
}

module.exports = { seed };
