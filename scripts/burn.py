#!/usr/bin/env python3
"""Where the token budget actually went.

Reads local coding-agent session transcripts and reports spend by context size, by
project, by session, plus the always-resident preamble cost. No dependencies, no
network, read-only.

    python3 burn.py                  # last 7 days, every agent found
    python3 burn.py 30               # last 30 days
    python3 burn.py --source codex   # one agent only
    python3 burn.py --list-sources   # what is installed on this machine

Supported transcript formats: Claude Code (~/.claude/projects/*/*.jsonl) and Codex
(~/.codex/sessions/**/rollout-*.jsonl). Both are auto-detected; whichever is present
gets read. Adding a third agent means one entry in SOURCES.

The headline row is SPEND BY CONTEXT SIZE. Cost per turn scales with the context
carried into it, so a small number of very long turns can dominate a week. If most
of the spend sits above 300k, the fix is a smaller context window (so compaction
actually fires) or fresh sessions between unrelated tasks -- not compression.

Weighting: cache reads bill at roughly 0.1x base input, cache writes at 1.25x, and
output at ~5x, so raw token counts overstate cheap cached reads and understate
output. Everything here is reported in base-input-equivalent tokens, scaled by a
rough per-model price ratio. Models with no known ratio are counted at 1.0 and
reported separately -- an unpriced model is flagged, never silently billed as cheap.
"""

import argparse
import collections
import datetime
import glob
import json
import os
import re
import sys

CACHE_READ_RATE = 0.1
CACHE_WRITE_RATE = 1.25
OUTPUT_RATE = 5.0

# Rough price ratios against the flagship of each family. Substring match on the
# model id, longest key first, so "gpt-5-mini" does not match "gpt-5".
MODEL_RATE = {
    "haiku": 0.2,
    "sonnet": 0.6,
    "opus": 1.0,
    "gpt-5-mini": 0.2,
    "gpt-5.5": 1.0,
    "gpt-5": 1.0,
}

# A session whose last turn is this recent counts as active right now.
ACTIVE_MINUTES = 30

SIZE_BUCKETS = [(0, 100), (100, 200), (200, 300), (300, 500), (500, 1000), (1000, None)]


def model_rate(model):
    """Price ratio for a model id, or None when the model is unknown."""
    for name in sorted(MODEL_RATE, key=len, reverse=True):
        if name in (model or ""):
            return MODEL_RATE[name]
    return None


def bucket_label(tokens):
    for low, high in SIZE_BUCKETS:
        if high is None or low <= tokens / 1000 < high:
            return "%dk+" % low if high is None else "%d-%dk" % (low, high)
    return "?"


def parse_time(value):
    try:
        return datetime.datetime.fromisoformat((value or "").replace("Z", "+00:00"))
    except ValueError:
        return None


def turn(project, session, model, when, base_in, cache_read, cache_write, output, tools,
         reads=0, wakes=()):
    """One normalized assistant turn. Every source yields these and nothing else.

    reads: tool calls in this turn that read files or logs in the caller's own context.
    wakes: what arrived before this turn -- "human", "teammate", "task" or "peer" each.
    """
    return {
        "project": project, "session": session, "model": model, "when": when,
        "base_in": base_in, "cache_read": cache_read, "cache_write": cache_write,
        "output": output, "tools": tools, "reads": reads, "wakes": list(wakes),
    }


# A shell command that reads files or logs into the caller's context.
READ_COMMAND = re.compile(
    r"(?:^|&&|;|\|\||\n)\s*(?:sed -n|grep|rg|cat|head|tail|awk|jq|find|python3? -c?(?:\s|$))")
READ_TOOLS = {"Read", "Grep", "Glob"}


def is_read(name, command):
    return name in READ_TOOLS or bool(command and READ_COMMAND.search(command.strip()))


def classify_prompt(text):
    """What a user record means: a wakeup kind, a human prompt, or None (harness noise)."""
    if "<teammate-message" in text:
        return "teammate"
    if "<task-notification" in text:
        return "task"
    if "<cross-session-message" in text:
        return "peer"
    text = text.lstrip()
    if (not text or text.startswith("<") or text.startswith("This session is being continued")
            or text.startswith("Base directory for this skill")):
        return None
    return "human"


# --- Claude Code -----------------------------------------------------------

def claude_root():
    base = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
    return os.path.join(base, "projects")


def claude_files():
    return sorted(glob.glob(os.path.join(claude_root(), "*", "*.jsonl")))


def claude_user_wake(record):
    if record.get("isMeta"):
        return None
    content = (record.get("message") or {}).get("content")
    if isinstance(content, list):
        content = " ".join(b.get("text", "") for b in content
                           if isinstance(b, dict) and b.get("type") == "text")
    return classify_prompt(content) if isinstance(content, str) else None


def claude_title(path):
    """The session's latest custom or generated title, else its first prompt, or None.

    Sessions with no human prompt (a /goal loop, an agent-started session) never get a title."""
    title = first = None
    with open(path, errors="replace") as fh:
        for line in fh:
            titled = '"customTitle"' in line or '"aiTitle"' in line
            if not titled and (first or '"user"' not in line):
                continue
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if titled:
                title = record.get("customTitle") or record.get("aiTitle") or title
            elif record.get("type") == "user" and not record.get("isMeta"):
                content = (record.get("message") or {}).get("content")
                if isinstance(content, str) and not content.startswith("<local-command"):
                    command = re.search(r"<command-name>(.*?)</command-name>", content)
                    args = re.search(r"<command-args>(.*?)</command-args>", content, re.S)
                    text = (command.group(1) + " " + (args.group(1) if args else "")
                            if command else content)
                    first = " ".join(text.split())[:80] or None
    return title or first


def claude_turns(path):
    project = os.path.basename(os.path.dirname(path))
    session = os.path.basename(path)[:-6]
    wakes = []
    with open(path, errors="replace") as fh:
        for line in fh:
            is_user = '"user"' in line and '"tool_result"' not in line
            if '"assistant"' not in line and not is_user:
                continue
            try:
                record = json.loads(line)
            except ValueError:
                continue
            # The directory name encodes the whole path; the record's cwd names the project.
            project = os.path.basename((record.get("cwd") or "").rstrip("/")) or project
            if record.get("type") == "user":
                kind = claude_user_wake(record)
                if kind:
                    wakes.append(kind)
                continue
            if record.get("type") != "assistant":
                continue
            when = parse_time(record.get("timestamp"))
            if when is None:
                continue
            message = record.get("message") or {}
            usage = message.get("usage") or {}
            if not usage:
                continue
            get = lambda key: usage.get(key) or 0
            calls = [b for b in (message.get("content") or [])
                     if isinstance(b, dict) and b.get("type") == "tool_use"]
            tools = [b.get("name") for b in calls]
            reads = sum(is_read(b.get("name"), (b.get("input") or {}).get("command"))
                        for b in calls)
            yield turn(project, session, message.get("model"), when,
                       get("input_tokens"), get("cache_read_input_tokens"),
                       get("cache_creation_input_tokens"), get("output_tokens"), tools,
                       reads, wakes)
            wakes = []


# --- Codex -----------------------------------------------------------------

def codex_home():
    return os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex")


def codex_root():
    return os.path.join(codex_home(), "sessions")


def codex_files():
    return sorted(glob.glob(os.path.join(codex_root(), "**", "rollout-*.jsonl"),
                            recursive=True))


def codex_turns(path):
    """Codex logs usage in event_msg/token_count and tool calls in separate records.

    input_tokens already includes the cached portion, unlike Claude Code, so base
    input is the difference. Reasoning tokens bill as output.
    """
    project = "?"
    session = os.path.basename(path)
    model = None
    pending_tools = []
    pending_reads = 0
    wakes = []
    with open(path, errors="replace") as fh:
        for line in fh:
            try:
                record = json.loads(line)
            except ValueError:
                continue
            payload = record.get("payload") or {}
            kind = record.get("type")

            if kind == "session_meta":
                cwd = payload.get("cwd") or ""
                project = os.path.basename(cwd.rstrip("/")) or project
                session = (payload.get("id") or session)[:8]
                continue
            if kind == "turn_context":
                model = payload.get("model") or model
                continue
            if payload.get("type") == "function_call":
                pending_tools.append(payload.get("name"))
                pending_reads += is_read(None, str(payload.get("arguments") or ""))
                continue
            if payload.get("type") == "user_message":
                kind = classify_prompt(payload.get("message") or "")
                if kind:
                    wakes.append(kind)
                continue
            if payload.get("type") != "token_count":
                continue

            usage = ((payload.get("info") or {}).get("last_token_usage")) or {}
            if not usage:
                continue
            when = parse_time(record.get("timestamp"))
            if when is None:
                continue
            get = lambda key: usage.get(key) or 0
            cached = get("cached_input_tokens")
            tools, pending_tools = pending_tools, []
            reads, pending_reads = pending_reads, 0
            yield turn(project, session, model, when,
                       max(get("input_tokens") - cached, 0), cached, 0,
                       get("output_tokens") + get("reasoning_output_tokens"), tools,
                       reads, wakes)
            wakes = []


