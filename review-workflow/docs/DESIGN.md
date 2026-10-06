# 实习日记精选 → 审稿流程 升级设计

## 1. 目标与边界

把“实习日记精选”从直接发布页面，升级为**带明确审阅结论的审稿流程**。站主按四段式
（问题 / 行动 / 结果 / 反思）编辑；后端同时保存**私密原稿**与**公开派生稿**两套数据；
网页、搜索索引、RSS、摘要卡、下载文本五个公开渠道只能从“已批准的公开稿”生成；
附件元数据另行检查；页面公开显示每个渠道的实际版本与撤回进度。

明确不承诺的事：撤回只能覆盖**本站控制的渠道**，无法删除访客已另存、截图、第三方转载的副本。

## 2. 数据模型（见 `../schema.sql`）

| 表 | 职责 |
|---|---|
| `entry` | 日记主对象与状态机（editing / awaiting_review / approved / revision_changed / withdrawn） |
| `revision` | **不可变原稿**。每次保存插入新行（`entry_id + seq`），永不覆盖；四段正文与 `body_hash` |
| `review_task` | 送审任务，绑定具体修订；含审阅锁与乐观版本 `lock_version`；结论必须有人、有决定、有备注 |
| `sensitive_span` | 敏感片段。`source=human/rule`；规则命中初始 `suggested`，需 confirm/dismiss（dismiss 必填理由） |
| `rule_scan` | 每次规则扫描的原始命中记录（审计） |
| `project` / `entry_project_ref` | 项目作品与引用关系由数据库维护；引用必须填“关联说明”，禁止只靠正文裸链接 |
| `public_version` | 批准时冻结的**公开派生稿**：服务端脱敏后的四段全文 + `content_hash`；可撤回 |
| `public_project_ref` | 公开稿冻结时的项目引用快照（标题、当时公开状态、关联依据） |
| `attachment` / `public_attachment` | 附件按 sha256 内容寻址；EXIF/GPS、作者、批注等元数据检查结果单独存 |
| `publish_job` | 发布/撤回任务，带 `epoch`（渠道意图纪元）与 `intended_pv_seq` |
| `channel_state` | 每渠道**实际生效**版本（fencing token = epoch） |
| `search_snippet_cache` | 搜索摘要缓存，按 `pv_id + content_hash` 双重校验 |

关键隔离：

- 原稿库与公开库是两套行；公开服务端代码路径里**不存在**读取 `revision` 渲染渠道的可能，
  脱敏不是“前端隐藏字段”，而是批准时生成一份已替换为【已隐去】的新文本（`public_version.content_json`）。
- 渠道渲染见 `lib/channels.js`：`renderForChannel(channel, pv, db)` 的入参类型就是公开稿，
  搜索索引文本、RSS 描述、卡片摘要、下载文本全部来自 `pv.content_json`。

## 3. 站主编辑：四段式与并发

- 编辑器固定四段：问题、行动、结果、反思。保存即生成新 `revision`（不可变）。
- `commitRevision(entryId, content, user, baseRevId)` 做乐观并发：
  两人同时基于 rev N 改写时，先到者生成 rev N+1，后到者得到 `REVISION_CONFLICT`，
  必须拉取最新修订、人工合并后再保存（验收①）。
- 原稿在**已批准之后**再被改写：`entry.status = revision_changed`；旧公开稿继续在线，
  直到新版走完审阅；进行中的旧审阅任务置 `superseded`。

## 4. 敏感内容：人工标注 vs 规则辅助

规则（`lib/rules.js`，正则 + Luhn 启发式）只覆盖：直写手机号、邮箱、18 位身份证、
16–19 位银行卡、内网 IP（10/8、192.168/16、172.16/12）、密钥/隐私词。

**规则的遗漏（FN，页面上也公开声明）**：

1. 语义敏感：未点名的人物指代、客户内部代号、可被推断的身份组合（岗位+部门+时间）。
2. 文本变形：全角数字、插空格/符号、拼音谐音、图片中的文字（无 OCR）。
3. 附件与元数据：EXIF 的 GPS、相机序列号、文档作者、PDF 图层/批注——正文规则完全不可见。
4. 跨文本关联：单句无敏感词，但与历史日记或外部信息组合后可定位个人。

**规则的误报（FP）**：已公开的客服邮箱/400 电话、文档示例号、满足 Luhn 的订单号/工单号、
技术文章里的网段与示例 token。

处置规则：

- 规则命中写入 `status=suggested` 的片段，审校必须逐条 `confirm` 或 `dismiss`；
  dismiss（判为误报放行）**必须填写理由**，未处置完不能批准。
- 人工标注（`source=human`）是最终依据；规则漏报由人工补标。
- 因此“规则零命中”永远不等于“可以发布”。

**附件元数据另行检查**（`checkAttachmentMeta`）：GPS、作者授权、相机序列号、
批注/图层备注中的敏感词、疑似内部来源的文件名；任一项不过，批准被拒（验收⑤）。

## 5. 脱敏锚点与原稿改写后的漂移

片段位置不能用“全局字符偏移”长期表示。锚点为：
`{section, match_text, ordinal(同文本在本段第几次出现), prefix/suffix(前后各12字原文)}`。

改写提交时（`relocateSpans`）：

1. 段落未变且原文仍在原位置 → `unchanged`；
2. 原文在新段中**唯一**出现且前/后上下文一侧完全一致 → `relocated`，写入新偏移并打
   `needs_recheck=1`（自动重定位不等于自动确认，仍需人工复核）；
