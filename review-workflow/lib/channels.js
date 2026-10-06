// 公开渠道渲染：web 正文 / 搜索索引 / RSS / 摘要卡 / 下载文本。
// 铁律：输入只能是 public_version（已脱敏的 content_json），
// 任何渠道都不得读取 revision 原稿或“全文+遮罩字段”的前端数据。
import { SECTION_LABEL } from './util.js';

const LABELS = SECTION_LABEL;

function pvContent(pv) {
  return JSON.parse(pv.content_json);
}

function refsText(db, pv) {
  const refs = db.find('public_project_ref', (r) => r.public_version_id === pv.id);
  if (!refs.length) return '';
  return refs
    .map((r) => `关联项目：${r.project_title}（关联依据：${r.relevance}${r.project_public ? '' : '；该项目当前非公开'}）`)
    .join('\n');
}

function attachmentsText(db, pv) {
  const atts = db.find('public_attachment', (a) => a.public_version_id === pv.id)
    .map((a) => db.mustGet('attachment', a.attachment_id));
  if (!atts.length) return '';
  return atts.map((a) => `附件：${a.filename}（${a.content_type}，元数据检查：${a.metadata_note || '通过'}）`).join('\n');
}

export function renderForChannel(channel, pv, db) {
  const c = pvContent(pv);
  const sections = ['problem', 'action', 'result', 'reflection'];
  const base = sections.map((k) => `【${LABELS[k]}】\n${c[k]}`).join('\n\n');
  const refs = refsText(db, pv);
  const atts = attachmentsText(db, pv);
  const header = `公开版 v${pv.seq} · 批准人：${pv.approved_by}`;

  switch (channel) {
    case 'web':
      return { body: [header, base, refs, atts].filter(Boolean).join('\n\n') };
    case 'download':
      // 下载文本同样来自公开稿；元数据另行说明，不回传原图原始字节描述
      return { body: [header, base, refs, atts, '（本文为脱敏公开稿，不包含原稿及附件原始元数据）'].filter(Boolean).join('\n\n') };
    case 'rss':
      return { body: [`<item><title>实习日记公开版 v${pv.seq}</title>`,
        `<description><![CDATA[ ${sections.map((k) => `${LABELS[k]}：${c[k]}`).join(' ／ ')} ]]></description>`,
        `<pubVersion>${pv.seq}</pubVersion></item>`].join('') };
    case 'card':
      return {
        body: JSON.stringify({
          version: pv.seq,
          problem: c.problem.slice(0, 60),
          result: c.result.slice(0, 60),
          hash: pv.content_hash,
        }),
      };
    case 'search': {
      // 搜索索引与摘要：只索引已脱敏内容
      const indexText = sections.map((k) => c[k]).join(' ');
      const snippet = `${c.problem.slice(0, 40)}… 结果：${c.result.slice(0, 40)}… [v${pv.seq}]`;
      return { body: JSON.stringify({ pv_seq: pv.seq, indexText }), snippet };
    }
    default:
      throw new Error(`unknown channel ${channel}`);
  }
}
