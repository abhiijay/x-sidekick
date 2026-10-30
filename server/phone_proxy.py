#!/usr/bin/env python3
"""Show the phone's sidekick on this computer.

A tiny pass-through: the app (opened from this computer's own server, which
already has the password saved) points its server URL at this proxy, and every
/api/* call is forwarded to the phone's server (SIDEKICK_PEER_URL in .env).
The browser cannot call the phone's ngrok URL directly (CORS and ngrok's
browser warning), so this adds the ngrok header and answers CORS itself.

It holds no password: the app's own X-Sidekick-Key header is passed through
untouched, so the phone still checks it. Listens on 127.0.0.1 only.

    python3 phone_proxy.py            # port 7795
    then in the app's Settings, Server URL = http://127.0.0.1:7795
"""
import os
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))


def read_env(path):
    out = {}
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    out[k.strip()] = v.strip().strip('"').strip("'")
    return out


ENV = read_env(os.path.join(HERE, ".env"))
PEER_URL = (os.environ.get("SIDEKICK_PEER_URL") or ENV.get("SIDEKICK_PEER_URL", "")).rstrip("/")
PORT = int(os.environ.get("SIDEKICK_PROXY_PORT") or ENV.get("SIDEKICK_PROXY_PORT") or 7795)
PASS_UP = ("X-Sidekick-Key", "Content-Type", "If-None-Match", "Accept-Encoding")
PASS_DOWN = ("Content-Type", "ETag", "Content-Encoding", "Cache-Control")


class Proxy(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[proxy] " + (fmt % args) + "\n")

    def cors(self):
        origin = self.headers.get("Origin", "")
        if origin.startswith(("http://127.0.0.1:", "http://localhost:")):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers",
                             "Content-Type, X-Sidekick-Key, ngrok-skip-browser-warning, If-None-Match")
            self.send_header("Access-Control-Expose-Headers", "ETag")
            self.send_header("Access-Control-Max-Age", "7200")

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def forward(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else None
        headers = {h: self.headers[h] for h in PASS_UP if self.headers.get(h)}
        headers["ngrok-skip-browser-warning"] = "1"
        req = urllib.request.Request(PEER_URL + self.path, data=body, method=self.command, headers=headers)
        try:
            res = urllib.request.urlopen(req, timeout=60)
        except urllib.error.HTTPError as e:
            res = e  # 304, 401 and the rest go back to the app as they are
        except Exception as e:
            msg = ('{"error": "phone unreachable: %s"}' % str(e)[:150].replace('"', "'")).encode()
            self.send_response(502)
            self.cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)
            return
        data = res.read() or b""
        self.send_response(res.status if hasattr(res, "status") else res.code)
        self.cors()
        for h in PASS_DOWN:
            if res.headers.get(h):
                self.send_header(h, res.headers[h])
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = forward
    do_POST = forward


if __name__ == "__main__":
    if not PEER_URL:
        sys.exit("SIDEKICK_PEER_URL is not set in server/.env")
    print(f"[proxy] http://127.0.0.1:{PORT} -> the phone's sidekick", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Proxy).serve_forever()
