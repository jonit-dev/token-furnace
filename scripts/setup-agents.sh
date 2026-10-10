#!/usr/bin/env bash
# token-furnace: set up shared skills and token-efficient defaults for
# Claude Code and Codex. Idempotent. Backs up every file it touches before
# touching it, and can restore that backup with --rollback.
set -euo pipefail

SKILLS_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HUB="$HOME/.agents/skills"
CLAUDE_DIR="$HOME/.claude"
CODEX_DIR="$HOME/.codex"
BACKUP_ROOT="$HOME/.agents/token-furnace-backups"
SKILLS=(token-furnace prd-creator prd-manager)

# Files backed up before any change, as "label:path" pairs.
TRACKED=(
  "claude-settings.json:$CLAUDE_DIR/settings.json"
  "claude-mcp.json:$HOME/.claude.json"
  "claude-CLAUDE.md:$CLAUDE_DIR/CLAUDE.md"
  "codex-config.toml:$CODEX_DIR/config.toml"
  "codex-AGENTS.md:$CODEX_DIR/AGENTS.md"
)

BEGIN='<!-- token-furnace:begin -->'
END='<!-- token-furnace:end -->'
read -r -d '' LINE <<'EOF' || true
Token discipline, every session: slice uncertain or cross-file work into a compact PRD with the `prd-creator` skill first and execute from that, rather than exploring and implementing in one context (`prd-manager` reports where PRDs stand); retrieve the smallest range that answers the question and **never re-establish a fact you already have** — no confirming grep after a read that answered it; run the smallest test that can falsify the current hypothesis; after two failures with the same cause, stop editing and re-plan. Full policy: `~/.agents/skills/token-furnace/SKILL.md`.
EOF

APPLY=0; AGGRESSIVE=0; ROLLBACK=0; VERIFY_ONLY=0
for a in "$@"; do case "$a" in
  --apply) APPLY=1 ;;
  --aggressive) AGGRESSIVE=1 ;;
  --rollback) ROLLBACK=1 ;;
  --verify) VERIFY_ONLY=1 ;;
  -h|--help) sed -n '2,6p' "${BASH_SOURCE[0]}"; echo; echo "  --apply       write changes (default: dry run)"; echo "  --aggressive  also set the flagged-risky subagent spawn depth"; echo "  --verify      check an existing install; exits 1 on any failure"; echo "  --rollback    restore the most recent backup"; exit 0 ;;
  *) echo "unknown flag: $a" >&2; exit 2 ;;
esac; done

say()  { printf '  %s\n' "$*"; }
ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }
plan() { printf '  \033[33mwould\033[0m %s\n' "$*"; }
did()  { printf '  \033[36mdid\033[0m   %s\n' "$*"; }
warn() { printf '  \033[31mskip\033[0m  %s\n' "$*"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$*"; }

codex_has() { # codex_has <table|""> <key>
  TS_FILE="$CODEX_DIR/config.toml" TS_TABLE="$1" TS_KEY="$2" python3 - <<'PY'
import os, sys, tomllib
f, table, key = (os.environ[k] for k in ("TS_FILE","TS_TABLE","TS_KEY"))
try: d = tomllib.load(open(f, "rb"))
except Exception: sys.exit(1)
for part in filter(None, table.split(".")):
    d = d.get(part) or {}
print(d.get(key, ""))
sys.exit(0 if key in d else 1)
PY
}

# --- verify ----------------------------------------------------------------
# Checks the end state on disk rather than trusting that each step reported
# success. Exits non-zero on any failure so it can gate a script.
FAILS=0
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; FAILS=$((FAILS+1)); }

