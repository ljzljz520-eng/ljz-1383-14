-- 实习日记审稿流程：数据库逻辑结构（参考实现为内存表，字段与本文件一致）
-- 设计原则：原稿(revision)与公开派生稿(public_version)物理分离；
-- 所有公开渠道的文本只能引用 public_version，禁止直接读 revision。

CREATE TABLE entry (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  current_rev_id  TEXT,                      -- 当前工作修订（可被继续改写）
  status          TEXT NOT NULL DEFAULT 'editing',
                -- editing / awaiting_review / approved / revision_changed / withdrawn
  created_at      INTEGER NOT NULL
);

-- 不可变原稿修订。每次“保存改写”插入新行，绝不覆盖旧行。
CREATE TABLE revision (
  id           TEXT PRIMARY KEY,
  entry_id     TEXT NOT NULL REFERENCES entry(id),
  seq          INTEGER NOT NULL,             -- entry 内单调递增
  -- 四段式编辑：问题 / 行动 / 结果 / 反思
  problem      TEXT NOT NULL DEFAULT '',
  action       TEXT NOT NULL DEFAULT '',
  result       TEXT NOT NULL DEFAULT '',
  reflection   TEXT NOT NULL DEFAULT '',
  body_hash    TEXT NOT NULL,               -- 四段全文哈希，锚点漂移检测基准
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE(entry_id, seq)
);

CREATE TABLE review_task (
  id               TEXT PRIMARY KEY,
  entry_id         TEXT NOT NULL,
  revision_id      TEXT NOT NULL,           -- 被审的是某个不可变修订
  state            TEXT NOT NULL,           -- awaiting / approved / changes_requested / superseded / invalidated
  rule_scan_at     INTEGER,
  decided_by       TEXT,
  decided_at       INTEGER,
  decision_note    TEXT,
  lock_holder      TEXT,                    -- 乐观/检出锁：谁正在审
  lock_version     INTEGER NOT NULL DEFAULT 0,
  UNIQUE(revision_id)
);

