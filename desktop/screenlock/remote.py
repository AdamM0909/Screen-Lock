"""Lock the PC from a phone on the same Wi-Fi.

A tiny web server (standard library only). The phone opens http://<pc-address>:<port>, types the password or a
phone code, and taps how long to lock. It can only LOCK. Unlocking always happens at the PC.
"""
import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import core

MAX_BODY = 2048

PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Screen Lock</title>
<style>
body{margin:0;background:#14110a;color:#f2eee3;font:17px system-ui,sans-serif;padding:20px;max-width:480px;margin:auto}
h1{color:#f5c542;font-size:24px}#st{margin:6px 0 18px;color:#bbb}
input{width:100%;box-sizing:border-box;padding:14px;font-size:18px;border-radius:10px;border:0;background:#26211a;color:#fff;margin:6px 0}
.g{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px}
button{padding:16px;font-size:17px;border:0;border-radius:10px;background:#f5c542;color:#14110a;font-weight:600}
button.w{grid-column:span 2}#m{margin-top:16px;min-height:24px}.e{color:#ff7a7a}.o{color:#7dff9a}
</style></head><body><h1>Screen Lock</h1><div id="st">...</div>
<input id="s" type="password" placeholder="Password or phone code" autocomplete="off">
<input id="t" type="text" placeholder="Message on the lock screen (optional)" maxlength="200">
<div class="g">
<button data-m="15">15 min</button><button data-m="30">30 min</button>
<button data-m="60">1 hour</button><button data-m="120">2 hours</button>
<button class="w" data-m="0">Until I unlock it</button></div><div id="m"></div>
<script>
const $=id=>document.getElementById(id);
async function status(){try{const r=await fetch('/status');const j=await r.json();
$('st').textContent=j.locked?'The PC is locked.':'The PC is unlocked.'}catch(e){$('st').textContent='Cannot reach the PC.'}}
document.querySelectorAll('button').forEach(b=>b.onclick=async()=>{
 const m=+b.dataset.m;$('m').className='';$('m').textContent='...';
 try{const r=await fetch('/lock',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({secret:$('s').value,minutes:m||null,message:$('t').value})});
  const j=await r.json();$('s').value='';
  if(j.ok){$('m').className='o';$('m').textContent='Locked.'}
  else{$('m').className='e';$('m').textContent=j.error}
 }catch(e){$('m').className='e';$('m').textContent='Cannot reach the PC.'}status()});
status();setInterval(status,5000);
</script></body></html>"""


def lan_address():
    """Best guess at this PC's address on the local network."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # no packet is sent
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def make_handler(store):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, code, body, ctype="application/json"):
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype + "; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/":
                self.reply(200, PAGE.encode(), "text/html")
            elif self.path == "/status":
                self.reply(200, {"locked": core.desired_lock(store) is not None})
            else:
                self.reply(404, {"error": "Not found"})

        def do_POST(self):
            if self.path != "/lock":
                return self.reply(404, {"error": "Not found"})
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if size > MAX_BODY:
                    return self.reply(413, {"error": "Too big"})
                req = json.loads(self.rfile.read(size) or b"{}")
                secret = str(req.get("secret", ""))
                minutes = req.get("minutes")
                if minutes is not None:
                    minutes = int(minutes)
                    if not 1 <= minutes <= 1440:
                        raise ValueError
                message = str(req.get("message") or "")[:200]
            except (ValueError, TypeError):
                return self.reply(400, {"error": "Bad request"})
            ip = self.client_address[0]
            result, left = core.check_secret(store, secret)
            if result == "cooldown":
                with store.lock:
                    store.log("remote_blocked", ip)
                    store.save()
                return self.reply(429, {"error": f"Too many tries. Wait {left} seconds."})
            if result == "wrong":
                with store.lock:
                    store.log("remote_wrong", ip)
                    store.save()
                return self.reply(403, {"error": "That is not right."})
            with store.lock:
                if core.desired_lock(store) is not None:
                    return self.reply(200, {"ok": True})  # already locked
                core.start_manual_lock(store, minutes, message)
                store.log("remote_lock", ip)
                store.save()
            self.reply(200, {"ok": True})

    return Handler


class RemoteServer:
    def __init__(self, store, port=8765, host="0.0.0.0"):
        self.httpd = ThreadingHTTPServer((host, port), make_handler(store))
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def start(self):
        self.thread.start()

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def url(self):
        return f"http://{lan_address()}:{self.port}"