SOURCES = {
    "claude": (claude_root, claude_files, claude_turns),
    "codex": (codex_root, codex_files, codex_turns),
}


def active_sources(requested):
    names = list(SOURCES) if requested == "all" else [requested]
    return [n for n in names if os.path.isdir(SOURCES[n][0]())]


# Windows for the weekly-limit gain: percentage points spent in the last N hours.
GAIN_HOURS = (1, 6, 24)
# Window for the checks and the leaks: what the user fixed recently must show up.
CHECK_HOURS = 24
LEVELS = {1: "critical", 2: "warn", 3: "info"}  # leak priority -> the word the page shows

# Thresholds for the per-session leak flags. Each one maps to a measured failure.
BENCH_WINDOW = 200_000        # the benchmark: same turns with context capped here
LATE_COMPACT_PEAK = 300_000   # context above this means auto-compact fires too late
CALLER_READS = 100            # reads the caller ran itself instead of delegating
WAKEUPS = 50                  # teammate/task/peer messages, each a full-context turn
TURNS_PER_PROMPT = 200        # an unbounded autonomous loop
LONG_LIVED_HOURS = 12         # one session carrying many unrelated tasks
MEMORY_INDEX_LINES = 200      # Claude Code loads only this many lines of MEMORY.md
COMPACT_WINDOW_MAX = 300_000
SUBAGENT_CAP = 3              # most concurrent subagents worth running (each one is a full loop)
SUBAGENT_DEPTH = 1            # nesting depth: 1 blocks subagents spawning subagents
TOOL_CONCURRENCY = 4          # parallel tool calls in the main agent
SUBAGENT_ENV = "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS"
CODEX_SUBAGENT_KEY = "max_concurrent_threads_per_session"


def session_flags(turns, peak, hours, reads, wakes):
    flags = []
    if peak > LATE_COMPACT_PEAK:
        flags.append("late compaction: peak %dk. Set autoCompactWindow to about 200000."
                     % (peak / 1000))
    if reads >= CALLER_READS:
        flags.append("caller reads: %d file/log reads. Send them to a cheap read-only agent." % reads)
    pings = wakes["teammate"] + wakes["task"] + wakes["peer"]
    if pings >= WAKEUPS:
        flags.append("wakeups: %d (teammate %d, task %d, peer %d). Ask for one report at "
                     "the end." % (pings, wakes["teammate"], wakes["task"], wakes["peer"]))
    if turns / max(wakes["human"], 1) >= TURNS_PER_PROMPT:
        flags.append("loop: %d turns for %d human prompts. Give the loop a stop condition "
                     "and a budget." % (turns, wakes["human"]))
    if hours >= LONG_LIVED_HOURS:
        flags.append("long-lived: %.0fh. Start one fresh session per task." % hours)
    return flags


def compact_window(settings_path):
    """The auto-compact window in tokens, the source that set it, or (None, None)."""
    env = os.environ.get("CLAUDE_CODE_AUTO_COMPACT_WINDOW")
    if env:
        text = env.strip().lower()
        scale = {"k": 1_000, "m": 1_000_000}.get(text[-1:], 1)
        try:
            value = float(text.rstrip("km")) * scale
        except ValueError:
            return None, "env (unparsed: %s)" % env
        return int(value if value >= 1000 else value * 1000), "env"
    try:
        with open(settings_path) as fh:
            value = json.load(fh).get("autoCompactWindow")
    except (OSError, ValueError):
        return None, None
    return (int(value), "settings") if isinstance(value, (int, float)) else (None, None)


def claude_env_int(settings_path, key):
    """An integer env setting from ~/.claude/settings.json .env (which wins, as setup-agents.sh
    writes there) or the process env, as (value, source)."""
    try:
        with open(settings_path) as fh:
            value = (json.load(fh).get("env") or {}).get(key)
    except (OSError, ValueError, AttributeError):
        value = None
    source = "settings"
    if value is None:
        value, source = os.environ.get(key), "env"
    if value is None:
        return None, None
    try:
        return int(float(value)), source
    except (TypeError, ValueError):
        return None, "%s (unparsed: %s)" % (source, value)


def claude_env_str(settings_path, key):
    """A string env setting from settings.json .env or the process env, as (value, source)."""
    try:
        with open(settings_path) as fh:
            value = (json.load(fh).get("env") or {}).get(key)
    except (OSError, ValueError, AttributeError):
        value = None
    if value is None:
        return os.environ.get(key), "env"
    return value, "settings"


def claude_subagent_cap(settings_path):
    """The concurrent-subagent cap and the source that set it, or (None, None)."""
    return claude_env_int(settings_path, SUBAGENT_ENV)


def codex_value(path, key):
    """A value (string) from ~/.codex/config.toml, under [table] or as a dotted key."""
    try:
        with open(path, errors="replace") as fh:
            text = fh.read()
    except OSError:
        return None
    match = re.search(r"^\s*(?:[a-z_]+\s*\.\s*)?%s\s*=\s*(.+)$" % re.escape(key), text, re.M)
    return match.group(1).strip().strip('"').strip("'") if match else None


def codex_subagent_cap(path):
    """Codex's [agents] max_concurrent_threads_per_session, or (None, None)."""
    value = codex_value(path, CODEX_SUBAGENT_KEY)
    try:
        return int(value), "config.toml"
    except (TypeError, ValueError):
        return None, None


def _at_most(agent, label, key, value, source, limit):
    """A numeric config note where lower is better: unset or over the limit warns."""
    if value is None:
        shown, line = "unset", "%s is unset: set it to at most %d." % (key, limit)
    else:
        shown = "%.0f" % value
        line = ("%s is %d (from %s): too high. Use %d." % (key, value, source, limit)
                if value > limit else "%s is %d (from %s): ok." % (key, value, source))
    ok = value is not None and value <= limit
    return {"name": label, "source": agent, "value": shown, "target": "at most %d" % limit,
            "ok": ok, "level": "ok" if ok else "warn",
            "ratio": value / limit if value else None, "line": line}


def _is_set(agent, label, key, value, source, want):
    """A string config note: unset warns, set is ok. `want` is the advice when unset."""
    ok = bool(value)
    line = ("%s is %s (from %s): ok." % (key, value, source) if ok
            else "%s is unset: %s" % (key, want))
    return {"name": label, "source": agent, "value": value or "unset",
            "target": "pinned", "ok": ok, "level": "ok" if ok else "warn",
            "ratio": None, "line": line}