3. 原文多处出现（多义）、唯一出现但上下文已变、或原文被删除/改写 → `drifted`，
   片段置 `status=drifted`，**绝不按旧偏移套新文字**。

批准门禁：存在 `drifted` 片段 → `ANCHOR_DRIFT` 拒绝；存在待复核片段 → `RECHECK_PENDING` 拒绝。
处置路径只能是：在新修订上重新人工标注，或确认敏感文本已随改写消失后丢弃（`resolveDrift`）。

## 6. 送审、批准与公开稿派生

状态机：`editing → awaiting_review →（changes_requested → editing）→ approved`；
改写后回到 `revision_changed → awaiting_review`。

- 审阅锁：`acquireReviewLock` + `lock_version` CAS，避免两人同时给出结论。
- 批准（`approve`）需要显式结论：审阅人 + 非空结论文字。系统自动执行门禁：
  规则建议全部处置、无漂移锚点、无待复核重定位、附件元数据全部通过、
  引用项目当前全部公开。
- 门禁通过后，服务端执行脱敏（`maskContent`）生成不可变 `public_version`，
  冻结项目引用快照、附件快照，然后给五个渠道各入一条 epoch 递增的发布任务。
- 撤回同样逐渠道入任务，渠道状态经 `withdrawing` 到 `withdrawn`，进度可查。

## 7. 发布任务、迟到任务与 fencing

每渠道维护 `channel_state.effective_epoch`；每个任务带自己的 epoch 与目标版本序号。

- 处理任务时，若同渠道已有 epoch 更大、更新版本的意图（排队或完成），旧任务直接
  `stale_dropped`——即使它“晚到”，也不允许先把旧版发出去再覆盖（验收②）。
- 撤回任务若发现渠道实际版本已新于撤回目标（迟到撤回），同样丢弃，不能撤掉新版本。
- 已撤回的公开稿上的迟到发布任务 → `failed`。
- 任务执行采用“先快照队列再遍历”（`drainJobs`），避免边改状态边遍历跳过渠道。

## 8. 项目转私密的级联

`setProjectPrivate` 后：所有引用该项目、且当前在线的公开稿被标记撤回，五渠道入撤回任务，
搜索缓存立即失效；仍在审稿中的日记在批准门禁处被拦（`PROJECT_PRIVATE`）。

读者侧（`resolveReader`）：

- 链接按版本解析（`?pv=seq`）：旧链接返回旧版本内容与冻结的引用快照；
- 该版本被撤回时显示撤回说明与原因，`auto_redirect=false`，**不跳到新项目**；
- 已转私密的项目在快照里标 `project_now_private`，链接禁用但保留关联文字，保证来源语境不丢。

## 9. 搜索与缓存一致性

- 只有 search 渠道任务执行成功才写 `search_snippet_cache`（摘要也来自公开稿）。
- `searchLookup` 命中条件：search 渠道 live、pv 未撤回、缓存存在且
  `pv_id + content_hash` 全部一致；并且渠道待生效版本必须就是最新公开版。
- 新版已批准但搜索渠道任务还没跑（缓存尚未刷新）→ 返回 miss 并标 `stale`，
  宁可搜不到也不展示跨版本旧摘要（验收④）；撤回时缓存内容清空。

## 10. 附件替换

附件内容寻址（sha256）：替换图片 = 新对象 + 新修订上的新附件行；旧公开稿的
`public_attachment` 仍指向旧 sha256，旧版本页面/下载拿到的永远是旧图。
新图未通过元数据检查前，新版本不能批准上线（验收⑤）。

## 11. 公开状态页

`review-status.html` 展示每篇日记在 web/search/rss/card/download 五渠道的：
实际状态、实际生效版本号、排队任务数，以及每个公开版本的撤回状态与原因；
底部固定展示规则检测的遗漏与误报清单、以及“无法删除访客另存副本”的声明。
数据来自 `node review-workflow/demo.js` 生成的 `data/status.json`，页面带内联兜底快照。

## 12. 验收场景与测试对照

| 验收点 | 测试 |
|---|---|
| 两人同时改写 | `acceptance.test.js` 用例 1（REVISION_CONFLICT + 合并后提交） |
| 旧发布任务晚到 | 用例 2（stale_dropped，渠道保持 v2） |
| 项目改为私密 | 用例 3（级联撤回、搜索失效、旧链接停留来源版本） |
| 缓存搜索摘要未刷新 | 用例 4（滞后 miss，刷新后恢复） |
| 图片替换 | 用例 5（旧链接仍旧图 sha，带 GPS 新图拒绝发布） |
| 锚点漂移 | 锚点专项用例（唯一位移需复核；多义判 drifted 且门禁拒绝） |
| 脱敏在派生端 | 渠道文本断言不含原稿手机号 |
| 规则 FN/FP | 全角变形/语义漏报、白名单邮箱不再提示 |

运行：

```bash
node --test review-workflow/test/     # 9 个测试
node review-workflow/demo.js          # 生成 data/status.json
```

## 13. 生产化清单（参考实现未做）

- 内存 Store 换成支持事务的关系库（审批、CAS、入队需在一个事务内）。
- 发布任务接真实队列与死信表；渠道渲染结果加签名与 CDN 按版本路径分发（不可变 URL）。
- 图片接 EXIF 剥离流水线与 OCR 复扫；规则引擎可热更新但每次扫描记录引擎版本。
- 审计日志（谁在何时改了哪条标注/结论）追加写，只增不改。
