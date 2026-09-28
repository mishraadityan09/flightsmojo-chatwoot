# Stand-in for Chatwoot's relay endpoint: checks basic auth + content type,
# returns 204 like Action Mailbox does, logs what it received.
import base64, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
PW = os.environ["PW"]
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0")); body = self.rfile.read(n)
        auth = self.headers.get("Authorization", "")
        ok_auth = auth == "Basic " + base64.b64encode(f"actionmailbox:{PW}".encode()).decode()
        ok_type = self.headers.get("Content-Type", "").startswith("message/rfc822")
        code = 204 if (ok_auth and ok_type) else (401 if not ok_auth else 415)
        xo = [l for l in body.decode(errors="replace").splitlines() if l.lower().startswith(("x-original-to","to:","subject:"))]
        print(f"[fake-chatwoot] {self.path} -> {code} bytes={n} {xo}", flush=True)
        self.send_response(code); self.end_headers()
    def log_message(self, *a): pass
HTTPServer(("127.0.0.1", 3001), H).serve_forever()
