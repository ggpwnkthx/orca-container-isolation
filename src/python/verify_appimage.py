import base64, hashlib, sys
lines = open(sys.argv[1]).read().splitlines()
want, current = None, None
for line in lines:
    s = line.strip().lstrip("- ").strip()
    if s.startswith("url:"):
        current = s.split(":", 1)[1].strip().strip("'\"")
    elif s.startswith("sha512:") and current == sys.argv[2]:
        want = s.split(":", 1)[1].strip().strip("'\"")
        break
if not want:
    sys.exit("no sha512 for this file in latest-linux.yml")
h = hashlib.sha512()
with open(sys.argv[3], "rb") as f:
    for chunk in iter(lambda: f.read(1 << 20), b""):
        h.update(chunk)
sys.exit(0 if base64.b64encode(h.digest()).decode() == want else "sha512 mismatch")