verify() {
  head_ "Verify"

  # Config files must parse — a config that does not load silently reverts every
  # setting to its default.
  if [ -f "$CLAUDE_DIR/settings.json" ]; then
    if jq -e . "$CLAUDE_DIR/settings.json" >/dev/null 2>&1; then ok "settings.json parses"
    else bad "settings.json is not valid JSON"; fi
    for k in CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS ENABLE_TOOL_SEARCH MAX_MCP_OUTPUT_TOKENS; do
      v="$(jq -r --arg k "$k" '.env[$k] // empty' "$CLAUDE_DIR/settings.json" 2>/dev/null || true)"
      [ -n "$v" ] && ok "claude $k=$v" || bad "claude $k missing"
    done
  else bad "$CLAUDE_DIR/settings.json missing"; fi

  if [ -f "$CODEX_DIR/config.toml" ]; then
    if python3 -c 'import tomllib,sys;tomllib.load(open(sys.argv[1],"rb"))' "$CODEX_DIR/config.toml" 2>/dev/null
    then ok "config.toml parses"
    else bad "config.toml is not valid TOML — restore with --rollback"; fi
    for pair in ":model_verbosity" ":tool_output_token_limit" \
                "agents:max_concurrent_threads_per_session" "agents:default_subagent_reasoning_effort"; do
      t="${pair%%:*}"; k="${pair#*:}"
      if v="$(codex_has "$t" "$k")"; then ok "codex ${t:+$t.}$k=$v"; else bad "codex ${t:+$t.}$k missing"; fi
    done
  else bad "$CODEX_DIR/config.toml missing"; fi

  # Every skill link must resolve to a readable SKILL.md — a dangling symlink
  # looks installed in `ls` and is invisible to the agent.
  for s in "${SKILLS[@]}"; do
    for d in "$CLAUDE_DIR/skills/$s" "$CODEX_DIR/skills/$s"; do
      if [ -r "$d/SKILL.md" ]; then ok "${d/#$HOME/\~}/SKILL.md readable"
      elif [ -L "$d" ]; then bad "${d/#$HOME/\~} is a dangling link"
      else bad "${d/#$HOME/\~} missing"; fi
    done
  done

  # The circuit-breaker hook: wired, and the script still executable.
  hookcmd="$HUB/token-furnace/scripts/escalate-on-churn.py"
  if jq -e --arg c "$hookcmd" '[.hooks.PostToolUse[]?.hooks[]?.command] | any(. == $c)' \
       "$CLAUDE_DIR/settings.json" >/dev/null 2>&1; then
    if [ -x "$hookcmd" ]; then ok "PostToolUse escalate-on-churn wired"
    else bad "escalate-on-churn wired but not executable"; fi
  else bad "PostToolUse escalate-on-churn not wired"; fi

  # The always-on line actually reached the files the agents read.
  for f in "$CLAUDE_DIR/CLAUDE.md" "$CODEX_DIR/AGENTS.md"; do
    grep -qF "$LINE" "$f" 2>/dev/null && ok "${f/#$HOME/\~} carries the line" \
      || bad "${f/#$HOME/\~} is missing the token-furnace line"
  done

  # A rollback path must exist, or "undo with --rollback" is a lie.
  latest="$(ls -1d "$BACKUP_ROOT"/*/ 2>/dev/null | sort | tail -1 || true)"
  if [ -n "$latest" ] && [ -x "$latest/restore.sh" ]; then ok "backup restorable: ${latest/#$HOME/\~}"
  else bad "no restorable backup in ${BACKUP_ROOT/#$HOME/\~}"; fi

  if [ "$FAILS" = 0 ]; then printf '\n  \033[32mall checks passed\033[0m\n'; return 0; fi
  printf '\n  \033[31m%s check(s) failed\033[0m\n' "$FAILS"; return 1
}

# --- rollback --------------------------------------------------------------
if [ "$ROLLBACK" = 1 ]; then
  latest="$(ls -1d "$BACKUP_ROOT"/*/ 2>/dev/null | sort | tail -1 || true)"
  [ -n "$latest" ] || { echo "no backups in $BACKUP_ROOT" >&2; exit 1; }
  echo "restoring $latest"
  bash "$latest/restore.sh"
  exit 0
fi

if [ "$VERIFY_ONLY" = 1 ]; then verify; exit $?; fi

# --- backup ----------------------------------------------------------------
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$BACKUP_ROOT/$STAMP"

head_ "Backup"
if [ "$APPLY" = 1 ]; then
  mkdir -p "$BACKUP"
  : > "$BACKUP/restore.sh"
  {
    echo '#!/usr/bin/env bash'
    echo 'set -euo pipefail'
    echo "d=\"\$(cd \"\$(dirname \"\${BASH_SOURCE[0]}\")\" && pwd)\""
  } >> "$BACKUP/restore.sh"
  for pair in "${TRACKED[@]}"; do
    label="${pair%%:*}"; path="${pair#*:}"
    if [ -f "$path" ]; then
      cp -p "$path" "$BACKUP/$label"
      # Snapshot the live file before overwriting it, so the rollback is itself
      # reversible — ~/.claude.json in particular also holds unrelated state.
      printf 'if [ -f %q ]; then cp -p %q "$d/%s.pre-rollback"; fi\ncp -p "$d/%s" %q\n' \
        "$path" "$path" "$label" "$label" "$path" >> "$BACKUP/restore.sh"
      did "saved $path"
    else
      # File did not exist. Restoring sets it aside rather than deleting it.
      printf 'if [ -f %q ]; then mv %q %q.token-furnace-removed; fi\n' "$path" "$path" "$path" >> "$BACKUP/restore.sh"
      say "absent $path (restore will move it aside, not delete)"
    fi
  done
  echo 'echo "restored"' >> "$BACKUP/restore.sh"
  chmod +x "$BACKUP/restore.sh"
  ok "$BACKUP"
  say "undo with: $(basename "${BASH_SOURCE[0]}") --rollback"
