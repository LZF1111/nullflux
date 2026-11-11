export function apiDefaults(env = {}) {
  return {
    provider: 'openai',
    apiKey: env.OPENAI_API_KEY || env.DEEPSEEK_API_KEY || '',
    baseUrl: env.OPENAI_BASE_URL || env.DEEPSEEK_BASE_URL || '',
    model: env.OPENAI_MODEL || env.DEEPSEEK_MODEL || '',
    visionProvider: 'openai', visionBaseUrl: '', visionModel: '', visionApiKey: ''
  };
}

export function chatCompletionsUrl(baseUrl) {
  let url;
  try { url = new URL(typeof baseUrl === 'string' ? baseUrl.trim() : ''); }
  catch { throw new Error('请配置有效的 http(s) Base URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Base URL 必须是 http(s) 地址，且不能包含用户名或密码');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = /\/chat\/completions$/.test(pathname) ? pathname
    : /\/v1$/.test(pathname) ? pathname + '/chat/completions'
    : pathname + '/v1/chat/completions';
  url.hash = '';
  return url.href;
}

function modelId(model) {
  if (typeof model !== 'string' || !model.trim()) throw new Error('请配置非空模型 ID');
  return model.trim();
}

function localEndpoint(url) {
  const hostname = new URL(url).hostname;
  return ['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(hostname) || hostname.endsWith('.local');
}

export function resolveChatConfig(settings, { vision = false } = {}) {
  const dedicated = vision && !!(settings.visionBaseUrl || settings.visionModel);
  if (!dedicated && settings.provider === 'copilot') return { provider: 'copilot', dedicated: false };
  const url = chatCompletionsUrl(dedicated ? settings.visionBaseUrl || settings.baseUrl : settings.baseUrl);
  const model = modelId(dedicated ? settings.visionModel || settings.model : settings.model);
  let apiKey = settings.apiKey || '';
  if (dedicated) {
    apiKey = settings.visionApiKey || '';
    if (!apiKey && settings.provider !== 'copilot' && settings.baseUrl &&
        new URL(url).origin === new URL(chatCompletionsUrl(settings.baseUrl)).origin) {
      apiKey = settings.apiKey || '';
    }
  }
  const isLocal = localEndpoint(url) || (settings.provider === 'local' && (!dedicated || !settings.visionBaseUrl));
  if (!apiKey && !isLocal) throw new Error(dedicated
    ? '请配置独立视觉 API Key；跨域视觉接口不会复用主 API Key'
    : '请配置 API Key（通用 API 设置）');
  return { provider: 'openai', url, model, apiKey, dedicated };
}

// 多个接口并存：settings.providers = [{ id, name, baseUrl, apiKey, models: [] }]，主接口（settings.baseUrl/model）的 id 固定为 'main'。
// ref = { provider, model } 指定某个任务用哪个接口的哪个模型；不给或找不到就回到主接口。
export function settingsForRef(settings, ref) {
  if (!ref || !ref.model) return settings;
  if (!ref.provider || ref.provider === 'main') return settings.provider === 'copilot' ? settings : { ...settings, model: ref.model };
  const p = (settings.providers || []).find(x => x.id === ref.provider);
  if (!p) return settings;
  return { ...settings, provider: 'openai', baseUrl: p.baseUrl, apiKey: p.apiKey || '', model: ref.model };
}

export function validateProvider(p) {
  if (!p || typeof p !== 'object') throw new Error('接口配置格式不对');
  const name = String(p.name || '').trim();
  if (!name) throw new Error('请给接口起个名字');
  chatCompletionsUrl(p.baseUrl);
  const models = (Array.isArray(p.models) ? p.models : String(p.models || '').split(/[\s,，、]+/)).map(m => String(m).trim()).filter(Boolean);
  return { id: p.id || '', name: name.slice(0, 40), baseUrl: String(p.baseUrl).trim(), apiKey: typeof p.apiKey === 'string' ? p.apiKey.trim() : '', models: [...new Set(models)].slice(0, 60) };
}

export function validateApiUpdate(current, update) {
  for (const field of ['apiKey', 'baseUrl', 'model', 'provider', 'visionApiKey', 'visionBaseUrl', 'visionModel']) {
    if (update[field] !== undefined && typeof update[field] !== 'string') throw new Error('API 配置字段必须是字符串');
  }
  const next = { ...current, ...update };
  for (const field of ['apiKey', 'visionApiKey']) {
    if (update[field]?.startsWith('***')) next[field] = current[field];
  }
  if (['baseUrl', 'model', 'provider'].some(field => update[field] !== undefined) && next.provider !== 'copilot') {
    chatCompletionsUrl(next.baseUrl);
    modelId(next.model);
  }
  if (['visionBaseUrl', 'visionModel'].some(field => update[field] !== undefined)) {
    if (next.visionBaseUrl) chatCompletionsUrl(next.visionBaseUrl);
    if (next.visionBaseUrl || next.visionModel) modelId(next.visionModel);
  }
  return next;
}