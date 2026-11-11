#!/usr/bin/env python3
"""deploy.py — 部署到服务器并执行第一阶段。

用法（在本地 nullflux-v6/ 目录下）：
  python3 rsi/bubble_column/deploy.py check    检查SSH连通性
  python3 rsi/bubble_column/deploy.py sync     rsync 到服务器
  python3 rsi/bubble_column/deploy.py init     服务器上 rsi.py init（建模板目录）
  python3 rsi/bubble_column/deploy.py mesh_test 在服务器上跑 blockMesh 验证网格
  python3 rsi/bubble_column/deploy.py phase1   提交所有静态seed（后台，不等待）
  python3 rsi/bubble_column/deploy.py watch    轮询服务器状态（每60s刷新）
"""
import argparse, os, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))

# ---- 配置（与现有项目保持一致）----
SSH_HOST   = 'my-server'           # 与 rsi/distributor 一致
REMOTE_DIR = '/home/user/bubble_col/framework'
FOAM_SH    = '/home/user/OpenFOAM/OpenFOAM-v2306/etc/bashrc'


def ssh(cmd, capture=False, check=True):
    full = ['ssh', SSH_HOST, cmd]
    if capture:
        r = subprocess.run(full, capture_output=True, text=True)
        if check and r.returncode != 0:
            print('STDERR:', r.stderr[:600])
        return r
    return subprocess.run(full, check=check)


def cmd_check(_):
    print('Checking SSH connectivity...')
    r = ssh('echo OK && nproc && uname -r', capture=True, check=False)
    if r.returncode == 0:
        print('Connected:', r.stdout.strip())
    else:
        print('FAILED:', r.stderr.strip())
        sys.exit(1)


def cmd_sync(_):
    print(f'Syncing rsi/bubble_column/ → {SSH_HOST}:{REMOTE_DIR}')
    src = HERE + '/'
    result = subprocess.run([
        'rsync', '-avz', '--delete',
        '--exclude=__pycache__', '--exclude=*.pyc', '--exclude=logs/',
        src, f'{SSH_HOST}:{REMOTE_DIR}/'
    ])
    if result.returncode != 0:
        sys.exit('rsync failed')
    print('Sync complete.')


def cmd_init(_):
    print('Initialising template directory on server...')
    remote_py = f'cd {REMOTE_DIR} && python3 rsi.py init'
    ssh(remote_py)


def cmd_mesh_test(_):
    print('Running blockMesh on server to validate mesh...')
    # Create a throwaway test directory
    test_dir = '/tmp/bc_mesh_test'
    cmds = [
        f'cp -r {REMOTE_DIR}/case_template {test_dir}',
        f'source {FOAM_SH} 2>/dev/null; cd {test_dir} && blockMesh -noFunctionObjects 2>&1 | tail -8',
        f'source {FOAM_SH} 2>/dev/null; cd {test_dir} && checkMesh -noFunctionObjects 2>&1 | grep -E "Mesh OK|FAILED|cells|faces"',
        f'rm -rf {test_dir}',
    ]
    for c in cmds:
        r = ssh(c, capture=True, check=False)
        print(r.stdout.strip())
        if 'FAILED' in r.stdout:
            print('blockMesh/checkMesh FAILED — fix blockMeshDict before continuing')
            sys.exit(1)
    print('Mesh test PASSED.')


def cmd_phase1(_):
    print('Submitting Phase 1 (background) on server...')
    remote_cmd = (
        f'cd {REMOTE_DIR} && '
        f'nohup bash submit_all.sh '
        f'> logs/phase1_master.log 2>&1 &'
        f' echo "PID $!"'
    )
    r = ssh(remote_cmd, capture=True)
    print('Server output:', r.stdout.strip())
    print('Monitor with:  python3 rsi/bubble_column/deploy.py watch')


def cmd_watch(_):
    print('Polling server status (Ctrl-C to stop)...')
    while True:
        r = ssh(f'cd {REMOTE_DIR} && python3 rsi.py status', capture=True, check=False)
        print(f'\n--- {time.strftime("%H:%M:%S")} ---')
        print(r.stdout.strip() or r.stderr.strip())
        try:
            time.sleep(60)
        except KeyboardInterrupt:
            break


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest='cmd', required=True)
    for name in ('check', 'sync', 'init', 'mesh_test', 'phase1', 'watch'):
        sp.add_parser(name)
    a = ap.parse_args()
    globals()['cmd_' + a.cmd](a)


if __name__ == '__main__':
    main()
