# 实习日记精选 · 审稿流程设计文档

> 运行：`node server/server.js`（默认 8080）→ 审稿台 `/review.html`，公开页 `/diary.html`。
> 验收测试：`node server/test.js`（9 项场景全自动化）。

## 1. 角色与双稿制数据模型

站主在审稿台编辑日记的四个固定段落——**问题 / 行动 / 结果 / 反思**。系统为每篇日记同时维护两份文本：

| 数据 | 可见性 | 说明 |
|---|---|---|
| `original` 私密原稿 | 仅审稿台 | 带版本号 `version`，每次保存 +1，乐观锁防并发覆盖 |
| `public` 公开派生稿 | 所有公开渠道的唯一来源 | 由"原稿 + 已批准脱敏片段"派生，记录 `fromOriginalVersion`、审阅人、审阅结论 |
| `publicHistory` | 读者可固定 | 历史公开稿快照，支撑 `?v=` 版本固定 |
| `spans` 敏感片段 | 仅审稿台 | 锚点（exact+前后文）而非裸偏移 |
| `workId` + `workTitleSnapshot` | 引用项目作品 | 数据库级引用 + 标题快照：项目改名/转私密后，日记仍指向原来源，**绝不跳转到内容不相干的新项目** |

条目状态机：`draft → pending_review → approved → published → (retracting →) retracted`。

## 2. 脱敏派生：不止隐藏页面字段

公开稿是**唯一**的公开事实来源。审阅通过时用已批准片段把原稿中的敏感文字替换为 `［已隐去］`，生成公开稿；随后所有渠道的分发物都由公开稿生成，任何渠道都接触不到原稿：

- **搜索索引**：`search` 渠道的缓存摘要（标题+摘录）来自公开稿；
- **RSS**：`/rss.xml` 只拼接 `rss` 渠道已发布的 artifact；
- **摘要卡**：`/api/entries/:id/card.json` 来自 `card` 渠道 artifact；
- **下载文本**：`/api/entries/:id/download.txt` 来自 `download` 渠道 artifact；
- **附件元数据另行检查**：图片附件有独立的 `metaChecked` 闸门（EXIF 定位、设备号、拍摄时间等）。**换图即作废**检查结论，未重新检查前审阅与发布都被阻断（`approveBlockers`）。

## 3. 规则辅助检测 vs 人工标注

规则库（`server/redact.js`）覆盖手机号、邮箱、身份证、银行卡、QQ 五类模式。`/api/entries/:id/compare` 现场重跑规则并与人工标注比对，输出三类结果：

- **共同命中**：如 `13912345678`、工作邮箱——规则可靠，但仍需人工批准才生效；
- **规则遗漏（misses）**：如同事姓名「王芳」、宿舍地址「滨江路 88 号」。这类敏感信息**依赖上下文语义**（谁知道这是真名/现住址），正则无法穷举，还可能涉及未公开的项目代号、内部花名、客户简称等规则完全没有先验知识的类别；
- **规则误报（false positives）**：如订单号 `13800138000` 恰好形如手机号。规则不理解"这是订单号不是电话"的语境；类似的还有版本号、金额、长编号被 QQ/银行卡规则误吞。

结论：**规则只是候选生成器**。发布前必须满足——所有候选片段逐一批准或驳回（无 `pending`）、无失效锚点、附件元数据已检，然后由审阅人给出**明确的审阅结论**（通过/退回 + 意见），系统才会派生公开稿。误报片段由人工驳回并留痕，不进入公开稿。

## 4. 原稿漂移：锚点不得误套新文字

脱敏锚点保存 `exact 原文 + 前后各 24 字上下文`，不以裸偏移为凭。原稿每次保存后（`PUT /original`）对所有有效片段**重新定位**：

- 原文在新文本中唯一命中 → 更新偏移，批准状态保留；
- 多处命中 → 用前后文打分，唯一最佳才接受；
- 找不到或有歧义 → 标记 `stale`（失效），**绝不把旧偏移套到新文字上**；只要存在失效锚点，条目立即回到 `pending_review`，已批准的公开稿保持旧版不自动重派生；
- 失效锚点不能被直接批准，只能"重新定位"（成功后回到 `pending`，需重新批准）或"驳回"。

