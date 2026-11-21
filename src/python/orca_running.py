import json, os, sys
try:
    pid = int(json.load(open(os.path.join(sys.argv[1], "orca-runtime.json")))["pid"])
    os.kill(pid, 0)
except Exception:
    sys.exit(0)
app = ""
try:
    for entry in open(f"/proc/{pid}/environ", "rb").read().split(b"\0"):
        if entry.startswith(b"APPIMAGE="):
            app = entry[9:].decode(errors="replace")
except OSError:
    pass
print(pid, app)