-- 敏感片段。人工标注 source=human；规则命中 source=rule。
-- 锚点绑定“被标注时的修订 + 局部原文 + 序号/上下文”，不是全局字符偏移。
CREATE TABLE sensitive_span (
  id            TEXT PRIMARY KEY,
  revision_id   TEXT NOT NULL REFERENCES revision(id),
  section       TEXT NOT NULL,              -- problem/action/result/reflection
  start         INTEGER NOT NULL,
  end           INTEGER NOT NULL,
  match_text    TEXT NOT NULL,              -- 标注时刻的原文（锚点）
  kind          TEXT NOT NULL,              -- phone/email/idcard/bankcard/internal_ip/keyword/other
  source        TEXT NOT NULL,              -- human / rule
  status        TEXT NOT NULL DEFAULT 'active', -- active / dismissed
  dismiss_reason TEXT,
  rule_id       TEXT,
  origin_span_id     TEXT,             -- 继承自哪个旧片段
  origin_revision_id TEXT,             -- 从哪个旧修订继承
  needs_recheck  INTEGER NOT NULL DEFAULT 0, -- 自动重定位后必须人工复核
  drift_reason  TEXT,
  annotated_by  TEXT,
  confirmed_by  TEXT,
  triaged_by    TEXT,
  anchor_json   TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE rule_scan (
  id           TEXT PRIMARY KEY,
  revision_id  TEXT NOT NULL,
  triggered    TEXT NOT NULL,               -- JSON: [{rule_id,kind,...}]
  scan_engine  TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE project (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  is_private INTEGER NOT NULL DEFAULT 0
);

-- 日记 ↔ 项目作品的引用关系由数据库维护（不允许只靠正文里的裸链接）
CREATE TABLE entry_project_ref (
  id          TEXT PRIMARY KEY,
  entry_id    TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  relevance   TEXT NOT NULL DEFAULT '',  -- 防跳转：引用必须说明关联，读者返回仍回来源版本
  UNIQUE(entry_id, project_id)
);

-- 批准时冻结的公开稿快照：公开世界唯一可见的“版本”
CREATE TABLE public_version (
  id             TEXT PRIMARY KEY,
  entry_id       TEXT NOT NULL,
  revision_id    TEXT NOT NULL,             -- 派生自哪份原稿
  seq            INTEGER NOT NULL,          -- entry 内公开版序号，单调递增
  content_json   TEXT NOT NULL,             -- 已脱敏四段（服务端生成，非前端隐藏字段）
  content_hash   TEXT NOT NULL,
  approved_by    TEXT NOT NULL,
  approved_at    INTEGER NOT NULL,
  withdrawn      INTEGER NOT NULL DEFAULT 0,
  withdraw_reason TEXT NOT NULL DEFAULT '',
  UNIQUE(entry_id, seq)
);

-- 公开稿对项目的引用快照；项目转私密时据此撤回/裁剪，而不是跳到新项目
CREATE TABLE public_project_ref (
  id               TEXT PRIMARY KEY,
  public_version_id TEXT NOT NULL,
  project_id       TEXT NOT NULL,
  project_title    TEXT NOT NULL,          -- 冻结标题
  project_public   INTEGER NOT NULL,       -- 批准时是否公开
  relevance        TEXT NOT NULL
);

-- 附件单独建表，元数据另行检查（EXIF/GPS/作者/缩略图、文件名、图层备注）
CREATE TABLE attachment (
  id           TEXT PRIMARY KEY,
  revision_id  TEXT,                        -- 原稿附件
  sha256       TEXT NOT NULL,              -- 内容寻址：替换图片=新对象，旧 URL 仍指旧图
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL,
  metadata_ok  INTEGER NOT NULL DEFAULT 0,-- EXIF/GPS/作者字段检查通过
  metadata_note TEXT
);

CREATE TABLE public_attachment (
  id               TEXT PRIMARY KEY,
  public_version_id TEXT NOT NULL,
  attachment_id    TEXT NOT NULL,
  sha256           TEXT NOT NULL
);

-- 发布/撤回任务带 fencing token；迟到任务按“意图纪元”丢弃
CREATE TABLE publish_job (
  id          TEXT PRIMARY KEY,
  entry_id    TEXT NOT NULL,
  channel     TEXT NOT NULL,               -- web / search / rss / card / download
  kind        TEXT NOT NULL,               -- publish / withdraw
  pv_id       TEXT,
  intended_pv_seq INTEGER,                 -- 期望生效版本（防迟到覆盖）
  epoch       INTEGER NOT NULL,            -- 每 channel 单调的意图纪元
  state       TEXT NOT NULL DEFAULT 'queued', -- queued/done/failed/stale_dropped
  result_note TEXT,
  created_at  INTEGER NOT NULL,
  finished_at INTEGER
);

-- 每个渠道的“实际生效版本”（fencing：小纪元写入必须失败）
CREATE TABLE channel_state (
  entry_id        TEXT NOT NULL,
  channel         TEXT NOT NULL,
  effective_epoch INTEGER NOT NULL,
  effective_pv_id TEXT,
  effective_seq   INTEGER,
  status          TEXT NOT NULL,           -- live / withdrawing / withdrawn
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY(entry_id, channel)
);

-- 渠道实际渲染产物（只存公开稿派生出的文本）
CREATE TABLE channel_payload (
  id           TEXT PRIMARY KEY,
  entry_id     TEXT NOT NULL,
  channel      TEXT NOT NULL,
  pv_id        TEXT NOT NULL,
  pv_seq       INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  body         TEXT NOT NULL,
  rendered_at  INTEGER NOT NULL
);

-- 搜索/摘要缓存按内容哈希校验，旧 PV 或 PV 撤回一律 miss，不得返回陈旧摘要
CREATE TABLE search_snippet_cache (
  cache_key    TEXT PRIMARY KEY,           -- entry_id + pv_seq
  pv_id        TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  snippet      TEXT NOT NULL,
  refreshed_at INTEGER NOT NULL
);
