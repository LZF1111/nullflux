export function isTransientLLMError(error) {
  const parts = [];
  const seen = new Set();
  for (let current = error; current && !seen.has(current); current = current.cause) {
    seen.add(current);
    parts.push(String(current.message || current), String(current.code || ''));
    const status = Number(current.status ?? current.statusCode);
    if (status) parts.push(`HTTP ${status}`);
  }
  const text = parts.join(' ');
  if (/\b(401|403)\b|invalid[ _-]*model|model[^\n]*(not[ _-]found|does not exist|not exist|invalid)|未配置 API Key/i.test(text)) return false;
  return /\b(429|5\d\d)\b|fetch failed|time[ _-]?out|timed out|超时|ECONN\w*|ENET\w*|EHOST\w*|ENOTFOUND|EAI_AGAIN|UND_ERR_(CONNECT|HEADERS|BODY|SOCKET)|socket hang up|network error|terminated/i.test(text);
}

// 服务重启时正在执行的工具调用不会有 tool 响应：补占位响应，让任务可以继续（否则上游 400、恢复也被拒）
export function repairDanglingToolCalls(messages, content = '[未完成：服务重启中断了这次工具调用，结果未知，请重新检查状态]') {
  const answered = new Set((messages || []).filter(m => m && m.role === 'tool').map(m => m.tool_call_id));
  let fixed = 0;
  for (let i = 0; i < (messages || []).length; i++) {
    const m = messages[i];
    if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    const missing = m.tool_calls.filter(c => c && c.id && !answered.has(c.id));
    if (!missing.length) continue;
    // 插到该 assistant 后面已有 tool 响应的末尾，保持配对相邻
    let j = i + 1;
    while (j < messages.length && messages[j] && messages[j].role === 'tool') j++;
    messages.splice(j, 0, ...missing.map(c => ({ role: 'tool', tool_call_id: c.id, content })));
    for (const c of missing) answered.add(c.id);
    fixed += missing.length;
  }
  return fixed;
}

export class RecoveryManager {
  constructor({ persist, resume, canResume = () => true, isBusy = () => false,
    notify = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
    maxAttempts = 8, baseDelay = 30_000, maxDelay = 900_000, busyDelay = 5_000,
    // 长时无人值守任务：超过 maxAttempts 后不放弃，按 keepAliveDelay 持续重试（网络/隧道恢复后自动续跑）
    keepAlive = () => false, keepAliveDelay = 300_000 }) {
    Object.assign(this, { persist, resume, canResume, isBusy, notify, now, setTimer, clearTimer,
      maxAttempts, baseDelay, maxDelay, busyDelay, keepAlive, keepAliveDelay });
    this.timers = new Map();
    this.versions = new Map();
    this.active = new Set();
  }

  version(task) { return this.versions.get(task.id) || 0; }

  clear(task) {
    const timer = this.timers.get(task.id);
    if (timer !== undefined) this.clearTimer(timer);
    this.timers.delete(task.id);
  }

  cancel(task, reason = 'cancelled') {
    if (!task) return;
    this.clear(task);
    this.versions.set(task.id, this.version(task) + 1);
    task.recovery = { attempt: 0, nextAt: null,
      lastError: task.recovery?.lastError || '', status: 'cancelled', reason };
    this.persist(task);
  }

  success(task) {
    if (!task?.recovery) return;
    this.clear(task);
    task.recovery = { attempt: 0, nextAt: null, lastError: '', status: 'idle' };
    this.persist(task);
  }

  failure(task, error) {
    if (!task) return false;
    this.clear(task);
    const lastError = String(error?.message || error).slice(0, 1000);
    if (!isTransientLLMError(error)) {
      task.recovery = { attempt: task.recovery?.attempt || 0, nextAt: null, lastError, status: 'failed' };
      this.persist(task);
      this.notify(task);
      return false;
    }
    const previous = task.recovery?.attempt || 0;
    if (previous >= this.maxAttempts && this.keepAlive(task)) {
      task.recovery = { attempt: previous + 1, nextAt: this.now() + this.keepAliveDelay, lastError, status: 'pending', keepAlive: true };
    } else if (previous >= this.maxAttempts) {
      task.recovery = { attempt: previous, nextAt: null, lastError, status: 'exhausted' };
    } else {
      const attempt = previous + 1;
      task.recovery = { attempt, nextAt: this.now() + Math.min(this.maxDelay, this.baseDelay * 2 ** (attempt - 1)),
        lastError, status: 'pending' };
    }
    this.persist(task);
    this.notify(task);
    this.arm(task);
    return true;
  }

  arm(task) {
    this.clear(task);
    if (task.recovery?.status !== 'pending' || !this.canResume(task)) return;
    const state = task.recovery;
    const timer = this.setTimer(() => {
      this.timers.delete(task.id);
      return this.fire(task, state);
    }, Math.max(0, state.nextAt - this.now()));
    this.timers.set(task.id, timer);
    timer?.unref?.();
  }

  restore(tasks) {
    for (const task of tasks) {
      if (task.recovery?.status === 'running') {
        this.failure(task, new Error(`timeout: interrupted recovery request; ${task.recovery.lastError}`));
        continue;
      }
      if (task.recovery?.status === 'pending') {
        this.notify(task);
        this.arm(task);
      }
    }
  }

  async fire(task, state) {
    if (task.recovery !== state || state.status !== 'pending') return;
    if (!this.canResume(task)) { this.notify(task); return; }
    if (this.active.has(task.id) || this.isBusy(task)) {
      state.nextAt = this.now() + this.busyDelay;
      this.persist(task);
      this.arm(task);
      return;
    }
    task.recovery = { ...state, status: 'running', nextAt: null };
    this.persist(task);
    const version = this.version(task);
    this.active.add(task.id);
    try {
      await this.resume(task);
    } catch (error) {
      if (this.version(task) === version && task.recovery?.status === 'running') this.failure(task, error);
    } finally {
      this.active.delete(task.id);
    }
  }

  dispose() {
    for (const timer of this.timers.values()) this.clearTimer(timer);
    this.timers.clear();
  }
}