else
  plan "back up 5 files to $BACKUP_ROOT/<timestamp>/ with a restore.sh"
fi

# --- 1. skills -------------------------------------------------------------
# repo/skills/<name> -> ~/.agents/skills/<name> -> {~/.claude,~/.codex}/skills/<name>
# One shared copy, so an update to the checkout lands in both agents at once.
head_ "1. Skills (both agents)"
link() { # link <target> <linkname>
  local t="$1" l="$2"
  if [ -e "$l" ] || [ -L "$l" ]; then
    if [ "$(readlink -f "$l" 2>/dev/null)" = "$(readlink -f "$t")" ]; then ok "${l/#$HOME/\~}"; return; fi
    warn "${l/#$HOME/\~} exists and points elsewhere — left alone"; return
  fi
  if [ "$APPLY" = 1 ]; then mkdir -p "$(dirname "$l")"; ln -s "$t" "$l"; did "${l/#$HOME/\~}"
  else plan "link ${l/#$HOME/\~} -> ${t/#$HOME/\~}"; fi
}
for s in "${SKILLS[@]}"; do
  if [ ! -d "$SKILLS_SRC/$s" ]; then warn "$s not found in $SKILLS_SRC"; continue; fi
  link "$SKILLS_SRC/$s" "$HUB/$s"
  link "$HUB/$s" "$CLAUDE_DIR/skills/$s"
  link "$HUB/$s" "$CODEX_DIR/skills/$s"
done

# --- 3. the always-on line -------------------------------------------------
head_ "2. Always-on instruction"
inject() { # inject <file>
  local f="$1" tmp
  if [ -f "$f" ] && grep -qF "$BEGIN" "$f"; then
    if grep -qF "$LINE" "$f"; then ok "${f/#$HOME/\~} current"; return; fi
    if [ "$APPLY" = 1 ]; then
      tmp="$(mktemp)"
      awk -v b="$BEGIN" -v e="$END" -v l="$LINE" '
        $0==b {print; print l; skip=1; next}
        $0==e {print; skip=0; next}
        !skip {print}' "$f" > "$tmp" && mv "$tmp" "$f"
      did "${f/#$HOME/\~} line replaced"
    else plan "replace the line between markers in ${f/#$HOME/\~}"; fi
    return
  fi
  if [ "$APPLY" = 1 ]; then
    mkdir -p "$(dirname "$f")"
    { [ -s "$f" ] && printf '\n'; printf '%s\n%s\n%s\n' "$BEGIN" "$LINE" "$END"; } >> "$f"
    did "${f/#$HOME/\~} line added"
  else plan "append the marked line to ${f/#$HOME/\~}"; fi
}
inject "$CLAUDE_DIR/CLAUDE.md"
inject "$CODEX_DIR/AGENTS.md"

# --- 4. config -------------------------------------------------------------
head_ "3. Token-efficient defaults"

set_claude_env() { # set_claude_env <key> <value>
  local f="$CLAUDE_DIR/settings.json" k="$1" v="$2" cur tmp
  [ -f "$f" ] || { if [ "$APPLY" = 1 ]; then mkdir -p "$CLAUDE_DIR"; echo '{}' > "$f"; fi; }
  cur="$(jq -r --arg k "$k" '.env[$k] // empty' "$f" 2>/dev/null || true)"
  if [ "$cur" = "$v" ]; then ok "claude $k=$v"; return; fi
  if [ -n "$cur" ]; then warn "claude $k already set to \"$cur\" — left alone (wanted $v)"; return; fi
  if [ "$APPLY" = 1 ]; then
    tmp="$(mktemp)"
    jq --arg k "$k" --arg v "$v" '.env = ((.env // {}) + {($k): $v})' "$f" > "$tmp" && mv "$tmp" "$f"
    did "claude $k=$v"
  else plan "set claude $k=$v"; fi
}

set_claude_hook() { # wire the retry circuit breaker in as a PostToolUse hook
  # The rule is easy to write down and easy to ignore mid-loop, so it ships as a
  # hook rather than as prose. Idempotent: matched on the command path, so a
  # re-run never appends a second copy.
  local f="$CLAUDE_DIR/settings.json" cmd="$HUB/token-furnace/scripts/escalate-on-churn.py" tmp
  [ -f "$f" ] || { if [ "$APPLY" = 1 ]; then mkdir -p "$CLAUDE_DIR"; echo '{}' > "$f"; fi; }
  if jq -e --arg c "$cmd" '[.hooks.PostToolUse[]?.hooks[]?.command] | any(. == $c)' \
       "$f" >/dev/null 2>&1; then
    ok "claude PostToolUse escalate-on-churn"; return
  fi
  if [ "$APPLY" = 1 ]; then
    tmp="$(mktemp)"
    jq --arg c "$cmd" '.hooks = ((.hooks // {}) | .PostToolUse = ((.PostToolUse // []) + [{
         matcher: "Edit|Write|NotebookEdit",
         hooks: [{type: "command", command: $c}]
       }]))' "$f" > "$tmp" && mv "$tmp" "$f"
    did "claude PostToolUse escalate-on-churn"
  else plan "wire claude PostToolUse escalate-on-churn"; fi
}