def config_notes(live):
    """Recommended settings, one per agent, judged from actual config. Shared by the Checks
    table (as source-tagged rows) and the config leaks (as `.line`)."""
    notes = []
    base = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
    settings = os.path.join(base, "settings.json")
    if "claude" in live:
        window, wsource = compact_window(settings)
        within = bool(window) and abs(window - 200_000) <= 50_000
        if window is None:
            line = ("autoCompactWindow is unset: compaction waits for the model window "
                    "(about 1M on 1M models). Set \"autoCompactWindow\": 200000.")
        elif window > COMPACT_WINDOW_MAX:
            line = ("autoCompactWindow is %dk (from %s): too high. Use about 200k."
                    % (window / 1000, wsource))
        else:
            line = "autoCompactWindow is %dk (from %s): ok." % (window / 1000, wsource)
        notes.append({"name": "autoCompactWindow", "source": "claude",
                      "value": "%dk" % (window / 1000) if window else "unset (model max)",
                      "target": "about 200k", "ok": within, "level": "ok" if within else "warn",
                      "ratio": window / 200_000 if window else None, "line": line})
        cap, csrc = claude_subagent_cap(settings)
        notes.append(_at_most("claude", "Max concurrent subagents", SUBAGENT_ENV, cap, csrc,
                              SUBAGENT_CAP))
        depth, dsrc = claude_env_int(settings, "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH")
        notes.append(_at_most("claude", "Subagent spawn depth",
                              "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH", depth, dsrc, SUBAGENT_DEPTH))
        model, msrc = claude_env_str(settings, "CLAUDE_CODE_SUBAGENT_MODEL")
        notes.append(_is_set("claude", "Subagent model", "CLAUDE_CODE_SUBAGENT_MODEL", model, msrc,
                             "subagents inherit the main model; pin a cheap worker "
                             "(e.g. CLAUDE_CODE_SUBAGENT_MODEL=sonnet)."))
        tools, tsrc = claude_env_int(settings, "CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY")
        notes.append(_at_most("claude", "Tool-call concurrency",
                              "CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY", tools, tsrc, TOOL_CONCURRENCY))
    if "codex" in live:
        config = os.path.join(codex_home(), "config.toml")
        cap, csrc = codex_subagent_cap(config)
        notes.append(_at_most("codex", "Max concurrent subagents",
                              "agents.%s" % CODEX_SUBAGENT_KEY, cap, csrc, SUBAGENT_CAP))
        depth = codex_value(config, "max_depth")
        notes.append(_at_most("codex", "Agent nesting depth", "agents.max_depth",
                              int(depth) if depth and depth.isdigit() else None,
                              "config.toml", SUBAGENT_DEPTH))
        effort = codex_value(config, "default_subagent_reasoning_effort")
        effort_ok = effort in ("low", "medium", "minimal", "none")
        notes.append({"name": "Subagent reasoning effort", "source": "codex",
                      "value": effort or "unset", "target": "low or medium", "ok": effort_ok,
                      "level": "ok" if effort_ok else "warn", "ratio": None,
                      "line": ("agents.default_subagent_reasoning_effort is %s: ok." % effort
                               if effort_ok else
                               "agents.default_subagent_reasoning_effort is %s: set it to low or "
                               "medium so workers don't inherit a costly effort."
                               % (effort or "unset"))})
        compact = codex_value(config, "model_auto_compact_token_limit")
        compact_ok = compact is not None and compact.isdigit() and int(compact) <= COMPACT_WINDOW_MAX
        notes.append({"name": "Auto-compact token limit", "source": "codex",
                      "value": compact or "unset", "target": "about 160k", "ok": compact_ok,
                      "level": "ok" if compact_ok else "warn", "ratio": None,
                      "line": ("model_auto_compact_token_limit is %s: ok." % compact if compact_ok
                               else "model_auto_compact_token_limit is %s: set about 160000 for a "
                               ">=200K window." % (compact or "unset"))})
    return notes


def config_checks(live):
    lines = [note["line"] for note in config_notes(live)]
    if "claude" in live:
        base = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
        for index in glob.glob(os.path.join(base, "projects", "*", "memory", "MEMORY.md")):
            with open(index, errors="replace") as fh:
                count = sum(1 for _ in fh)
            if count > MEMORY_INDEX_LINES:
                lines.append("%s has %d lines: lines after %d are not loaded, so those "
                             "memories are invisible. Shorten it." % (index.replace(base, "~/.claude"
                             if base == os.path.expanduser("~/.claude") else base),
                             count, MEMORY_INDEX_LINES))
    return lines or ["none"]


_CACHE = {}


def cached(parse, path):
    """parse(path), reused while the file's mtime and size are unchanged (for --serve)."""
    stat = os.stat(path)
    key = (parse.__name__, path)
    if _CACHE.get(key, (None,))[0] != (stat.st_mtime_ns, stat.st_size):
        result = parse(path)
        _CACHE[key] = ((stat.st_mtime_ns, stat.st_size),
                       list(result) if parse is not claude_title else result)
    return _CACHE[key][1]


