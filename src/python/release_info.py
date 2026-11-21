import json, sys
rel = json.load(open(sys.argv[1]))
assets = {a.get("name"): a for a in rel.get("assets") or []}
app, yml = assets.get(sys.argv[2]) or {}, assets.get(sys.argv[3]) or {}
digest = app.get("digest") or ""
print(rel.get("tag_name") or "")
print(app.get("browser_download_url") or "")
print(digest.split(":", 1)[1] if digest.startswith("sha256:") else "")
print(yml.get("browser_download_url") or "")