set_codex() { # set_codex <table|""> <key> <toml-value>
  local f="$CODEX_DIR/config.toml"
  if [ "$APPLY" = 1 ]; then
    TS_FILE="$f" TS_TABLE="$1" TS_KEY="$2" TS_VAL="$3" python3 - <<'PY'
import os, sys, tomllib
f, table, key, val = (os.environ[k] for k in ("TS_FILE","TS_TABLE","TS_KEY","TS_VAL"))
lines = open(f).read().splitlines(True) if os.path.exists(f) else []
hdr = f"[{table}]"
if table:
    try: i = next(n for n,l in enumerate(lines) if l.strip() == hdr)
    except StopIteration:
        if lines and not lines[-1].endswith("\n"): lines.append("\n")
        lines += ["\n", hdr + "\n", f"{key} = {val}\n"]
    else:
        lines.insert(i + 1, f"{key} = {val}\n")
else:
    # Top-level keys must precede the first table header.
    i = next((n for n,l in enumerate(lines) if l.lstrip().startswith("[")), len(lines))
    at_table = i < len(lines)
    while i > 0 and not lines[i-1].strip():   # group with the other top-level keys
        i -= 1
    lines[i:i] = [f"{key} = {val}\n"] + ([] if at_table else ["\n"])
out = "".join(lines)
tomllib.loads(out)   # refuse to write a file that will not parse
open(f, "w").write(out)
PY
    did "codex ${1:+$1.}$2 = $3"
  else plan "set codex ${1:+$1.}$2 = $3"; fi
}


codex_set_if_unset() { # <table|""> <key> <toml-value> <human-value>
  local cur
  if cur="$(codex_has "$1" "$2")"; then
    if [ "$cur" = "$4" ]; then ok "codex ${1:+$1.}$2 = $4"
    else warn "codex ${1:+$1.}$2 already \"$cur\" — left alone (wanted $4)"; fi
    return
  fi
  set_codex "$1" "$2" "$3"
}

# Safe: these bound fan-out and tool output. None of them lower reasoning quality.
set_claude_env CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS 3
set_claude_env ENABLE_TOOL_SEARCH true
set_claude_env MAX_MCP_OUTPUT_TOKENS 12000
set_claude_hook
codex_set_if_unset ""       model_verbosity          '"low"'   low
codex_set_if_unset ""       tool_output_token_limit  10000     10000
codex_set_if_unset agents   max_concurrent_threads_per_session 3 3
codex_set_if_unset agents   default_subagent_reasoning_effort  '"medium"' medium

# Risky: off unless --aggressive. See SKILL.md "Config: what gets set, and what gets refused".
head_ "   Flagged as risky"
if [ "$AGGRESSIVE" = 1 ]; then
  say "--aggressive: spawn depth has version-specific reports of behaving one level off."
  say "Verify after any Claude Code upgrade that subagents still spawn."
  set_claude_env CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH 1
else
  say "not set (pass --aggressive to include, after reading SKILL.md):"
  say "  CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1   may block all spawning on some versions"
fi

head_ "Never set by this script"
say "CLAUDE_CODE_EFFORT_LEVEL         your reasoning baseline is yours, not a script's"
say "codex model_reasoning_effort     same — not read, not written, not suggested"
say "codex skills.max_context_tokens  truncates the skill catalog; prune skills instead"
say "codex agents.max_depth           not in the current official config reference"

# --- summary ---------------------------------------------------------------
if [ "$APPLY" = 1 ]; then
  verify || true

  head_ "Skills now available in both agents"
  say "prd-creator   slice uncertain or cross-file work into a compact PRD, then"
  say "              execute from it in a fresh context. The largest single saving"
  say "              here: the executor never rediscovers the architecture."
  say "prd-manager   where every PRD stands, without reading them."
  say "token-furnace   this policy — read it with /token-furnace or the SKILL.md path."
fi

head_ "Next"
if [ "$APPLY" = 1 ]; then
  say "1. Start a fresh session in either agent."
  say "2. Confirm the token-furnace line is in context."
  say "3. Re-check any time: $(basename "${BASH_SOURCE[0]}") --verify"
  say "4. Unhappy with anything: $(basename "${BASH_SOURCE[0]}") --rollback"
else
  say "Dry run. Nothing was written."
  say "Apply with: $(basename "${BASH_SOURCE[0]}") --apply"
fi