def build_report(args):
    """Parse every transcript in the window into the report dict, or None if empty."""
    live = active_sources(args.source)
    if not live:
        print("No transcripts found. Try --list-sources.")
        return None

    cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=args.days)

    by_size = collections.defaultdict(float)
    turns_by_size = collections.Counter()
    by_project = collections.defaultdict(float)
    by_source = collections.defaultdict(float)
    tools = collections.Counter()
    unpriced = collections.Counter()
    sessions = {}
    total = 0.0
    unpriced_cost = 0.0
    preamble_reread = 0
    all_context = 0
    preambles = []
    signals = {}
    timeline = collections.defaultdict(lambda: [0.0, 0.0])
    hourly = collections.defaultdict(lambda: {"bench": 0.0, "ctx": [], "reads": 0, "calls": 0})
    contexts = []
    totals = collections.Counter()
    titles = {}
    paths = {}
    active = []
    now = datetime.datetime.now(datetime.timezone.utc)
    last_hour = collections.defaultdict(float)
    recent = collections.defaultdict(collections.Counter)  # source -> {hours: spend}
    weeks = {"claude": plan_week(), "codex": codex_week()}
    week_now = collections.defaultdict(float)
    recent_cut = now - datetime.timedelta(hours=CHECK_HOURS)
    last24 = {"total": 0.0, "over": 0.0, "turns": 0, "contexts": [], "tool_calls": 0,
              "reads": 0, "wakes": collections.Counter(), "preambles": [],
              "cache_write": 0, "cache_input": 0, "top": 0.0}
    stats7 = {"cache_write": 0, "cache_input": 0, "turns": 0, "top": 0.0}
    # The same aggregates, kept per source, so the checks can be judged per provider.
    per = collections.defaultdict(lambda: {
        "recent": {"total": 0.0, "over": 0.0, "turns": 0, "contexts": [], "tool_calls": 0,
                   "reads": 0, "wakes": collections.Counter(), "preambles": [],
                   "cache_write": 0, "cache_input": 0, "top": 0.0, "sessions": 0},
        "stats7": {"turns": 0, "top": 0.0, "cache_write": 0, "cache_input": 0},
        "contexts": [], "preambles": [], "totals": collections.Counter(),
        "turns": 0, "total": 0.0, "over": 0.0, "sessions": set(),
        "hours24": 0.0, "hours_all": 0.0,
    })
    top_rate = max(MODEL_RATE.values())
    week_hourly = collections.defaultdict(lambda: collections.defaultdict(lambda: [0.0, 0.0]))
    sessions24 = {}  # key -> (cost, turns, peak, full age in hours) for the last CHECK_HOURS
    signals24 = {}

    for source in live:
        _, files, read = SOURCES[source]
        for path in files():
            if os.path.getmtime(path) < cutoff.timestamp():
                continue  # untouched since before the window: no turns inside it
            cost = 0.0
            reads = 0
            wakes = collections.Counter()
            count = 0
            peak = 0
            hour_cost = 0.0
            model = None
            first_context = 0
            first_seen = last_seen = None
            c_cost = c_count = c_peak = c_reads = 0
            c_wakes = collections.Counter()
            project = session = None

            for item in cached(read, path):
                if item["when"] < cutoff:
                    continue
                context = item["base_in"] + item["cache_read"] + item["cache_write"]
                if not context:
                    continue

                rate = model_rate(item["model"])
                raw = (item["base_in"]
                       + CACHE_READ_RATE * item["cache_read"]
                       + CACHE_WRITE_RATE * item["cache_write"]
                       + OUTPUT_RATE * item["output"])
                weighted = (rate if rate is not None else 1.0) * raw
                if rate is None:
                    unpriced[item["model"] or "unknown"] += 1
                    unpriced_cost += weighted

                project, session = item["project"], item["session"]
                count += 1
                cost += weighted
                total += weighted
                model = item["model"] or model
                if item["when"] >= now - datetime.timedelta(hours=1):
                    last_hour[source] += weighted
                    hour_cost += weighted
                for hours in GAIN_HOURS:
                    if item["when"] >= now - datetime.timedelta(hours=hours):
                        recent[source][hours] += weighted
                week = weeks.get(source)
                if week and item["when"] >= week["start"]:
                    week_now[source] += weighted
                all_context += context
                is_top = rate is not None and rate >= top_rate
                stats7["turns"] += 1
                stats7["top"] += weighted if is_top else 0.0
                if source == "claude":  # Codex logs no cache writes, so it would read as 0%
                    stats7["cache_write"] += item["cache_write"]
                    stats7["cache_input"] += context
                peak = max(peak, context)
                by_project[project] += weighted
                by_source[source] += weighted
                label = bucket_label(context)
                by_size[label] += weighted
                turns_by_size[label] += 1
                tools.update(name for name in item["tools"] if name)
                hour = item["when"].replace(minute=0, second=0, microsecond=0)
                timeline[hour][context >= 300_000] += weighted
                # Benchmark: the same turn if auto-compact had kept context at BENCH_WINDOW.
                trimmed = max(item["cache_read"] - max(context - BENCH_WINDOW, 0), 0)
                slot = hourly[hour]
                bench_turn = weighted - (rate if rate is not None else 1.0) * (
                    CACHE_READ_RATE * (item["cache_read"] - trimmed))
                slot["bench"] += bench_turn
                if weeks.get(source) and item["when"] >= weeks[source]["start"]:
                    week_hourly[source][hour][0] += weighted
                    week_hourly[source][hour][1] += bench_turn
                slot["ctx"].append(context)
                slot["reads"] += item["reads"]
                slot["calls"] += len(item["tools"])
                contexts.append(context)
                totals["tool_calls"] += len(item["tools"])
                totals["reads"] += item["reads"]
                reads += item["reads"]
                wakes.update(item["wakes"])
                totals.update(item["wakes"])
                if item["when"] >= recent_cut:
                    c_cost += weighted
                    c_count += 1
                    c_peak = max(c_peak, context)
                    c_reads += item["reads"]
                    c_wakes.update(item["wakes"])
                    last24["total"] += weighted
                    last24["over"] += weighted if context >= 300_000 else 0.0
                    last24["turns"] += 1
                    last24["contexts"].append(context)
                    last24["tool_calls"] += len(item["tools"])
                    last24["reads"] += item["reads"]
                    last24["wakes"].update(item["wakes"])
                    last24["top"] += weighted if is_top else 0.0
                    if source == "claude":
                        last24["cache_write"] += item["cache_write"]
                        last24["cache_input"] += context

                p = per[source]
                p["total"] += weighted
                p["turns"] += 1
                p["over"] += weighted if context >= 300_000 else 0.0
                p["sessions"].add((project, session))
                p["contexts"].append(context)
                p["stats7"]["turns"] += 1
                p["stats7"]["top"] += weighted if is_top else 0.0
                p["totals"]["tool_calls"] += len(item["tools"])
                p["totals"]["reads"] += item["reads"]
                p["totals"].update(item["wakes"])
                if source == "claude":
                    p["stats7"]["cache_write"] += item["cache_write"]
                    p["stats7"]["cache_input"] += context
                if item["when"] >= recent_cut:
                    p24 = p["recent"]
                    p24["total"] += weighted
                    p24["over"] += weighted if context >= 300_000 else 0.0
                    p24["turns"] += 1
                    p24["contexts"].append(context)
                    p24["tool_calls"] += len(item["tools"])
                    p24["reads"] += item["reads"]
                    p24["wakes"].update(item["wakes"])
                    p24["top"] += weighted if is_top else 0.0
                    if source == "claude":
                        p24["cache_write"] += item["cache_write"]
                        p24["cache_input"] += context

                if count == 1:
                    first_context = context
                    first_seen = item["when"]
                last_seen = item["when"]
                last_context = context

            if count:
                # The first turn is the always-resident prefix: instructions, memory,
                # skill catalog, tool schemas. Every later turn re-reads it.
                preamble_reread += first_context * count
                preambles.append(first_context)
                hours = ((last_seen - first_seen).total_seconds() / 3600
                         if first_seen and last_seen else 0.0)
                sessions[(source, project, session)] = (cost, count, peak, hours)
                signals[(source, project, session)] = (reads, wakes)
                if c_count:
                    sessions24[(source, project, session)] = (c_cost, c_count, c_peak, hours)
                    signals24[(source, project, session)] = (c_reads, c_wakes)
                    if first_seen >= recent_cut:
                        last24["preambles"].append(first_context)
                    per[source]["recent"]["sessions"] += 1
                    if first_seen >= recent_cut:
                        per[source]["recent"]["preambles"].append(first_context)
                per[source]["preambles"].append(first_context)
                per[source]["hours_all"] = max(per[source]["hours_all"], hours)
                per[source]["hours24"] = max(per[source]["hours24"], hours)
                paths[(source, project, session)] = path
                if source == "claude":
                    titles[(source, project, session)] = cached(claude_title, path)
                idle = (now - last_seen).total_seconds() / 60
                if idle <= ACTIVE_MINUTES:
                    active.append(((source, project, session), last_context, idle,
                                   model, hour_cost))

    if not total:
        print("No assistant turns in the last %d days for: %s" % (args.days, ", ".join(live)))
        return None

    share = lambda value: 100 * value / total
    top = sorted(sessions.items(), key=lambda item: -item[1][0])[:10]
    buckets = []
    for low, high in SIZE_BUCKETS:
        label = "%dk+" % low if high is None else "%d-%dk" % (low, high)
        if by_size[label]:
            buckets.append((label, low, share(by_size[label]), turns_by_size[label]))
    preambles.sort()
    last24["sessions"] = len(sessions24)
    share24 = lambda value: 100 * value / last24["total"] if last24["total"] else 0.0
    flags24 = lambda key: (session_flags(*sessions24[key][1:], *signals24[key])
                           if key in sessions24 else [])
    report = {
        "days": args.days, "total": total, "turns": sum(v[1] for v in sessions.values()),
        "session_count": len(sessions),
        "sources": [(n, share(v)) for n, v in sorted(by_source.items())],
        "buckets": buckets,
        "over_300k": sum(b[2] for b in buckets if b[1] >= 300),
        "preamble": (preambles[len(preambles) // 2], preambles[int(len(preambles) * 0.9)],
                     100 * preamble_reread / all_context) if preambles else None,
        "projects": [(n, share(v)) for n, v in
                     sorted(by_project.items(), key=lambda kv: -kv[1])[:8]],
        "sessions": [{
            "source": key[0], "project": key[1] or "?", "id": (key[2] or "?")[:8],
            "title": titles.get(key), "path": paths.get(key), "share": share(cost), "turns": count,
            "peak": peak, "hours": hours, "flags": flags24(key),
        } for key, (cost, count, peak, hours) in top],
        "recent_sessions": [{
            "source": key[0], "project": key[1] or "?", "id": (key[2] or "?")[:8],
            "title": titles.get(key), "path": paths.get(key), "share": share24(cost),
            "turns": count, "peak": peak, "hours": hours, "flags": flags24(key),
        } for key, (cost, count, peak, hours) in
            sorted(sessions24.items(), key=lambda item: -item[1][0])[:10]],
        "recent": last24,
        "tools": tools.most_common(6),
        "config": config_checks(live),
        "unpriced": (share(unpriced_cost), unpriced.most_common(5)) if unpriced else None,
    }
    report["active"] = [{
        "source": key[0], "project": key[1] or "?", "id": (key[2] or "?")[:8],
        "title": titles.get(key), "share": share(sessions[key][0]), "turns": sessions[key][1],
        "peak": sessions[key][2], "hours": sessions[key][3], "context": context, "idle": idle,
        "flags": flags24(key),
        "model": model, "rate": rate,
        "rateShare": 100 * rate / last_hour[key[0]] if last_hour[key[0]] else 0.0,
    } for key, context, idle, model, rate in sorted(active, key=lambda a: -a[4])]
    contexts.sort()
    report["timeline"] = sorted(timeline.items())
    report["hourly"] = sorted(hourly.items())
    report["bench_total"] = sum(v["bench"] for v in hourly.values())
    report["budget"] = args.weekly_budget * 1e6 if args.weekly_budget else None
    report["stats7"] = stats7
    report["per_source"] = {}
    for src in live:
        p = per[src]
        if not p["total"]:
            continue
        ctx, pre = sorted(p["contexts"]), sorted(p["preambles"])
        report["per_source"][src] = {
            "recent": p["recent"], "stats7": p["stats7"], "totals": p["totals"],
            "turns": p["turns"], "total": p["total"], "over_300k": p["over"],
            "session_count": len(p["sessions"]), "hours24": p["hours24"],
            "hours_all": p["hours_all"], "contexts": ctx,
            "preamble": (pre[len(pre) // 2], pre[int(len(pre) * 0.9)]) if pre else None,
        }
    report["baseline"] = baseline(report)
    report["burns"] = {}
    for source in (s for s in live if by_source[s]):
        week, spent = weeks.get(source), week_now[source]
        burn = {"rate": last_hour[source], "total": by_source[source], "week": None}
        if week and week["used"] >= 1 and spent:
            # Calibrate: this week's local spend is `used` percent of the plan's week.
            limit = spent * 100 / week["used"]
            hours_left = max((week["resets"] - now).total_seconds() / 3600, 1)
            gains = {h: recent[source][h] * 100 / limit for h in GAIN_HOURS}
            # Quota points per hour over the last 24 h. A week younger than that has spent only its own
            # points, so divide by the time since the week began.
            age = max((now - week["start"]).total_seconds() / 3600, 1)
            rate24 = week["used"] / age if age < CHECK_HOURS else gains[CHECK_HOURS] / CHECK_HOURS
            left = 100 - week["used"]
            to_empty = left / rate24 if rate24 > 0 else None
            dry = now + datetime.timedelta(hours=to_empty) if to_empty else None
            burn["week"] = {"resets": week["resets"], "hours_left": hours_left, "used": week["used"],
                            "ideal": max(limit - spent, 0) / hours_left,
                            "limit": limit, "start": week["start"],
                            "rate_pct": burn["rate"] * 100 / limit,
                            "ideal_pct": max(left, 0) / hours_left,
                            "burndown": week_points(week_hourly[source], week["start"], now, limit),
                            "projection": {"rate_pct": rate24, "hours_to_empty": to_empty,
                                           "runs_out": dry if dry and dry < week["resets"] else None},
                            "gains": gains}
        report["burns"][source] = burn
    return report


def week_points(buckets, start, now, limit):
    """Cumulative (time, % of the weekly limit used, % if context were capped) per hour, from the
    week start to now. The last point is the calibrated total, so it equals the plan's reading."""
    points, used, capped = [(start, 0.0, 0.0)], 0.0, 0.0
    for hour, (cost, bench) in sorted(buckets.items()):
        used += cost
        capped += bench
        points.append((min(hour + datetime.timedelta(hours=1), now),
                       used * 100 / limit, capped * 100 / limit))
    if points[-1][0] < now:
        points.append((now, points[-1][1], points[-1][2]))
    return points


def usage_cache():
    base = os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache")
    return os.path.join(base, "token-furnace", "usage.json")


def plan_week():
    """The subscription's 7-day window, from the endpoint /usage reads; None when unavailable.

    Sends the Claude Code login token only to api.anthropic.com. The last good reading is
    kept on disk: reused for 5 minutes, and whenever a call fails (the endpoint rate-limits)."""
    import subprocess
    import time
    import urllib.request
    if time.time() - _CACHE.get("week_try", 0) < 60:
        return _CACHE.get("week")
    _CACHE["week_try"] = time.time()
    try:
        with open(usage_cache()) as fh:
            saved = json.load(fh)
    except (OSError, ValueError):
        saved = {}
    data = saved.get("seven_day")
    if not data or time.time() - saved.get("fetched", 0) >= 300:
        try:
            try:
                with open(os.path.join(os.path.dirname(claude_root()), ".credentials.json")) as fh:
                    creds = fh.read()
            except OSError:  # macOS keeps the login in the Keychain
                creds = subprocess.run(
                    ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
                    capture_output=True, text=True, timeout=5, check=True).stdout
            token = json.loads(creds)["claudeAiOauth"]["accessToken"]
            req = urllib.request.Request("https://api.anthropic.com/api/oauth/usage", headers={
                "Authorization": "Bearer " + token, "anthropic-beta": "oauth-2025-04-20"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.load(resp)["seven_day"]
            os.makedirs(os.path.dirname(usage_cache()), exist_ok=True)
            with open(usage_cache(), "w") as fh:
                json.dump({"fetched": time.time(), "seven_day": data}, fh)
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
            pass  # keep the saved reading
    week = None
    try:
        resets = data["resets_at"]  # ISO from the endpoint, epoch seconds from a status line
        resets = (datetime.datetime.fromtimestamp(resets, datetime.timezone.utc)
                  if isinstance(resets, (int, float)) else datetime.datetime.fromisoformat(resets))
        if resets > datetime.datetime.now(datetime.timezone.utc):
            week = {"start": resets - datetime.timedelta(days=7), "resets": resets,
                    "used": float(data["utilization"])}
    except (KeyError, TypeError, ValueError):
        pass
    _CACHE["week"] = week
    return week


def burn_goal(r, source):
    """The hourly burn goal for one source: the plan's remaining week over the hours to its
    reset, else (Claude only) a weekly budget over 168 h, else the window's own average."""
    burn = r["burns"][source]
    if burn["week"]:
        w = burn["week"]
        return w["ideal"], "ideal pace to the weekly reset %s (%.0f h left)" % (
            w["resets"].astimezone().strftime("%a %H:%M"), w["hours_left"])
    if r["budget"] and source == "claude":
        return r["budget"] / 168, "weekly budget %.0fM / 168 h" % (r["budget"] / 1e6)
    return burn["total"] / (r["days"] * 24), (
        "your %d-day average; the subscription usage was unavailable" % r["days"])


def codex_week():
    """Codex's 7-day window from the rate_limits it logs in each session; None when unknown.

    Scans the newest rollouts until a live reading turns up: the most recently touched file
    is often a non-subscription (eval/tooling) session that logs no rate_limits at all."""
    now = datetime.datetime.now(datetime.timezone.utc)
    for path in sorted(codex_files(), key=os.path.getmtime, reverse=True)[:200]:
        with open(path, "rb") as fh:
            fh.seek(max(os.path.getsize(path) - 262144, 0))
            lines = fh.read().decode(errors="replace").splitlines()
        for line in reversed(lines):
            if '"rate_limits"' not in line:
                continue
            try:
                limits = json.loads(line)["payload"]["rate_limits"]
                week = [w for w in (limits.get("primary"), limits.get("secondary"))
                        if w and w.get("window_minutes") == 10080][0]
                resets = datetime.datetime.fromtimestamp(week["resets_at"], datetime.timezone.utc)
            except (ValueError, KeyError, TypeError, IndexError, AttributeError):
                continue
            if resets <= now:
                break  # this file's newest reading is from a finished week; try an older file
            return {"start": resets - datetime.timedelta(days=7), "resets": resets,
                    "used": float(week["used_percent"])}
    return None


def serve(args):
    """Live report: every GET rebuilds it from the transcripts; the page reloads each minute."""
    import http.server

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/dashboard.html":  # the raw page, polled for hot reload: no rebuild
                with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "dashboard.html")) as fh:
                    body, kind = fh.read(), "text/html"
            elif self.path.startswith("/api/report"):
                report = build_report(args)
                body, kind = json.dumps(report_view(report) if report else None,
                                        default=str), "application/json"
            else:
                report = build_report(args)
                body, kind = render_html(report) if report else "No assistant turns.", "text/html"
            self.send_response(200)
            self.send_header("Content-Type", kind + "; charset=utf-8")
            self.end_headers()
            self.wfile.write(body.encode())

        def log_message(self, *_):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.serve), Handler)
    build_report(args)  # warm the parse cache; requests queue on the bound port meanwhile
    print("Token Furnace live on http://127.0.0.1:%d (Ctrl-C to stop)" % args.serve)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


def main():
    parser = argparse.ArgumentParser(description="Where the token budget actually went.")
    parser.add_argument("days", nargs="?", type=int, default=7)
    parser.add_argument("--source", default="all", choices=["all"] + list(SOURCES))
    parser.add_argument("--list-sources", action="store_true")
    parser.add_argument("--html", metavar="PATH", help="also write an HTML report to PATH")
    parser.add_argument("--weekly-budget", type=float, metavar="M",
                        default=float(os.environ.get("TOKEN_FURNACE_WEEKLY_BUDGET") or 0) or None,
                        help="weekly budget in millions of weighted tokens (or env "
                             "TOKEN_FURNACE_WEEKLY_BUDGET); sets the burn-rate goal")
    parser.add_argument("--serve", type=int, metavar="PORT",
                        help="serve a live report on http://127.0.0.1:PORT, rebuilt per request")
    parser.add_argument("--doctor", action="store_true",
                        help="print only the verdict, the leaks and their fixes; exit 1 on leaks")
    args = parser.parse_args()

    if args.list_sources:
        for name, (root, files, _) in SOURCES.items():
            path = root()
            found = len(files()) if os.path.isdir(path) else 0
            print("  %-8s %-46s %s" % (
                name, path, "%d transcripts" % found if found else "not installed"))
        return 0

    if args.serve:
        return serve(args)
    report = build_report(args)
    if report is None:
        return 1
    if args.html:
        os.makedirs(os.path.dirname(os.path.abspath(args.html)), exist_ok=True)
        with open(args.html, "w") as fh:
            fh.write(render_html(report))
    if args.doctor:
        return print_doctor(report, args.html)
    print_text(report)
    if args.html:
        print("\nHTML report: %s" % os.path.abspath(args.html))
    return 0


def print_doctor(r, html_path):
    """The doctor verdict: each leak with its share and fix, then the baseline gaps."""
    issues = top_issues(r)
    print("TOKEN FURNACE: last %d days, %.0fM weighted tokens, %d sessions" % (
        r["days"], r["total"] / 1e6, r["session_count"]))
    for source, burn in r["burns"].items():
        goal, basis = burn_goal(r, source)
        print("Burn (%s): %.1fM in the last hour, goal %.1fM/h (%s)" % (
            source, burn["rate"] / 1e6, goal / 1e6, basis))
    for s in r["active"]:
        print("Active: %s (%s %s, %s) burning %.1fM/h (%.0f%% of the hour), context %dk, "
              "%d turns, %.0fh old, idle %.0fm%s" % (
            (s["title"] or "(untitled)")[:40], s["source"], s["id"], s["model"] or "?",
            s["rate"] / 1e6, s["rateShare"], s["context"] / 1000,
            s["turns"], s["hours"], s["idle"],
            "; " + ", ".join(f.split(":")[0] for f in s["flags"]) if s["flags"] else ""))
    if not issues:
        print("Verdict: healthy. No common token leaks in the last %d h." % CHECK_HOURS)
    else:
        print("Verdict: %d leak%s found in the last %d h, largest first.\n" % (
            len(issues), "" if len(issues) == 1 else "s", CHECK_HOURS))
    for n, issue in enumerate(issues, 1):
        where = ("%.0f%% of spend, %d sessions" % (issue["share"], len(issue["hits"]))
                 if issue["share"] is not None else "config")
        print("%d. [P%d] %s (%s)" % (n, issue["priority"], issue["title"], where))
        print("   Fix: %s" % issue["fix"])
        worst = sorted(issue["hits"], key=lambda h: -h[0]["share"])[:2]
        for s, flag in worst:
            print("   e.g. %s: %s" % ((s["title"] or s["id"])[:40], flag.split(".")[0]))
    print("\nBenchmark: the same turns at a %dk compaction window would cost about %.0fM "
          "(%.0f%% less). Estimate: trims cached context only." % (
              BENCH_WINDOW / 1000, r["bench_total"] / 1e6,
              100 * (1 - r["bench_total"] / r["total"])))
    gaps = [row for row in r["baseline"] if not row["ok"]]
    if gaps:
        print("\nBaseline gaps (last %d h -> recommended):" % CHECK_HOURS)
        for row in gaps:
            print("  %-8s %-28s %-18s %s" % (row["level"], row["name"], row["now_24h"], row["target"]))
    if html_path:
        print("\nReport: %s" % os.path.abspath(html_path))
        print("Open it and press \"Copy for Claude\" on a leak to hand over the fix with evidence.")
    return 1 if issues else 0


def severity(ratio):
    """Level of a value against an "under" target: ok up to the target, warn up to twice it."""
    return "ok" if ratio <= 1 else "warn" if ratio <= 2 else "critical"


def _provider_levers(src, p):
    """The lever rows for one source, from its per-source aggregates."""
    median = lambda xs: sorted(xs)[len(xs) // 2] if xs else None
    recent, stats, tot = p["recent"], p["stats7"], p["totals"]
    wakes = recent["wakes"]
    ping = lambda w: w["teammate"] + w["task"] + w["peer"]
    have = recent["turns"] > 0
    pct = lambda v: "%.0f%%" % v
    kilo = lambda v: "%dk" % (v / 1000)
    count = lambda v: "%.0f" % v
    hours = lambda v: "%.0fh" % v
    share = lambda a, b: 100 * a / b if b else None
    # (name, format, 24 h value, whole-window value, target text, limit, advisory)
    levers = [
        ("Spend on turns over 300k", pct, share(recent["over"], recent["total"]),
         p["over_300k"], "under 10%", 10, False),
        ("Median context per turn", kilo, median(recent["contexts"]), median(p["contexts"]) or 0,
         "under 150k", 150_000, False),
        ("Turns per human prompt", count, recent["turns"] / max(wakes["human"], 1) if have else None,
         p["turns"] / max(tot["human"], 1), "under 50", 50, False),
        ("Caller reads per tool call", pct, share(recent["reads"], recent["tool_calls"]) if have else None,
         share(tot["reads"], tot["tool_calls"]) or 0, "under 20%", 20, False),
        ("Wakeups per session", count,
         ping(wakes) / recent["sessions"] if recent["sessions"] else None,
         ping(tot) / max(p["session_count"], 1), "under 20", 20, False),
        ("Longest top session", hours, p["hours24"] or None, p["hours_all"],
         "under %dh" % LONG_LIVED_HOURS, LONG_LIVED_HOURS, False),
        ("Spend on the top model", pct, share(recent["top"], recent["total"]),
         share(stats["top"], p["total"]) or 0, "under 60%", 60, True),
    ]
    if stats["cache_input"]:
        levers.append(("Cache rebuilds", pct, share(recent["cache_write"], recent["cache_input"]),
                       share(stats["cache_write"], stats["cache_input"]), "under 10%", 10, False))
    if p["preamble"]:
        levers.append(("Preamble per session (p50)", kilo, median(recent["preambles"]),
                       p["preamble"][0], "under 40k", 40_000, False))
    rows = []
    for name, fmt, now, week, target, limit, advisory in levers:
        ratio = None if now is None else now / limit
        level = "ok" if ratio is None else severity(ratio)
        if advisory and level != "ok":
            level = "info"
        rows.append({"name": name, "now_24h": "-" if now is None else fmt(now),
                     "value_7d": fmt(week), "target": target, "ok": level == "ok",
                     "level": level, "ratio": ratio, "advisory": advisory, "source": src})
    return rows


def baseline(r):
    """Every lever per live provider over the last CHECK_HOURS and the whole window, against a
    recommended target, plus the per-agent config rows. Each row carries its `source`. The level
    judges the 24 h value; a lever with no 24 h data is ok."""
    live = [name for name, _ in r["sources"]]
    rows = []
    for src in live:
        p = r["per_source"].get(src)
        if p:
            rows += _provider_levers(src, p)
    for note in config_notes(live):
        rows.append({"name": note["name"], "now_24h": note["value"], "value_7d": None,
                     "target": note["target"], "ok": note["ok"], "level": note["level"],
                     "ratio": note["ratio"], "advisory": False, "source": note["source"]})
    return rows


def print_text(r):
    print("=== %d-day burn: %.0fM weighted tokens, %d sessions, %d turns ===" % (
        r["days"], r["total"] / 1e6, r["session_count"], r["turns"]))
    if len(r["sources"]) > 1:
        print("  " + "   ".join("%s %.0f%%" % s for s in r["sources"]))

    print("\nSPEND BY CONTEXT SIZE OF THE TURN   <- the main lever")
    for label, _, pct, turns in r["buckets"]:
        print("  %-12s %6.1f%%   %6d turns" % (label, pct, turns))
    print("  --> %.0f%% of spend is on turns carrying more than 300k of context"
          % r["over_300k"])

    if r["preamble"]:
        print("\nALWAYS-RESIDENT PREAMBLE (instructions, memory, skill catalog, tool schemas)")
        print("  p50=%dk  p90=%dk per session  ->  %.0f%% of every token read" % (
            r["preamble"][0] / 1000, r["preamble"][1] / 1000, r["preamble"][2]))
        print("  Prune it once, then leave it stable: reads bill at %.1fx but rewrites at %.2fx."
              % (CACHE_READ_RATE, CACHE_WRITE_RATE))

    print("\nTOP PROJECTS")
    for name, pct in r["projects"]:
        print("  %6.1f%%  %s" % (pct, name[-58:]))

    print("\nTOP SESSIONS (the long ones are where the budget goes)")
    for s in r["sessions"]:
        print("  %5.1f%%  turns=%-5d peak=%4.0fk  %4.1fh  %-6s %s %s  %s" % (
            s["share"], s["turns"], s["peak"] / 1000, s["hours"], s["source"],
            s["project"][-36:], s["id"], (s["title"] or "")[:50]))

    print("\nTOOL CALLS")
    for name, value in r["tools"]:
        print("  %-28s %d" % (name, value))

    print("\nLEAK CHECKS (top sessions of the last %d h; each flag names its fix)" % CHECK_HOURS)
    flagged = [s for s in r["recent_sessions"] if s["flags"]]
    for s in flagged:
        print("  %5.1f%%  %s %s  %s" % (s["share"], s["source"], s["id"], s["title"] or ""))
        for flag in s["flags"]:
            print("          - " + flag)
    if not flagged:
        print("  none")

    print("\nCONFIG CHECKS")
    for line in r["config"]:
        print("  - " + line)

    print("\nBASELINE (last %d h, %d-day value, recommended)" % (CHECK_HOURS, r["days"]))
    for row in r["baseline"]:
        print("  %-8s %-28s %-18s %-8s %s" % (row["level"], row["name"], row["now_24h"],
                                              row["value_7d"] or "", row["target"]))

    if r["unpriced"]:
        print("\nUNPRICED MODELS (counted at 1.0x -- %.0f%% of reported spend)" % r["unpriced"][0])
        for name, value in r["unpriced"][1]:
            print("  %-28s %d turns" % (name, value))
        print("  Add a ratio to MODEL_RATE to price these correctly.")


# Per leak flag prefix: short fix, title, why it costs tokens, and the prompt for an agent.
ISSUES = {
    "late compaction": (
        "Set autoCompactWindow to about 200000, then /compact or restart old sessions.",
        "Sessions compact too late",
        "Every tool call re-reads the whole context. A turn at 500k costs about 5 times a "
        "turn at 100k, and auto-compact on a 1M model waits until about 1M.",
        "Set \"autoCompactWindow\": 200000 in ~/.claude/settings.json and check that "
        "CLAUDE_CODE_AUTO_COMPACT_WINDOW is unset or not higher. Then ask me to /compact or "
        "restart each listed session that is still open."),
    "caller reads": (
        "Send multi-range reads, greps and log parsing to a cheap read-only subagent.",
        "The caller reads files and logs itself",
        "Each read in the main session is paid at its full context size. A cheap read-only "
        "subagent pays it at a small context and returns a short answer.",
        "Read the listed transcripts (JSONL, tool_use blocks named Bash/Read/Grep) and find the "
        "most repeated read commands. Then add a rule to my global agent instructions: after "
        "the brief, any read that is more than one bounded range goes to a cheap read-only "
        "subagent. Propose a helper script for any read pattern that repeats more than 20 times."),
    "wakeups": (
        "Ask subagents and teammates for one report at the end; wait with one blocking command.",
        "Too many wakeups",
        "Each teammate message, task notification or cross-session message starts a turn "
        "that re-reads the full context.",
        "Read the listed transcripts and find which subagents, teammates or background jobs "
        "sent the messages. Change their briefs so they report once at the end, and replace "
        "polling or progress pings with one blocking background command per wait."),
    "loop": (
        "Give each /goal or autonomous loop a stop condition and a turn or time budget.",
        "Autonomous loops run without a budget",
        "Hundreds of turns per human prompt means a /goal or autonomous loop kept going with "
        "no stop condition.",
        "Read the listed transcripts and name what kept each loop running. Then add a stop "
        "condition and a turn or time budget to the loop instructions I use (goal prompts, "
        "skills or CLAUDE.md)."),
    "long-lived": (
        "Commit, end the session, and start one fresh session per task.",
        "Sessions stay open too long",
        "A session open for many hours carries summaries of many unrelated tasks, so every "
        "turn pays for old work.",
        "List which of these sessions are still open. For each, commit its work, end it, and "
        "write a one-paragraph handoff so a fresh session can continue from the PRD or task."),
}

# Extra context appended to a fix prompt, drawn from Token Furnace's community research.
# Keyed by the issue kind (a flag prefix) or the config title.
ISSUE_EXTRA = {
    "late compaction": [
        "Anthropic supports earlier compaction: `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80`, or "
        "`/autocompact 200k` in a running session.",
        "To drop 1M context entirely: `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`.",
        "Codex: `model_auto_compact_token_limit = 160000` for a >=200K window.",
        "Do not compact blindly: compact or hand off between meaningful phases, not every N tokens.",
    ],
    "subagent fan-out cap": [
        "Claude Code defaults to 20 concurrent subagents and nesting depth 3, with no total cap.",
        "Also set the depth cap: `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` (Codex: "
        "`agents.max_depth`; note Multi-Agent V2 ignores it).",
        "Pin the worker model so it is not inherited silently: `CLAUDE_CODE_SUBAGENT_MODEL=sonnet` "
        "(add `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` to hard-enforce).",
        "Codex: prefer `fork_turns=\"none\"` for independent workers so they do not inherit the "
        "parent conversation history.",
    ],
    "subagent nesting depth": [
        "Nesting is the worst fan-out: a worker that spawns workers multiplies the whole loop.",
        "Claude: `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1`. Codex: `agents.max_depth` (Multi-Agent "
        "V2 ignores it, so verify the effective depth from real traces).",
    ],
    "subagent model": [
        "`CLAUDE_CODE_SUBAGENT_MODEL=sonnet` is a default, not a guarantee; add "
        "`CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` to hard-enforce (it overrides intentional "
        "per-agent specialization).",
        "Codex: set `agents.default_subagent_model` explicitly; V2 can silently run a costlier "
        "worker than requested.",
        "Verify the effective model from real usage, not from the instruction.",
    ],
    "subagent reasoning effort": [
        "Children mostly scan and summarize; keep them at low/medium and let the parent keep its "
        "own effort.",
    ],
    "auto-compact token limit": [
        "Codex: `model_auto_compact_token_limit = 160000` for a >=200K window.",
        "Compact or hand off between meaningful phases, not blindly every N tokens.",
    ],
    "tool-call concurrency": [
        "`CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY=4` bounds parallel tool calls in the main agent.",
        "Limit shell output at the byte level; a line-count cap fails when one line is huge.",
    ],
    "caller reads": [
        "Give a worker a self-contained brief (exact paths, objective, acceptance) instead of "
        "forking the whole parent history.",
        "Trim the always-resident preamble once, then leave it stable: reads bill at 0.1x but "
        "rewrites at 1.25x.",
    ],
    "wakeups": [
        "Ask teammates and background jobs for one report at the end, then wait once.",
    ],
    "loop": [
        "Give each worker agent a `maxTurns` ceiling (a 15-30 turn start for bounded tasks).",
        "On two identical failures, stop and re-plan instead of retrying.",
    ],
    "long-lived": [
        "Keep a concise task-state handoff (done / pending / current verification) so a fresh "
        "session does not repeat completed work after compaction.",
    ],
    "memory index too long": [
        "Move detail into topic files that load on demand; keep the index under the load limit.",
    ],
}


def config_source(line):
    """Which agent a config-check line belongs to, for the Checks source column."""
    if (CODEX_SUBAGENT_KEY in line or "max_depth" in line or "reasoning_effort" in line
            or "auto_compact_token_limit" in line or line.startswith("agents.")):
        return "codex"
    if "CLAUDE" in line or "autoCompactWindow" in line or "MEMORY.md" in line:
        return "claude"
    return "all"


def top_issues(r):
    """Group session flags and failed config checks into issues, largest spend share first."""
    groups = {}
    for s in r["recent_sessions"]:
        for flag in s["flags"]:
            groups.setdefault(flag.split(":")[0], []).append((s, flag))
    issues = []
    for kind, hits in groups.items():
        fix, title, why, action = ISSUES[kind]
        spies = collections.Counter(s["source"] for s, _ in hits)
        source = spies.most_common(1)[0][0] if len(spies) == 1 else "all"
        issues.append({"title": title, "why": why, "action": action, "fix": fix,
                       "kind": kind, "source": source,
                       "share": sum(s["share"] for s, _ in hits), "hits": hits})
    issues.sort(key=lambda i: -i["share"])
    fixed = [line for line in r["config"] if "autoCompactWindow" in line and line.endswith("ok.")]
    for issue in issues:
        if issue["title"] == ISSUES["late compaction"][1] and fixed:
            issue["fix"] = "Setting already ok. Restart or /compact the old sessions."
            issue["action"] = ("The setting is already fixed (%s). Restart or /compact the "
                               "listed sessions that are still open; new sessions are covered."
                               % fixed[0])
    for line in r["config"]:
        if line.endswith("ok.") or line == "none":
            continue
        if "autoCompactWindow" in line:
            title, fix = "autoCompactWindow", line
        elif "MEMORY.md" in line:
            title = "memory index too long"
            fix = ("Shorten MEMORY.md under %d lines; move detail into topic files."
                   % MEMORY_INDEX_LINES)
        elif "SUBAGENT_SPAWN_DEPTH" in line or "max_depth" in line:
            title = "subagent nesting depth"
            fix = ("Cap subagent nesting depth at %d: recursive delegation multiplies the loop."
                   % SUBAGENT_DEPTH)
        elif "SUBAGENT_MODEL" in line:
            title = "subagent model"
            fix = "Pin a cheap worker model so subagents do not inherit a premium one."
        elif SUBAGENT_ENV in line or CODEX_SUBAGENT_KEY in line:
            title = "subagent fan-out cap"
            fix = ("Cap concurrent subagents at %d: each one runs its own model and tool loop."
                   % SUBAGENT_CAP)
        elif "reasoning_effort" in line:
            title = "subagent reasoning effort"
            fix = "Set the subagent reasoning effort to low or medium."
        elif "auto_compact_token_limit" in line:
            title = "auto-compact token limit"
            fix = "Set model_auto_compact_token_limit to about 160000."
        elif "TOOL_USE_CONCURRENCY" in line:
            title = "tool-call concurrency"
            fix = "Cap parallel tool calls at %d." % TOOL_CONCURRENCY
        else:
            title, fix = line[:40], line
        issues.append({"title": "Config: " + title, "why": line, "fix": fix,
                       "action": "Fix this config problem: " + line, "share": None,
                       "kind": title, "source": config_source(line), "hits": []})
    for issue in issues:
        issue["priority"] = issue_priority(issue)
    issues.sort(key=lambda i: (i["priority"], -(i["share"] or 0)))
    return issues


def issue_priority(issue):
    """1 fix now, 2 fix this week, 3 when convenient. A one-line config fix behind a big leak is 1."""
    if issue["share"] is None:
        return 1 if "autoCompactWindow" in issue["title"] else 2
    return 1 if issue["share"] >= 20 else 2 if issue["share"] >= 5 else 3


def issue_prompt(issue, r):
    agent = {"claude": "Claude Code", "codex": "Codex",
             "all": "Claude Code and Codex"}.get(issue.get("source"), "the agent")
    lines = ["Token leak to fix: %s." % issue["title"], "Applies to: %s." % agent]
    if issue["share"] is not None:
        lines.append("It affects %d of my top sessions, %.0f%% of %s spend in the last "
                     "%d h (burn.py, base-input-equivalent tokens)."
                     % (len(issue["hits"]), issue["share"], agent, CHECK_HOURS))
    lines += ["", "Why it costs tokens: " + issue["why"]]
    if issue["hits"]:
        lines += ["", "Evidence:"]
        for s, flag in issue["hits"]:
            lines.append("- %s (session %s, %.1f%% of spend, %d turns, peak %dk, %.0fh): %s" % (
                s["title"] or "untitled", s["id"], s["share"], s["turns"], s["peak"] / 1000,
                s["hours"], flag))
            if s["path"]:
                lines.append("  transcript: %s" % s["path"])
    extra = ISSUE_EXTRA.get(issue.get("kind"))
    if extra:
        lines += ["", "Additional info:"] + ["- " + e for e in extra]
    lines += ["", "What to do: " + issue["action"],
              "", "Report what you changed and how to check that it worked."]
    return "\n".join(lines)


def report_view(r):
    """Everything dashboard.html draws, as JSON-ready data. The page owns all markup."""
    iso = lambda t: t.isoformat()
    issues = top_issues(r)
    actual = dict(r["timeline"])
    run_a = run_b = 0.0
    burndown = []
    for when, slot in r["hourly"]:
        run_a += sum(actual.get(when, (0, 0)))
        run_b += slot["bench"]
        burndown.append([iso(when + datetime.timedelta(hours=1)), run_a, run_b])
    blocks = collections.OrderedDict()
    for when, slot in r["hourly"]:
        b = blocks.setdefault(when.replace(hour=when.hour - when.hour % 3),
                              {"ctx": [], "reads": 0, "calls": 0})
        b["ctx"] += slot["ctx"]
        b["reads"] += slot["reads"]
        b["calls"] += slot["calls"]
    med = lambda xs: sorted(xs)[len(xs) // 2] if xs else 0
    kpis = [
        {"name": "Median context per turn", "unit": "k", "target": 150_000,
         "values": [med(b["ctx"]) for b in blocks.values()]},
        {"name": "Turns over 300k context", "unit": "%", "target": 0.10,
         "values": [sum(c >= 300_000 for c in b["ctx"]) / max(len(b["ctx"]), 1)
                    for b in blocks.values()]},
        {"name": "Caller reads per tool call", "unit": "%", "target": 0.20,
         "values": [b["reads"] / max(b["calls"], 1) for b in blocks.values()]},
    ]
    # Act now: what a live session needs this minute, before any leak report.
    actions = []
    for s in r["active"]:
        name = s["title"] or s["id"]
        if s["context"] >= LATE_COMPACT_PEAK:
            actions.append("Run /compact in “%s”: its context is %dk." % (
                name, s["context"] / 1000))
        elif s["hours"] >= LONG_LIVED_HOURS:
            actions.append("Finish “%s” and start a fresh session: it is %.0fh old." % (
                name, s["hours"]))
    burns = {}
    for source, burn in r["burns"].items():
        goal, basis = burn_goal(r, source)
        week = burn["week"]
        burns[source] = {"rate": burn["rate"], "goal": goal, "basis": basis,
                         "resets": iso(week["resets"]) if week else None,
                         "hoursLeft": week["hours_left"] if week else None,
                         "used": week["used"] if week else None,
                         "gains": week["gains"] if week else None,
                         "limit": week["limit"] if week else None,
                         "ratePct": week["rate_pct"] if week else None,
                         "idealPct": week["ideal_pct"] if week else None,
                         "start": iso(week["start"]) if week else None,
                         "weekBurndown": [[iso(t), a, b] for t, a, b in week["burndown"]]
                         if week else None,
                         "projection": {"ratePct": week["projection"]["rate_pct"],
                                        "hoursToEmpty": week["projection"]["hours_to_empty"],
                                        "runsOut": iso(week["projection"]["runs_out"])
                                        if week["projection"]["runs_out"] else None}
                         if week else None}
    return {
        "generated": iso(datetime.datetime.now(datetime.timezone.utc)), "days": r["days"],
        "total": r["total"], "sessions": r["session_count"], "turns": r["turns"],
        "over300k": r["over_300k"],
        "burns": burns,
        "burn": burns.get("claude") or next(iter(burns.values()), None),
        "actions": actions,
        "issues": [{"title": i["title"], "fix": i["fix"], "priority": i["priority"],
                    "level": LEVELS[i["priority"]], "source": i.get("source"),
                    "share": i["share"], "sessions": len(i["hits"]),
                    "prompt": issue_prompt(i, r)} for i in issues],
        "active": r["active"],
        "burndown": burndown, "benchWindow": BENCH_WINDOW,
        "budget": r["budget"], "kpis": kpis,
        "timeline": [[iso(t), cool, hot] for t, (cool, hot) in r["timeline"]],
        "checkHours": CHECK_HOURS,
        "baseline": r["baseline"],
        "topSessions": r["sessions"],
        "buckets": [{"label": l, "hot": low >= 300, "share": pct, "turns": n}
                    for l, low, pct, n in r["buckets"]],
        "projects": r["projects"], "config": r["config"], "tools": r["tools"],
        "unpriced": r["unpriced"],
    }


def render_html(r):
    """dashboard.html with the report embedded, for a static file or the first paint."""
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "dashboard.html")) as fh:
        page = fh.read()
    data = json.dumps(report_view(r), default=str).replace("</", "<\\/")
    return page.replace("/*REPORT*/null", data, 1)


if __name__ == "__main__":
    sys.exit(main())
