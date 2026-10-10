#!/usr/bin/env python3
"""Retry circuit breaker as a PostToolUse hook.

Counts edits per file per session. When one file is edited past a threshold, the
agent is grinding at a capability level that is not solving the problem. The hook
tells it to ESCALATE -- hand the work to a more capable model or a deeper reasoning
pass, carrying what has already been tried -- rather than attempting another
variation at the same level.

It never blocks the edit and never tells the agent to abandon the task. A breaker
that stops work converts a token problem into an unfinished-work problem.

Install (Claude Code), in settings.json:

    "hooks": {
      "PostToolUse": [
        {
          "matcher": "Edit|Write|NotebookEdit",
          "hooks": [
            {"type": "command", "command": "<skill dir>/scripts/escalate-on-churn.py"}
          ]
        }
      ]
    }

Tune with the environment variables below, or edit the constants.
"""

import json
import os
import sys
import tempfile

# Edits to one file before the first nudge, then one nudge every EVERY edits after.
FIRST = int(os.environ.get("CHURN_FIRST", "4"))
EVERY = max(1, int(os.environ.get("CHURN_EVERY", "3")))

MESSAGE = (
    "CIRCUIT BREAKER: {name} has been edited {n} times this session.\n"
    "If the last two attempts failed for the same underlying reason, stop trying "
    "another variation at this level and ESCALATE:\n"
    "  1. State the assumption that must be wrong for these attempts to have failed.\n"
    "  2. Hand the problem to a more capable model or a higher-effort reasoning pass, "
    "or to a fresh deeper investigation pass.\n"
    "  3. Carry forward what was already tried and why each attempt failed, so the "
    "escalated pass does not repeat them.\n"
    "Keep working the task -- escalate the capability applied to it, do not abandon it."
)


def main() -> int:
    try:
        event = json.load(sys.stdin)
    except Exception:
        return 0  # never break the tool call on malformed input

    if event.get("tool_name") not in ("Edit", "Write", "NotebookEdit"):
        return 0

    path = (event.get("tool_input") or {}).get("file_path")
    if not path:
        return 0

    session = str(event.get("session_id", "none"))[:40].replace(os.sep, "_")
    statefile = os.path.join(tempfile.gettempdir(), "agent-churn-%s.json" % session)

    try:
        with open(statefile) as fh:
            state = json.load(fh)
        if not isinstance(state, dict):
            state = {}
    except Exception:
        state = {}

    count = state[path] = int(state.get(path, 0)) + 1
    try:
        with open(statefile, "w") as fh:
            json.dump(state, fh)
    except Exception:
        pass  # a lost counter is cheaper than a failed edit

    if count < FIRST or (count - FIRST) % EVERY:
        return 0

    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": MESSAGE.format(name=os.path.basename(path), n=count),
        }
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
