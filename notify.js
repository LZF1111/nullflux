// 外部通知：求解结束 / 需要审批 / 智能体提问 / 任务完成 / LLM 恢复失败 → 推送到手机。
// 支持 webhook 类型：wecom（企业微信群机器人）、dingtalk、feishu、ntfy、generic（POST JSON）。
// 同类事件 key 去抖（默认 60 s），发送失败只记日志，不影响主流程。

export const EVENT_KINDS = ['solver_done', 'approval', 'question', 'task_complete', 'recovery_failed'];

export function detectKind(url = '') {
  const u = String(url);
  if (/qyapi\.weixin\.qq\.com/.test(u)) return 'wecom';
  if (/oapi\.dingtalk\.com/.test(u)) return 'dingtalk';
  if (/open\.(feishu\.cn|larksuite\.com)/.test(u)) return 'feishu';
  if (/ntfy\.|\/\/[^/]*ntfy/.test(u)) return 'ntfy';
  return 'generic';
}

export function buildRequest(kind, url, { title, body, link, level }) {
  const text = `${title}\n${body || ''}${link ? `\n${link}` : ''}`.trim();
  const json = obj => ({ url, init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) } });
  switch (kind) {
    case 'wecom': return json({ msgtype: 'markdown', markdown: { content: `**${title}**\n${body || ''}${link ? `\n[打开](${link})` : ''}` } });
    case 'dingtalk': return json({ msgtype: 'markdown', markdown: { title, text: `### ${title}\n${body || ''}${link ? `\n\n[打开](${link})` : ''}` } });
    case 'feishu': return json({ msg_type: 'text', content: { text } });
    case 'ntfy': {
      const headers = { Title: encodeURIComponent(title), Priority: level === 'high' ? '4' : '3', Tags: level === 'high' ? 'warning' : 'white_check_mark' };
      if (link) headers.Click = link;
      return { url, init: { method: 'POST', headers, body: body || title } };
    }
    default: return json({ title, body, link, level, text });
  }
}

export function validateNotifyConfig(cfg = {}) {
  const out = { enabled: !!cfg.enabled, webhook: '', kind: '', events: [], publicUrl: '' };
  if (cfg.webhook) {
    let u; try { u = new URL(String(cfg.webhook)); } catch { throw new Error('通知 webhook 必须是 http(s) 地址'); }
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('通知 webhook 必须是 http(s) 地址');
    out.webhook = u.href;
  }
  out.kind = cfg.kind && cfg.kind !== 'auto' ? String(cfg.kind) : detectKind(out.webhook);
  if (!['wecom', 'dingtalk', 'feishu', 'ntfy', 'generic'].includes(out.kind)) throw new Error('未知通知类型');
  out.events = Array.isArray(cfg.events) ? cfg.events.filter(e => EVENT_KINDS.includes(e)) : [...EVENT_KINDS];
  if (cfg.publicUrl) {
    try { const p = new URL(String(cfg.publicUrl)); out.publicUrl = p.origin + p.pathname.replace(/\/+$/, ''); }
    catch { throw new Error('外部访问地址必须是 http(s) 地址'); }
  }
  return out;
}

export function createNotifier({ getConfig, fetchImpl = globalThis.fetch, log = console, now = () => Date.now(), dedupeMs = 60_000 }) {
  const last = new Map();
  const history = [];
  async function send(event) {
    const cfg = getConfig() || {};
    const entry = { ...event, ts: now(), delivered: false };
    history.push(entry); if (history.length > 100) history.shift();
    if (!cfg.enabled || !cfg.webhook) return entry;
    if (cfg.events && !cfg.events.includes(event.kind)) return entry;
    const key = event.key || `${event.kind}:${event.title}`;
    if (!event.force && last.has(key) && now() - last.get(key) < dedupeMs) { entry.skipped = 'dedupe'; return entry; }
    last.set(key, now());
    const link = event.link || (cfg.publicUrl ? `${cfg.publicUrl}/app${event.taskId ? `#task=${encodeURIComponent(event.taskId)}` : ''}` : '');
    const { url, init } = buildRequest(cfg.kind || detectKind(cfg.webhook), cfg.webhook, { ...event, link });
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 10_000);
    try {
      const r = await fetchImpl(url, { ...init, signal: ctl.signal });
      entry.delivered = !!r.ok; entry.status = r.status;
      if (!r.ok) log.warn?.(`[notify] ${event.kind} 发送失败 HTTP ${r.status}`);
    } catch (e) { entry.error = e.message; log.warn?.(`[notify] ${event.kind} 发送失败: ${e.message}`); }
    finally { clearTimeout(t); }
    return entry;
  }
  return { send, history: () => history.slice().reverse() };
}
