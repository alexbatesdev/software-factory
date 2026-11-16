#!/usr/bin/env bash
# One benchmark run inside a stream sandbox (bin/bench.mjs run passes it to sbx exec). Args: repo head base dir agent cap-seconds prompt-base64
set -u
repo="$1"; head="$2"; base="$3"; dir="$4"; agent="$5"; cap="$6"
out=/tmp/bench/out; mkdir -p "$out"; printf %s "$7" | base64 -d > "$out/$dir.prompt"
url="https://github.com/$repo.git"; src="${WORKSPACE_DIR:-/Users/alex.bates/Code/repos/built-rails-a}"
case "$(git -C "$src" remote get-url origin)" in *"$repo"|*"$repo.git") ;; *) src="/tmp/bench/repos/${repo#*/}"; [ -d "$src" ] || git clone -q --no-checkout "$url" "$src";; esac
for s in "$head" "$base"; do git -C "$src" cat-file -e "$s^{commit}" 2>/dev/null || git -C "$src" fetch -q "$url" "$s"; done
wt="/tmp/bench/$dir"; git -C "$src" worktree add -q --detach "$wt" "$head" || { echo "@@RC 98"; exit 0; }
[ -f "$src/config/database.yml" ] && cp "$src/config/database.yml" "$wt/config/database.yml"  # specs need it, as in the worker's checkout; git-ignored
cd "$wt"
if [ "$agent" = codex ]; then
  { cat /home/agent/standards/internal-review-codex.md; echo; cat "$out/$dir.prompt"; } | timeout "$cap" codex exec --ephemeral --dangerously-bypass-approvals-and-sandbox --json -o "$out/$dir.md" - > "$out/$dir.raw" 2>/dev/null; rc=$?
else
  timeout "$cap" claude -p --dangerously-skip-permissions --output-format json "$(cat "$out/$dir.prompt")" < /dev/null > "$out/$dir.raw" 2>/dev/null; rc=$?
fi
dirty=$(git -C "$wt" status --porcelain | wc -l | tr -d ' ')
cd /; [ "$dirty" = 0 ] && git -C "$src" worktree remove "$wt"
echo "@@RC $rc"; echo "@@DIRTY $dirty"
echo "@@MD"; [ -f "$out/$dir.md" ] && base64 -w0 "$out/$dir.md"; echo
echo "@@RAW"; tail -c 400000 "$out/$dir.raw" | base64 -w0; echo
