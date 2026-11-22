# Link the host's skills into the folders the agents read. $1 is the host's
# home folder, where the skill folders are mounted.
host="$1"
for d in @SKILL_DIRS@; do
  src="$host/$d"
  dst="$HOME/$d"
  [ -d "$src" ] || continue
  mkdir -p "$dst" 2>/dev/null || continue
  for s in "$src"/*; do
    [ -d "$s" ] || continue
    name="${s##*/}"
    case "$name" in .*) continue ;; esac
    t="$dst/$name"
    if [ -L "$t" ]; then
      cur="$(readlink "$t")"
      case "$cur" in "$host"/*) ;; *) continue ;; esac
      [ "$cur" = "$s" ] && continue
    elif [ -e "$t" ]; then
      continue
    fi
    ln -sfn "$s" "$t" 2>/dev/null || true
  done
  # Skills gone from the host: drop the links that point at them.
  for t in "$dst"/*; do
    [ -L "$t" ] || continue
    cur="$(readlink "$t")"
    case "$cur" in "$host"/*) ;; *) continue ;; esac
    [ -e "$cur" ] || rm -f "$t" 2>/dev/null || true
  done
done
