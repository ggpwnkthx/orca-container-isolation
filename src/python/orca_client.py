import json, os, socket, stat, sys, uuid

action, yolo, box, saved_path, prefix = (
    sys.argv[1], sys.argv[2] == "1", sys.argv[3], sys.argv[4], sys.argv[5])
AGENTS = ["claude", "codex", "pi"]

def fail(code, msg):
    print(f"orca-box-configure-orca: {msg}", file=sys.stderr)
    sys.exit(code)

# Orca's user-data folder, as its own CLI resolves it on Linux.
user_data = os.environ.get("ORCA_USER_DATA_PATH") or os.path.join(
    os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "orca")
meta_path = os.path.join(user_data, "orca-runtime.json")
try:
    with open(meta_path) as f:
        meta = json.load(f)
except (OSError, ValueError):
    fail(3, f"Orca isn't running (no {meta_path}). Start Orca and run this again.")

try:
    os.kill(int(meta.get("pid", 0)), 0)
except ProcessLookupError:
    fail(3, "Orca isn't running (stale runtime file). Start Orca and run this again.")
except (PermissionError, ValueError, TypeError):
    pass

transports = meta.get("transports")
if not isinstance(transports, list):
    transports = [meta.get("transport")] if meta.get("transport") else []
endpoint = next((t.get("endpoint") for t in transports
                 if isinstance(t, dict) and t.get("kind") == "unix"), None)
token = meta.get("authToken")
if not endpoint or not token:
    fail(3, f"Orca's runtime file {meta_path} has no local socket or token.")

# Like Orca's CLI: never send the token to a socket in a /tmp folder that
# isn't private to this user.
uid = os.getuid()
short_prefix = f"/tmp/.orca-daemon-{uid}/"
if endpoint.startswith(short_prefix):
    for d in (os.path.dirname(endpoint), os.path.dirname(os.path.dirname(endpoint))):
        st = os.lstat(d)
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != uid or st.st_mode & 0o077:
            fail(3, f"Orca's socket folder {d} isn't private to you; not connecting.")

def call(method, params=None):
    rid = str(uuid.uuid4())
    msg = {"id": rid, "authToken": token, "method": method}
    if params is not None:
        msg["params"] = params
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(15)
        s.connect(endpoint)
        s.sendall((json.dumps(msg) + "\n").encode())
        buf = b""
        while True:
            chunk = s.recv(65536)
            if not chunk:
                fail(3, "Orca closed the connection before answering. Try again.")
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if not line.strip():
                    continue
                frame = json.loads(line)
                if "_keepalive" in frame or frame.get("id") != rid:
                    continue
                s.close()
                return frame
    except (OSError, socket.timeout) as e:
        fail(3, f"couldn't reach Orca ({e}). Is it running?")

def current_overrides():
    frame = call("settings.getAgentLaunch")
    if not frame.get("ok"):
        return None
    settings = (frame.get("result") or {}).get("settings") or {}
    overrides = settings.get("agentCmdOverrides")
    return overrides if isinstance(overrides, dict) else {}

def mutate(params):
    frame = call("settings.mutateAgentLaunch", params)
    if not frame.get("ok"):
        err = frame.get("error") or {}
        fail(1, f"Orca rejected {params}: {err.get('message') or err}")

def is_ours(value):
    """Our command in any form we've written: orca-box, ~/.local/bin/orca-box,
    or a full path (including Bazzite's /var/home form)."""
    first = value.split(" ", 1)[0] if value else ""
    if not first:
        return False
    if first == "orca-box":
        return True
    return os.path.realpath(os.path.expanduser(first)) == os.path.realpath(box)

# Commands the agents had before orca-box took over, restored by --unset.
try:
    with open(saved_path) as f:
        saved = json.load(f)
    if not isinstance(saved, dict):
        saved = {}
except (OSError, ValueError):
    saved = {}

before = current_overrides()
failed = False
if action == "set" and before is not None:
    for agent in AGENTS:
        old = before.get(agent, "")
        if not is_ours(old):
            saved[agent] = old
    os.makedirs(os.path.dirname(saved_path), exist_ok=True)
    with open(saved_path, "w") as f:
        json.dump(saved, f, indent=2)

for agent in AGENTS:
    old = (before or {}).get(agent, "")
    if action == "set":
        new = f"{prefix} {agent}"
        mutate({"type": "command", "agent": agent, "value": new})
        print(f"  {agent:7} command: {old or '(default)'} -> {new}")
        if yolo:
            mutate({"type": "permissions", "mode": "yolo", "agent": agent})
            print(f"  {agent:7} permissions: Yolo")
    else:
        if before is None:
            print(f"  {agent:7} skipped (couldn't read current setting)")
            failed = True
        elif is_ours(old):
            prev = saved.get(agent, "") if isinstance(saved.get(agent, ""), str) else ""
            mutate({"type": "command", "agent": agent, "value": prev})
            print(f"  {agent:7} command: {old} -> {prev or '(default)'}")
        else:
            print(f"  {agent:7} left as {old or '(default)'}")
if action == "unset" and not failed:
    try:
        os.remove(saved_path)
    except OSError:
        pass
sys.exit(1 if failed else 0)
