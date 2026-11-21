import re, shlex, sys
embedded, out, dest, icon, version = sys.argv[1:6]
lines = []
if embedded:
    try:
        lines = open(embedded, encoding="utf-8").read().splitlines()
    except OSError:
        lines = []
if not any(l.strip() == "[Desktop Entry]" for l in lines):
    lines = ["[Desktop Entry]", "Type=Application", "Name=Orca",
             "Comment=Run a fleet of coding agents in parallel",
             "Exec=AppRun %U", "Terminal=false", "Categories=Development;Utility;",
             "StartupWMClass=orca"]
quoted = '"' + re.sub(r'(["`$\\])', r'\\\1', dest) + '"'
result, section = [], None
for l in lines:
    if l.startswith("["):
        section = l.strip()
    elif "=" in l:
        key, val = l.split("=", 1)
        k = key.strip()
        if k == "Exec":
            # Replace the program (AppRun) with the installed AppImage; keep its arguments.
            parts = val.strip().split(None, 1)
            l = "Exec=" + quoted + (" " + parts[1] if len(parts) > 1 else " %U")
        elif k == "TryExec" or k.startswith("X-AppImage") or k == "X-Orca-Box":
            continue
        elif k == "Icon":
            l = "Icon=" + icon
    result.append(l)
    if l.strip() == "[Desktop Entry]":
        result.append("TryExec=" + dest)
        result.append("X-Orca-Box=true")
        if version:
            result.append("X-AppImage-Version=" + version.lstrip("v"))
if not any(re.match(r"^Icon=", l) for l in result):
    i = result.index("[Desktop Entry]") + 1
    result.insert(i, "Icon=" + icon)
open(out, "w", encoding="utf-8").write("\n".join(result) + "\n")
