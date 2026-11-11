// 智能体循环的纯逻辑（对照 OpenCode core：edit 匹配、LLM 重试分类与退避、工具输出落盘）。无副作用的函数放这里，便于单测。
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------- 编辑匹配
// 弯引号、各种破折号、特殊空格 → ASCII。逐字符替换，长度不变，所以下标可以直接对应回原文。
const _normChars = s => s
  .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
  .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
  .replace(/[\u2010-\u2015\u2212]/g, '-')
  .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ');
const _allIndexes = (hay, needle) => {
  const out = [];
  if (!needle) return out;
  for (let i = hay.indexOf(needle); i !== -1 && out.length < 50; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
};
const _lineNo = (text, idx) => text.slice(0, idx).split('\n').length;

// 在 content 里找 oldStr。依次尝试：原样 → 引号/破折号/空格归一 → 逐行忽略行尾空白。
// 返回 { ok: true, spans: [[start, end], ...], how } 或 { ok: false, error }
export function findEditMatch(content, oldStr) {
  if (typeof oldStr !== 'string' || oldStr === '') return { ok: false, error: 'old_str 为空' };
  let hits = _allIndexes(content, oldStr);
  if (hits.length) return { ok: true, how: 'exact', spans: hits.map(i => [i, i + oldStr.length]) };
  const nc = _normChars(content), no = _normChars(oldStr);
  hits = _allIndexes(nc, no);
  if (hits.length) return { ok: true, how: '引号/破折号/空格归一后匹配', spans: hits.map(i => [i, i + oldStr.length]) };
  // 逐行：忽略每行行尾空白（含 \r）
  const lines = [];
  for (let pos = 0; pos <= nc.length;) {
    const e = nc.indexOf('\n', pos); const end = e === -1 ? nc.length : e;
    lines.push({ start: pos, end, key: nc.slice(pos, end).replace(/\s+$/, '') });
    if (e === -1) break; pos = e + 1;
  }
  let want = no.split('\n').map(l => l.replace(/\s+$/, ''));
  let trailingNl = false;
  if (want.length > 1 && want[want.length - 1] === '') { want.pop(); trailingNl = true; }
  const spans = [];
  if (want.some(l => l !== '')) {
    for (let i = 0; i + want.length <= lines.length; i++) {
      let k = 0; while (k < want.length && lines[i + k].key === want[k]) k++;
      if (k !== want.length) continue;
      const last = lines[i + want.length - 1];
      spans.push([lines[i].start, trailingNl && last.end < content.length ? last.end + 1 : last.end]);
    }
  }
  if (spans.length) return { ok: true, how: '忽略行尾空白后匹配', spans };
  return { ok: false, error: _missHint(content, oldStr) };
}

// 没找到时给模型看「最接近的几行」，免得它盲目重试
function _missHint(content, oldStr) {
  const strip = s => s.replace(/\s+/g, '');
  const cl = content.split('\n'), ol = oldStr.split('\n');
  const index = new Map();
  cl.forEach((l, i) => { const k = strip(l); if (k) { if (!index.has(k)) index.set(k, []); index.get(k).push(i); } });
  const votes = new Map(); let voters = 0;
  ol.forEach((l, k) => {
    const key = strip(l); if (!key) return; voters++;
    for (const i of (index.get(key) || []).slice(0, 20)) votes.set(i - k, (votes.get(i - k) || 0) + 1);
  });
  let best = null, bestN = 0;
  for (const [s, n] of votes) if (n > bestN) { best = s; bestN = n; }
  if (best === null || bestN * 2 < voters) return '未找到 old_str（文件里没有相近的行）。先 read_file 看当前内容再改。';
  const from = Math.max(0, best), to = Math.min(cl.length, from + Math.min(ol.length, 12));
  const shown = cl.slice(from, to).map((l, i) => `${from + i + 1}: ${l.slice(0, 200)}`).join('\n');
  return `未找到 old_str：缩进或个别字符与文件不一致。文件里最接近的几行是：\n${shown}\n请按这些行的原样（含缩进）重写 old_str。`;
}

// 应用一次编辑。唯一匹配才改（replaceAll 例外）。纯 CRLF 文件按 LF 匹配后还原 CRLF。
export function applyEdit(content, oldStr, newStr, replaceAll = false) {
  if (typeof newStr !== 'string') return { ok: false, error: 'new_str 必须是字符串' };
  if (oldStr === newStr) return { ok: false, error: 'old_str 与 new_str 相同，没有可改的内容' };
  const pureCrlf = content.includes('\r\n') && !/(^|[^\r])\n/.test(content);
  const lf = s => s.replace(/\r\n/g, '\n');
  const src = pureCrlf ? lf(content) : content;
  const o = pureCrlf ? lf(oldStr) : oldStr, n = pureCrlf ? lf(newStr) : newStr;
  const m = findEditMatch(src, o);
  if (!m.ok) {
    if (n && src.includes(n)) return { ok: false, error: 'new_str 已经在文件里，这次修改可能已经生效，不必重试。' };
    return m;
  }
  if (m.spans.length > 1 && !replaceAll) {
    const at = m.spans.slice(0, 6).map(s => _lineNo(src, s[0])).join('、');
    return { ok: false, error: `old_str 匹配 ${m.spans.length} 处（第 ${at} 行）。请多带几行上下文让它唯一。` };
  }
  let out = '', pos = 0;
  for (const [s, e] of m.spans) { out += src.slice(pos, s) + n; pos = e; }
  out += src.slice(pos);
  return { ok: true, content: pureCrlf ? out.replace(/\n/g, '\r\n') : out, count: m.spans.length, how: m.how, line: _lineNo(src, m.spans[0][0]) };
}

// ---------------------------------------------------------------- LLM 重试
const OVERFLOW_RE = /context[_ ]?length|maximum context|context window|prompt is too long|too many (input )?tokens|input is too long|exceeds? (the )?(model'?s? )?(max(imum)?) (context|input|token)|reduce the length|request too large|上下文[^\n]{0,8}(超|过长)|超出[^\n]{0,8}(上下文|长度上限)/i;
// 返回 'retry' | 'fatal' | 'overflow'。x-should-retry 头优先。
export function classifyLlmHttp(status, bodyText = '', shouldRetryHeader = null) {
  const body = String(bodyText || '');
  if ((status === 400 || status === 413 || status === 422) && OVERFLOW_RE.test(body)) return 'overflow';
  if (shouldRetryHeader === 'true') return 'retry';
  if (shouldRetryHeader === 'false') return 'fatal';
  if (status === 401 || status === 403 || status === 402) return 'fatal';
  if (status === 429) return /quota|insufficient|billing|余额|欠费|额度(不足|已用)/i.test(body) ? 'fatal' : 'retry';
  if (status === 408 || status === 409 || status >= 500) return 'retry';
  return 'fatal';
}
// retry-after-ms / retry-after（秒或 HTTP 日期）→ 毫秒；没有则 null
export function parseRetryAfter(getHeader, now = Date.now()) {
  const ms = Number(getHeader('retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const ra = getHeader('retry-after');
  if (!ra) return null;
  const sec = Number(ra);
  if (Number.isFinite(sec) && sec >= 0) return sec * 1000;
  const at = Date.parse(ra);
  return Number.isFinite(at) && at > now ? at - now : null;
}
// 第 n 次重试前等多久：min(2s·2^(n-1), 10s)·抖动(0.8–1.2)，不短于服务端给的 retry-after
export function llmRetryDelay(attempt, retryAfterMs = null, rand = Math.random) {
  const base = Math.min(2000 * 2 ** (Math.max(1, attempt) - 1), 10_000) * (0.8 + 0.4 * rand());
  return Math.round(Math.max(base, retryAfterMs || 0));
}
export const isNetworkError = msg => /ECONN\w*|ENET\w*|EHOST\w*|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|network|UND_ERR_\w+|terminated|incomplete stream/i.test(String(msg || ''));
export const isTimeoutError = msg => /time[ _-]?out|timed out|超时|TimeoutError/i.test(String(msg || ''));

// ---------------------------------------------------------------- 工具输出落盘
// 过长的工具输出：模型只拿到头尾，全文存到工作区 .nullflux/tool-output/，并告诉模型路径（可 read_file 分段读）
export function clipToolOutput(text, { max = 20_000, dir, relBase, name = 'tool', now = Date.now() }) {
  const s = text == null ? '' : String(text);
  if (s.length <= max) return s;
  let hint = '';
  if (dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const gi = path.join(dir, '.gitignore'); if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
      const file = path.join(dir, `${now.toString(36)}_${String(name).replace(/\W+/g, '_').slice(0, 40)}.txt`);
      fs.writeFileSync(file, s);
      const shown = (relBase ? path.relative(relBase, file) : file).split(path.sep).join('/');
      hint = `；完整输出（${s.split('\n').length} 行）已存 ${shown}，需要时用 read_file 的 start_line/end_line 分段读或 grep_search 搜`;
    } catch (e) { hint = ''; }
  }
  const head = s.slice(0, Math.floor(max * 0.7)), tail = s.slice(-Math.floor(max * 0.2));
  return head + `\n...[已截断：原文 ${s.length} 字符，仅保留头尾${hint}]...\n` + tail;
}
export function sweepToolOutput(dir, maxAgeMs = 7 * 86_400_000, now = Date.now()) {
  let removed = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f === '.gitignore') continue;
      const p = path.join(dir, f);
      try { if (now - fs.statSync(p).mtimeMs > maxAgeMs) { fs.unlinkSync(p); removed++; } } catch (e) { continue; }
    }
  } catch (e) { return removed; }
  return removed;
}
