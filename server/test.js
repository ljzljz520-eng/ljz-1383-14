'use strict';
/**
 * test.js —— 验收场景测试（node server/test.js）
 * 覆盖：双人同时改写 / 旧发布任务晚到 / 项目转私密撤回 / 搜索缓存未刷新 /
 *       图片替换 / 锚点漂移 / 规则 vs 人工对比 / 读者版本固定
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createApp } = require('./server');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'diary-')), 'db.json');
const { server } = createApp(tmpDb);

let base;
const j = (r) => r.json();
const api = {
  get: (p) => fetch(base + p).then(async r => ({ status: r.status, body: await j(r).catch(() => null) })),
  post: (p, b) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(async r => ({ status: r.status, body: await j(r).catch(() => null) })),
  put: (p, b) => fetch(base + p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(async r => ({ status: r.status, body: await j(r).catch(() => null) })),
};

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

async function getEntry(id) { return (await api.get(`/api/entries/${id}`)).body; }
async function approveAllSpans(id) {
  const e = await getEntry(id);
  for (const s of e.spans.filter(x => x.status === 'pending')) {
    await api.post(`/api/entries/${id}/spans/${s.id}/decision`, { decision: 'approve', reviewer: '测试员' });
  }
}
async function reviewAndPublish(id, note) {
  let r = await api.post(`/api/entries/${id}/review`, { conclusion: 'approve', reviewer: '测试员', note: note || '同意发布' });
  assert.strictEqual(r.status, 200, `review 应通过: ${JSON.stringify(r.body)}`);
  const pubV = r.body.public.version;
  r = await api.post(`/api/entries/${id}/publish`, { publicVersion: pubV });
  assert.strictEqual(r.status, 202, 'publish 应入队');
  await api.post('/api/jobs/run');
  return pubV;
}

test('规则检测 vs 人工标注：遗漏与误报都被如实报告', async () => {
  const state = (await api.get('/api/state')).body;
  const e = state.entries[0];
  // 运行规则检测
  const det = await api.post(`/api/entries/${e.id}/detect`);
  // 人工已标的手机号/邮箱会被去重跳过，只有未被覆盖的「订单号 13800138000」新增
  assert.ok(det.body.added.some(a => a.exact === '13800138000'), '规则应新命中订单号');
  // 对比报告
  const rep = (await api.get(`/api/entries/${e.id}/compare`)).body;
  const missTexts = rep.misses.map(m => m.exact);
  const fpTexts = rep.falsePositives.map(f => f.exact);
  assert.ok(missTexts.includes('王芳'), '规则应遗漏人名「王芳」');
  assert.ok(missTexts.includes('滨江路 88 号'), '规则应遗漏地址「滨江路 88 号」');
  assert.ok(fpTexts.includes('13800138000'), '规则应误报订单号「13800138000」');
  assert.ok(rep.both.some(b => b.exact === '13912345678'), '手机号应双方共同命中');
  console.log('   对比摘要:', rep.summary);
  // 误报片段由人工驳回（发布前必须清空 pending）
  const full = await getEntry(e.id);
  const fp = full.spans.find(s => s.author === 'rule' && s.anchor.exact === '13800138000');
  await api.post(`/api/entries/${e.id}/spans/${fp.id}/decision`, { decision: 'dismiss', reviewer: '测试员' });
});

test('审阅批准 -> 发布 -> 四个公开渠道全部由公开稿生成', async () => {
  const e = (await api.get('/api/state')).body.entries[0];
  await approveAllSpans(e.id);
  const v = await reviewAndPublish(e.id);
  assert.strictEqual(v, 1);
  const ch = (await api.get(`/api/entries/${e.id}/channels`)).body;
  for (const name of ['search', 'rss', 'card', 'download']) {
    assert.strictEqual(ch.channels[name].status, 'published', `${name} 应已发布`);
    assert.strictEqual(ch.channels[name].publishedVersion, 1);
  }
  // 下载文本不得包含敏感原文，必须含占位符
  const dl = await fetch(`${base}/api/entries/${e.id}/download.txt`).then(r => r.text());
  assert.ok(!dl.includes('13912345678') && !dl.includes('王芳') && !dl.includes('滨江路 88 号'), '下载文本泄露了敏感内容');
  assert.ok(dl.includes('［已隐去］'), '下载文本应包含脱敏占位符');
  const rss = await fetch(`${base}/rss.xml`).then(r => r.text());
  assert.ok(!rss.includes('13912345678') && rss.includes('实习') === false || !rss.includes('王芳'), 'RSS 不得含敏感内容');
});

test('两人同时改写：后提交者收到 409，不会静默覆盖', async () => {
  const e = (await api.get('/api/state')).body.entries[0];
  const cur = await getEntry(e.id);
  const v = cur.original.version;
  const a = await api.put(`/api/entries/${e.id}/original`, { baseVersion: v, sections: { ...cur.original.sections, result: 'A 编辑的结果。' }, editor: '编辑A' });
  assert.strictEqual(a.status, 200);
  const b = await api.put(`/api/entries/${e.id}/original`, { baseVersion: v, sections: { ...cur.original.sections, result: 'B 编辑的结果。' }, editor: '编辑B' });
  assert.strictEqual(b.status, 409, 'B 基于过期版本提交应冲突');
  assert.strictEqual(b.body.currentVersion, v + 1);
  const after = await getEntry(e.id);
  assert.strictEqual(after.original.sections.result, 'A 编辑的结果。', '先写者的内容应保留');
});

test('原稿改写使已批准片段漂移：锚点重新定位或回到待审，绝不误套新文字', async () => {
  const e = (await api.get('/api/state')).body.entries[0];
  let cur = await getEntry(e.id);
  // 场景1：在手机号前面插入文字 => 偏移变化但锚点应成功重定位，状态保持 approved
  const action1 = cur.original.sections.action.replace('我重构了对账任务', '我重构了对账任务（耗时两天）');
  let r = await api.put(`/api/entries/${e.id}/original`, { baseVersion: cur.original.version, sections: { ...cur.original.sections, action: action1 }, editor: '编辑A' });
  assert.strictEqual(r.body.drifted, false, '仅偏移变化不应造成漂移');
  cur = await getEntry(e.id);
  const phone = cur.spans.find(s => s.anchor.exact === '13912345678');
  assert.strictEqual(phone.status, 'approved');
  assert.strictEqual(cur.original.sections.action.slice(phone.start, phone.end), '13912345678', '重定位后偏移必须指向正确文字');
  // 场景2：把含手机号的整句改写 => 锚点失效，条目回到待审
  const action2 = cur.original.sections.action.replace('遇到问题时通过 13912345678 联系运维张老师', '遇到问题时当面请教运维老师');
  r = await api.put(`/api/entries/${e.id}/original`, { baseVersion: cur.original.version, sections: { ...cur.original.sections, action: action2 }, editor: '编辑A' });
  assert.strictEqual(r.body.drifted, true, '片段消失应判定漂移');
  cur = await getEntry(e.id);
  assert.strictEqual(cur.status, 'pending_review', '已批准条目漂移后必须回到待审');
  const stale = cur.spans.find(s => s.id === phone.id);
  assert.strictEqual(stale.status, 'stale');
  // 公开稿仍是旧版 v1，不会被自动重派生
  assert.strictEqual(cur.public.version, 1);
  // 失效锚点不能直接批准
  const d = await api.post(`/api/entries/${e.id}/spans/${stale.id}/decision`, { decision: 'approve' });
  assert.strictEqual(d.status, 409);
  // 驳回失效片段后重新审阅 => 公开稿 v2
  await api.post(`/api/entries/${e.id}/spans/${stale.id}/decision`, { decision: 'dismiss' });
  await approveAllSpans(e.id);
  const v2 = await reviewAndPublish(e.id, '漂移后复审');
  assert.strictEqual(v2, 2);
});

test('旧发布任务晚到：针对 v1 的任务在 v2 时代被丢弃', async () => {
  const e = (await api.get('/api/state')).body.entries[0];
  // 手工塞入一个针对 v1 的晚到任务（模拟队列里滞留的旧任务）
  const late = await api.post(`/api/entries/${e.id}/publish`, { publicVersion: 1 });
  assert.strictEqual(late.status, 409, '版本不符的旧任务应被直接拒绝');
  // 再验证队列防线：当前版本正确入队，执行时版本已变 => dropped
  const cur = await getEntry(e.id);
  const okJob = await api.post(`/api/entries/${e.id}/publish`, { publicVersion: cur.public.version });
  assert.strictEqual(okJob.status, 202);
  // 期间又产生新公开稿 v3（改回原句并复审）
  const cur2 = await getEntry(e.id);
  const action3 = cur2.original.sections.action.replace('遇到问题时当面请教运维老师', '遇到问题时通过站内工单联系运维团队');
  await api.put(`/api/entries/${e.id}/original`, { baseVersion: cur2.original.version, sections: { ...cur2.original.sections, action: action3 }, editor: '编辑A' });
  await approveAllSpans(e.id);
  const r = await api.post(`/api/entries/${e.id}/review`, { conclusion: 'approve', reviewer: '测试员', note: 'v3' });
  assert.strictEqual(r.body.public.version, 3);
  const ran = (await api.post('/api/jobs/run')).body;
  const dropped = ran.find(x => x.status === 'dropped');
  assert.ok(dropped && /过期发布任务/.test(dropped.note), '晚到的 v2 任务应被丢弃: ' + JSON.stringify(ran));
  const ch = (await api.get(`/api/entries/${e.id}/channels`)).body;
  assert.strictEqual(ch.channels.download.publishedVersion, 2, '渠道仍停留在 v2，未被旧任务污染');
});

test('搜索摘要缓存未刷新：如实标记 stale，刷新后一致', async () => {
  const e = (await api.get('/api/state')).body.entries[0];
  // 发布 v3
  const cur = await getEntry(e.id);
  await api.post(`/api/entries/${e.id}/publish`, { publicVersion: cur.public.version });
  await api.post('/api/jobs/run');
  let s = (await api.get('/api/search?q=账单')).body.results.find(x => x.id === e.id);
  assert.strictEqual(s.publishedVersion, 3);
  assert.ok(s.cacheVersion < s.publishedVersion, '缓存仍停留在旧版本摘要');
  assert.strictEqual(s.stale, true, '必须如实标记缓存滞后');
  // 刷新缓存
  await api.post(`/api/entries/${e.id}/refresh-search`);
  await api.post('/api/jobs/run');
  s = (await api.get('/api/search?q=账单')).body.results.find(x => x.id === e.id);
  assert.strictEqual(s.stale, false);
  assert.strictEqual(s.cacheVersion, 3);
});

test('图片替换：元数据检查作废，未重新检查前禁止发布', async () => {
  const e = (await api.get('/api/state')).body.entries[0];
  const cur = await getEntry(e.id);
  const att = cur.attachments[0];
  const rep = await api.put(`/api/attachments/${att.id}/replace`, { filename: 'images/hobby_photography.png' });
  assert.strictEqual(rep.body.metaChecked, false, '替换后元数据检查必须作废');
  // 改稿 -> 复审通过被附件阻断
  const cur2 = await getEntry(e.id);
  await api.put(`/api/entries/${e.id}/original`, { baseVersion: cur2.original.version, sections: { ...cur2.original.sections, result: cur2.original.sections.result + '补充：附对比截图。' }, editor: '编辑A' });
  await approveAllSpans(e.id);
  const blocked = await api.post(`/api/entries/${e.id}/review`, { conclusion: 'approve', reviewer: '测试员' });
  assert.strictEqual(blocked.status, 409);
  assert.ok(blocked.body.blockers.some(b => b.includes('附件')), '应提示附件未检查');
  // 完成元数据检查后放行
  await api.post(`/api/attachments/${att.id}/meta-check`, { ok: true, findings: ['已清除 EXIF 定位信息'] });
  const ok = await api.post(`/api/entries/${e.id}/review`, { conclusion: 'approve', reviewer: '测试员', note: 'v4' });
  assert.strictEqual(ok.status, 200);
  await api.post(`/api/entries/${e.id}/publish`, { publicVersion: ok.body.public.version });
  await api.post('/api/jobs/run');
});

test('读者固定来源版本：?v= 返回历史公开稿，不被新版本带跑', async () => {
  const e = (await api.get('/api/state')).body.entries[0];
  const v2 = await api.get(`/api/entries/${e.id}/public?v=2`);
  assert.strictEqual(v2.status, 200);
  assert.strictEqual(v2.body.version, 2);
  assert.strictEqual(v2.body.pinned, true);
  assert.ok(v2.body.latestVersion >= 4, '应告知存在更新版本但不强制跳转');
  const noV = await api.get(`/api/entries/${e.id}/public`);
  assert.strictEqual(noV.body.version, noV.body.latestVersion, '不带 v 时给最新版');
  const bad = await api.get(`/api/entries/${e.id}/public?v=99`);
  assert.strictEqual(bad.status, 404);
});

test('项目转私密：四渠道撤回进度可见，完成后公开稿 410，且如实提示无法删除访客副本', async () => {
  const state = (await api.get('/api/state')).body;
  const e = state.entries[0];
  const w = state.works.find(x => x.id === e.workId);
  await api.post(`/api/works/${w.id}/visibility`, { visibility: 'private' });
  let ch = (await api.get(`/api/entries/${e.id}/channels`)).body;
  assert.strictEqual(ch.retraction.done, false);
  assert.ok(Object.values(ch.channels).every(c => c.status === 'retracting'), '各渠道应处于撤回中');
  await api.post('/api/jobs/run');
  ch = (await api.get(`/api/entries/${e.id}/channels`)).body;
  assert.strictEqual(ch.retraction.retracted, 4, '四个渠道都应撤回完成');
  assert.ok(ch.honesty.includes('无法承诺删除'), '必须保留诚实声明');
  const pub = await api.get(`/api/entries/${e.id}/public`);
  assert.strictEqual(pub.status, 410, '撤回后公开稿不可再访问');
  assert.ok(pub.body.retraction.done, '410 响应应携带撤回进度');
  // 搜索缓存也被清除
  const s = (await api.get('/api/search?q=账单')).body;
  assert.strictEqual(s.results.length, 0, '撤回后搜索缓存应清空');
  // 引用关系仍指向原项目快照，不跳转到无关项目
  const full = await getEntry(e.id);
  assert.strictEqual(full.workId, w.id);
  assert.strictEqual(full.workTitleSnapshot, 'Neo-Finance App');
});

(async () => {
  await new Promise(resolve => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  let pass = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      pass++;
      console.log(`✓ ${name}`);
    } catch (err) {
      console.error(`✗ ${name}\n  ${err.message}`);
      process.exitCode = 1;
      break;
    }
  }
  console.log(`\n${pass}/${tests.length} 项验收场景通过`);
  server.close();
})();
