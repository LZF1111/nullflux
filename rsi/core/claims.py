"""跨进程的核占用登记（几个调度器 + 外部作业共用一台机器时用）。
刚启动的试验在 generate/mesh/mapFields 阶段还没有 *Foam 进程，busy_cores() 看不到它；别的调度器会以为核是空的。
登记文件 JSON：{name: {np, t, owner}}，读写都在 fcntl 文件锁里。超过 max_age 的登记自动失效（防止进程崩溃后永久占核）。
命令行（给 shell 脚本用）：python3 -m core.claims PATH add NAME NP [OWNER] | remove NAME | list"""
import contextlib, json, os, sys, time

MAX_AGE_S = 3 * 3600


@contextlib.contextmanager
def locked(path):
    if not path:
        yield; return
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    fh = open(path + '.lock', 'a+')
    try:
        try:
            import fcntl
            fcntl.flock(fh, fcntl.LOCK_EX)
        except ImportError:
            pass
        yield
    finally:
        fh.close()


def read(path, now=None):
    if not path or not os.path.exists(path): return {}
    try:
        with open(path, encoding='utf-8') as f: d = json.load(f)
    except (OSError, ValueError):
        return {}
    now = now or time.time()
    return {k: v for k, v in d.items() if now - float(v.get('t', 0)) < float(v.get('max_age', MAX_AGE_S))}


def write(path, d):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f: json.dump(d, f, indent=1)
    os.replace(tmp, path)


def add(path, name, np, owner='', max_age=MAX_AGE_S, now=None):
    with locked(path):
        d = read(path, now); d[name] = dict(np=int(np), t=now or time.time(), owner=owner, max_age=max_age); write(path, d)


def remove(path, name):
    with locked(path):
        d = read(path)
        if d.pop(name, None) is not None: write(path, d)


def others(path, owner, now=None):
    """别的属主登记的核数"""
    return sum(int(v['np']) for v in read(path, now).values() if v.get('owner') != owner)


if __name__ == '__main__':
    p, cmd = sys.argv[1], sys.argv[2]
    if cmd == 'add': add(p, sys.argv[3], int(sys.argv[4]), sys.argv[5] if len(sys.argv) > 5 else 'external',
                         max_age=float(sys.argv[6]) if len(sys.argv) > 6 else MAX_AGE_S)
    elif cmd == 'remove': remove(p, sys.argv[3])
    print(json.dumps(read(p)))
