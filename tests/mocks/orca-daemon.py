#!/usr/bin/env python3
"""Mock Orca daemon: serves settings.getAgentLaunch / settings.mutateAgentLaunch
over a unix socket, like the real orca CLI talks to it."""
import json, os, socket, sys, threading, stat

user_data = sys.argv[1]
os.makedirs(user_data, exist_ok=True)
meta = {
    "pid": os.getpid(),
    "authToken": "test-token",
    "transport": "unix",
    "transports": [{"kind": "unix", "endpoint": sys.argv[2]}],
}
with open(os.path.join(user_data, "orca-runtime.json"), "w") as f:
    json.dump(meta, f)

state = {"claude": "", "codex": "codex --yolo", "pi": ""}


def handle(conn):
    buf = b""
    while True:
        chunk = conn.recv(65536)
        if not chunk:
            break
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            if not line.strip():
                continue
            msg = json.loads(line)
            method = msg.get("method")
            if method == "settings.getAgentLaunch":
                result = {"settings": {"agentCmdOverrides": dict(state)}}
                out = {"id": msg["id"], "ok": True, "result": result}
            elif method == "settings.mutateAgentLaunch":
                p = msg.get("params", {})
                state[p["agent"]] = p.get("value", "")
                out = {"id": msg["id"], "ok": True, "result": {}}
            else:
                out = {"id": msg["id"], "ok": False, "error": {"message": "no such method"}}
            conn.sendall((json.dumps(out) + "\n").encode())
    conn.close()


s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.bind(sys.argv[2])
s.listen(5)
print("ready", flush=True)
while True:
    c, _ = s.accept()
    threading.Thread(target=handle, args=(c,), daemon=True).start()
