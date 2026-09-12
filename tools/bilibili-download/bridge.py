from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

OUT = Path(__file__).with_name('dash_urls.json')

class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get('Content-Length', '0'))
        OUT.write_bytes(self.rfile.read(n))
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.server.shutdown()
    def log_message(self, *_):
        pass

HTTPServer(('127.0.0.1', 8765), H).serve_forever()
