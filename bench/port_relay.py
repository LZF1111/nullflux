#!/usr/bin/env python3
"""本方专用的可断开转发：127.0.0.1:LISTEN → 127.0.0.1:18081。
控制文件 CTRL 存在且内容为 down 时，新连接立即关闭、已有连接全部掐断（模拟模型通路断网）。
用法: port_relay.py LISTEN CTRL"""
import os, socket, sys, threading, time

LISTEN, CTRL = int(sys.argv[1]), sys.argv[2]
UP = ('127.0.0.1', 18081)
live = set(); lock = threading.Lock()


def down():
    try: return open(CTRL).read().strip() == 'down'
    except OSError: return False


def pipe(a, b):
    try:
        while True:
            d = a.recv(65536)
            if not d: break
            b.sendall(d)
    except OSError: pass
    finally:
        for s in (a, b):
            try: s.close()
            except OSError: pass


def reaper():
    while True:
        if down():
            with lock:
                for s in list(live):
                    try: s.shutdown(socket.SHUT_RDWR); s.close()
                    except OSError: pass
                live.clear()
        time.sleep(0.5)


srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(('127.0.0.1', LISTEN)); srv.listen(64)
threading.Thread(target=reaper, daemon=True).start()
while True:
    c, _ = srv.accept()
    if down(): c.close(); continue
    try: u = socket.create_connection(UP, timeout=10)
    except OSError: c.close(); continue
    # 10 s 只用于建连；之后必须阻塞读，否则首字节 >10 s 的大请求会被当成超时掐断（T2 第 1 轮作废的原因）
    u.settimeout(None)
    with lock: live.update((c, u))
    threading.Thread(target=pipe, args=(c, u), daemon=True).start()
    threading.Thread(target=pipe, args=(u, c), daemon=True).start()
