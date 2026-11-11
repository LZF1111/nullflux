"""提议者：LLM（OpenAI 兼容接口）或研究自带的内置采样器。只负责产生候选文件并离线 check，不跑 CFD。"""
import json, os, re, time, urllib.request

CODE_RE = re.compile(r'```(?:python|py|json)?[ \t]*\r?\n(.*?)```', re.S)


def call_llm(messages):
    url, key, model = os.environ['HL_API_URL'], os.environ.get('HL_API_KEY', ''), os.environ.get('HL_MODEL', 'claude-opus-5-5')
    body = json.dumps({'model': model, 'messages': messages, 'temperature': 0.8, 'max_tokens': 4000}).encode()
    req = urllib.request.Request(url, body, {'Content-Type': 'application/json', 'Authorization': f'Bearer {key}'})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                return json.loads(r.read())['choices'][0]['message']['content']
        except Exception:
            if attempt == 4: raise
            time.sleep(30 * (attempt + 1))


def extract_code(reply):
    m = CODE_RE.search(reply or '')
    return m.group(1) if m else None


def _checked(study, arch, path, log):
    try:
        r = study.check(path)
    except Exception as e:
        return None, f'{type(e).__name__}: {e}'
    if not r['ok']:
        err = '; '.join(r['violations'][:3]); log('violates', os.path.basename(path), err); return None, err
    r['surrogate'] = study.surrogate(r, arch)
    log('ok', os.path.basename(path), r.get('cell'), f"sur={r['surrogate']:.4f}")
    return r, ''


def propose(study, arch, n, last_err, cand_dir, llm=None, log=print, stamp=None):
    """返回 (候选, last_err, llm_down)。内置采样器优先；模型通路故障不算候选错误，也不让循环崩掉。"""
    os.makedirs(cand_dir, exist_ok=True)
    out = []
    builtin = study.propose_builtin(arch, n, cand_dir)
    if builtin is not None:
        for p in builtin:
            r, err = _checked(study, arch, p, log)
            if r: out.append(r)
            else: last_err = err
        return out, last_err, False
    llm = llm or call_llm; stamp = stamp or (lambda: int(time.time()))
    for k in range(n):
        note = f'\n\n## 上一个候选的问题\n{last_err}' if last_err else ''
        try:
            reply = llm([{'role': 'system', 'content': study.task},
                         {'role': 'user', 'content': study.context_text(arch) + note + f'\n\n（本轮第 {k + 1}/{n} 个，请与前面的候选在行为格上不同）'}])
        except Exception as e:
            log('llm unavailable:', f'{type(e).__name__}: {e}'[:300]); return out, last_err, True
        code = extract_code(reply)
        if code is None: last_err = '未找到代码块'; continue
        path = os.path.join(cand_dir, f'c{stamp()}_{k}{study.code_suffix}')
        with open(path, 'w', encoding='utf-8') as f: f.write(code)
        r, err = _checked(study, arch, path, log)
        if r: out.append(r); last_err = ''
        else: last_err = err
    return out, last_err, False


def pick_diverse(cands, tried, k):
    """去掉已试过的，按代理分排序，同一行为格只取一个；格子不够时再用剩下的补足。"""
    cands = sorted([c for c in cands if c['hash'] not in tried], key=lambda c: c['surrogate'])
    seen, first, rest = set(), [], []
    for c in cands:
        (rest if c['cell'] in seen else first).append(c); seen.add(c['cell'])
    return (first + rest)[:k]
