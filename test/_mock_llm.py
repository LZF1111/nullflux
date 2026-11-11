"""Mock OpenAI endpoint for campaign smoke test: always proposes a bimodal age closure."""
import json, http.server, sys
CLOSURE = '''双峰龄：一部分新鲜剂短路，其余滞留；接触效率随 U/Umf 下降。
```python
import math
def solids_age(s):
    f = min(0.3, 0.05 * math.log(1.0 + s['H_over_D'] * s['U_over_Umf'] / 10.0))
    if f <= 0.0:
        return [(1.0, 1.0)]
    return [(f, 0.02), (1.0 - f, (1.0 - 0.02 * f) / (1.0 - f))]
def contact_efficiency(s):
    return max(0.05, min(1.0, 1.0 / (1.0 + 0.05 * s['U_over_Umf'])))
```'''
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length', 0)))
        body = json.dumps({'choices': [{'message': {'content': CLOSURE}}]}).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
http.server.HTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
