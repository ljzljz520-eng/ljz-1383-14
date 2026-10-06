# 实习日记审稿流程（参考实现）

无外部依赖，Node >= 18（使用内置 `node:test`、`node:crypto`）。

```bash
node --test test/       # 验收测试（9 个）
node demo.js            # 端到端演示，生成 ../data/status.json
```

然后用 HTTP 方式打开站点根目录下的 `review-status.html`（例如
`python3 -m http.server` 后访问 `/review-status.html`）；直接 file:// 打开时页面使用内嵌兜底快照。

## 目录

- `schema.sql` — 逻辑库表（原稿/公开稿分离、引用关系、任务 fencing、搜索缓存）
- `lib/workflow.js` — 审稿核心：四段式改写并发、标注/triage、漂移门禁、批准派生、撤回、级联、读者版本解析
- `lib/rules.js` — 规则辅助检测及其遗漏/误报声明
- `lib/anchors.js` — 脱敏锚点与改写后的重定位/漂移判定
- `lib/channels.js` — web/search/rss/card/download 五渠道，只能渲染批准公开稿
- `lib/store.js` — 带 CAS 的内存表（生产替换为事务型关系库）
- `test/acceptance.test.js` — 五个验收场景 + 锚点/规则/派生测试
- `docs/DESIGN.md` — 完整设计说明
