# -*- coding: utf-8 -*-
"""DeepSim CodeMAX Notebook Kernel Host.

通过 jupyter_client 启动一个 IPython kernel；从 stdin 读取 JSON 命令；
把内核 IOPub 消息序列化为 JSON 行写到 stdout。每行一个 JSON。

stdin 命令：
  {"action":"execute","code":"...","cell_id":"X"}
  {"action":"interrupt"}
  {"action":"restart"}
  {"action":"shutdown"}

stdout 事件（每行一个）：
  {"type":"ready"}
  {"type":"stream","name":"stdout|stderr","text":"...","cell_id":"X"}
  {"type":"display","mime":"image/png|text/html|text/plain","data":"...","cell_id":"X"}
  {"type":"error","ename":"...","evalue":"...","traceback":[...],"cell_id":"X"}
  {"type":"exec_count","n":N,"cell_id":"X"}
  {"type":"status","state":"idle|busy","cell_id":"X"}
  {"type":"done","cell_id":"X"}
  {"type":"fatal","message":"..."}
"""
import sys, json, threading

def emit(obj):
    try:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    except Exception:
        pass

try:
    from jupyter_client.manager import KernelManager
except Exception as e:
    emit({"type": "fatal", "message": f"缺少 jupyter_client / ipykernel：{e}。请运行：pip install ipykernel jupyter_client"})
    sys.exit(2)

km = KernelManager()
try:
    km.start_kernel()
except Exception as e:
    emit({"type": "fatal", "message": f"启动 kernel 失败：{e}"})
    sys.exit(3)

kc = km.client()
kc.start_channels()
try:
    kc.wait_for_ready(timeout=30)
except Exception as e:
    emit({"type": "fatal", "message": f"kernel 就绪超时：{e}"})
    try: km.shutdown_kernel(now=True)
    except Exception: pass
    sys.exit(4)

emit({"type": "ready"})

# msg_id -> cell_id
current_cells = {}
lock = threading.Lock()

def iopub_loop():
    while True:
        try:
            msg = kc.get_iopub_msg(timeout=None)
        except Exception:
            continue
        try:
            m_type = msg.get('msg_type', '')
            parent_id = (msg.get('parent_header') or {}).get('msg_id', '')
            with lock:
                cell = current_cells.get(parent_id, '')
            c = msg.get('content') or {}
            if m_type == 'stream':
                emit({"type": "stream", "name": c.get('name', 'stdout'), "text": c.get('text', ''), "cell_id": cell})
            elif m_type in ('execute_result', 'display_data'):
                data = c.get('data', {}) or {}
                # 优先级：image/png > text/html > text/plain
                if 'image/png' in data:
                    emit({"type": "display", "mime": "image/png", "data": data['image/png'], "cell_id": cell})
                if 'text/html' in data and 'image/png' not in data:
                    txt = data['text/html']
                    if isinstance(txt, list): txt = ''.join(txt)
                    emit({"type": "display", "mime": "text/html", "data": txt, "cell_id": cell})
                elif 'text/plain' in data and 'image/png' not in data and 'text/html' not in data:
                    txt = data['text/plain']
                    if isinstance(txt, list): txt = ''.join(txt)
                    emit({"type": "display", "mime": "text/plain", "data": txt, "cell_id": cell})
                if m_type == 'execute_result' and c.get('execution_count') is not None:
                    emit({"type": "exec_count", "n": c.get('execution_count'), "cell_id": cell})
            elif m_type == 'error':
                emit({"type": "error", "ename": c.get('ename', ''), "evalue": c.get('evalue', ''), "traceback": c.get('traceback', []) or [], "cell_id": cell})
            elif m_type == 'status':
                state = c.get('execution_state', '')
                emit({"type": "status", "state": state, "cell_id": cell})
                if state == 'idle' and cell:
                    emit({"type": "done", "cell_id": cell})
                    with lock:
                        # 清理映射，避免无限累积
                        current_cells.pop(parent_id, None)
            elif m_type == 'execute_input':
                if c.get('execution_count') is not None:
                    emit({"type": "exec_count", "n": c.get('execution_count'), "cell_id": cell})
        except Exception as e:
            emit({"type": "stream", "name": "stderr", "text": f"[host] iopub 异常: {e}\n", "cell_id": ""})

t = threading.Thread(target=iopub_loop, daemon=True)
t.start()

# 主循环：读 stdin 命令
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
    except Exception:
        continue
    action = req.get('action')
    if action == 'execute':
        code = req.get('code', '')
        cell_id = req.get('cell_id', '')
        try:
            msg_id = kc.execute(code, store_history=True, allow_stdin=False)
            with lock:
                current_cells[msg_id] = cell_id
        except Exception as e:
            emit({"type": "error", "ename": "ExecuteFailed", "evalue": str(e), "traceback": [], "cell_id": cell_id})
            emit({"type": "done", "cell_id": cell_id})
    elif action == 'interrupt':
        try: km.interrupt_kernel()
        except Exception as e: emit({"type": "stream", "name": "stderr", "text": f"interrupt 失败：{e}\n", "cell_id": ""})
    elif action == 'restart':
        try:
            km.restart_kernel(now=True)
            kc.wait_for_ready(timeout=30)
            emit({"type": "ready"})
        except Exception as e:
            emit({"type": "fatal", "message": f"restart 失败：{e}"})
            break
    elif action == 'shutdown':
        break

try: km.shutdown_kernel(now=True)
except Exception: pass
