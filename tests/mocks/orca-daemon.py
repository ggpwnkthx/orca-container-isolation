#!/usr/bin/env python3
"""Mock Orca daemon.

Serves the two calls orca-box-configure-orca makes over Orca's private
local socket: settings.getAgentLaunch and settings.mutateAgentLaunch.

Usage: orca-daemon.py <user-data-dir> <socket-path>

It writes <user-data-dir>/orca-runtime.json, the file the real Orca app
writes, so the client finds it the same way it would find the real thing.
"""
import json
import os
import socket
import sys
import threading

AGENTS = ["claude", "codex", "pi"]

# The commands the agents had before orca-box took over. "codex" starts with
# something of its own, so a test can tell a real change from a no-op.
state = {"claude": "", "codex": "codex --yolo", "pi": ""}

user_data, socket_path = sys.argv[1], sys.argv[2]
os.makedirs(user_data, exist_ok=True)

meta = {
    "pid": os.getpid(),
    "authToken": "test-token",
    "transport": "unix",
    "transports": [{"kind": "unix", "endpoint": socket_path}],
}
with open(os.path.join(user_data, "orca-runtime.json"), "w") as f:
    json.dump(meta, f)


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
                params = msg.get("params", {})
                state[params.get("agent", "")] = params.get("value", "")
                out = {"id": msg["id"], "ok": True, "result": {}}
            else:
                out = {"id": msg["id"], "ok": False,
                       "error": {"message": "no such method"}}
            conn.sendall((json.dumps(out) + "\n").encode())
    conn.close()


server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(socket_path)
server.listen(5)
print("ready", flush=True)

while True:
    conn, _ = server.accept()
    threading.Thread(target=handle, args=(conn,), daemon=True).start()