## 5. 并发与迟到的任务（验收场景）

| 场景 | 机制 | 结果 |
|---|---|---|
| **两人同时改写** | 保存需携带 `baseVersion`，不一致返回 409 并附最新内容 | 后写者收到冲突提示，先写者内容不被静默覆盖 |
| **旧发布任务晚到** | 发布任务携带目标公开稿版本；入队时校验，worker 执行时**再校验一次** | 针对 v1/v2 的迟到任务在 v3 时代被丢弃并记审计，渠道不被旧版本污染 |
| **项目改为私密** | 引用该项目的条目全部渠道置 `retracting`，逐渠道生成撤回任务 | 撤回进度（n/4）实时可见；完成后公开稿返回 410，搜索缓存清空 |
| **搜索摘要缓存未刷新** | 搜索只读缓存；新版本发布后缓存版本 ≠ 发布版本 | 响应如实标记 `stale: true` 并给出缓存版本，显式刷新任务后才一致——**绝不现场用原稿重建索引** |
| **图片替换** | 替换即作废 `metaChecked` | 审阅/发布被阻断，直至元数据复检通过 |

## 6. 版本展示、撤回进度与诚实声明

公开详情页（`diary-detail.html`）展示：

- 当前查看的公开版本（`?v=` 固定时显示"历史版本 vN，最新为 vM"）；
- **各公开渠道的实际版本与状态表**（搜索/RSS/摘要卡/下载各自的 publishedVersion、撤回进度条）；
- 诚实声明：**本站只能撤回本站渠道；访客此前另存、截图或转载的副本不在控制范围内，无法承诺删除**；
- 来源项目引用固定：项目转私密后显示快照标题并停止跳转，读者不会被打包送去无关的新项目；
- 读者带 `?v=` 返回时保持来源版本（410 场景除外），不带时给最新版。

## 7. API 摘要

```
GET  /api/state                        审稿台总览
POST /api/entries                      新建条目（关联 workId）
PUT  /api/entries/:id/original         改原稿（baseVersion 乐观锁；触发锚点重定位）
POST /api/entries/:id/detect           规则检测（与既有片段去重）
POST /api/entries/:id/spans            人工标注
POST /api/entries/:id/spans/:sid/decision   approve / dismiss
POST /api/entries/:id/spans/:sid/reanchor   失效锚点重新定位 → 回到待审
GET  /api/entries/:id/compare          人工 vs 规则（遗漏/误报）
POST /api/entries/:id/review           审阅结论（通过 → 派生公开稿）
POST /api/entries/:id/publish          发布（携带 publicVersion，入队）
POST /api/entries/:id/refresh-search   刷新搜索缓存（入队）
POST /api/works/:id/visibility         项目公开/私密（私密 → 撤回任务）
PUT  /api/attachments/:aid/replace     换图（元数据检查作废）
POST /api/attachments/:aid/meta-check  附件元数据检查
POST /api/jobs/run                     执行任务队列（worker）
GET  /api/entries/:id/public?v=N       读者视角（版本固定 / 410+撤回进度）
GET  /api/search?q=                    搜索（只读缓存，stale 如实标记）
GET  /rss.xml                          RSS（仅已发布 artifact）
GET  /api/entries/:id/card.json        摘要卡
GET  /api/entries/:id/download.txt     下载文本
```

## 8. 已知边界

- JSON 文件存储适合单站主场景；多审阅人并发审批时建议迁移到带事务的数据库（模型已按表结构设计：entries/spans/channels/jobs 可直接映射）。
- 规则库是演示级正则；生产可接入 NER/词典，但"明确审阅结论"的闸门不变。
- 撤回是"尽力而为"：第三方搜索引擎缓存、互联网档案馆等站外副本同样适用第 6 节的诚实声明。
