"""Self-check for burn.py leak detection. Run: python3 test_burn.py"""

import datetime
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))


def record(kind, when, **extra):
    return json.dumps({"type": kind, "timestamp": when.isoformat(), **extra})


def assistant(when, context, calls=(), write=0):
    content = [{"type": "tool_use", "name": n, "input": {"command": c}} for n, c in calls]
    usage = {"input_tokens": 10, "cache_read_input_tokens": context,
             "cache_creation_input_tokens": write, "output_tokens": 50}
    return record("assistant", when, message={"model": "claude-opus-5-5", "usage": usage,
                                              "content": content})


def user(when, text):
    return record("user", when, message={"content": text})


def run(config_dir, env_extra=None, days="2"):
    env = dict(os.environ, CLAUDE_CONFIG_DIR=config_dir, XDG_CACHE_HOME=config_dir)
    for key in ("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS",
                "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH", "CLAUDE_CODE_SUBAGENT_MODEL",
                "CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY"):
        env.pop(key, None)
    env.update(env_extra or {})
    return subprocess.run([sys.executable, os.path.join(HERE, "burn.py"), days,
                           "--source", "claude", "--html",
                           os.path.join(config_dir, "report.html")], env=env, capture_output=True,
                          text=True, check=True).stdout


def check_last_24h():
    """An old peak-900k session must not flag or fail the checks once a recent one is healthy."""
    now = datetime.datetime.now(datetime.timezone.utc)
    with tempfile.TemporaryDirectory() as root:
        project = os.path.join(root, "projects", "demo")
        os.makedirs(project)
        for name, age, context in (("old", datetime.timedelta(days=3), 900_000),
                                   ("new", datetime.timedelta(hours=2), 100_000)):
            # The recent session writes cache every turn and jumps 100k once (a pasted dump).
            lines = [user(now - age, "go")] + [
                assistant(now - age + datetime.timedelta(seconds=i * 60),
                          context + (100_000 if name == "new" and i >= 10 else 0),
                          write=20_000 if name == "new" else 0)
                for i in range(20)]
            with open(os.path.join(project, name + "-session.jsonl"), "w") as fh:
                fh.write("\n".join(lines) + "\n")
        out = run(root, days="7")
        assert "late compaction" not in out, out
        with open(os.path.join(root, "report.html")) as fh:
            page = fh.read()
        data = json.loads(page[page.index("window.__REPORT__ = ") + 20:page.index("</script>",
                                                                              page.index("window.__REPORT__"))])
        row = next(b for b in data["baseline"] if b["name"].startswith("Spend on turns"))
        assert row["ok"] and row["now_24h"] == "0%" and row["value_7d"] != "0%", row
        by = {b["name"]: b for b in data["baseline"]}
        assert by["Cache rebuilds"]["level"] == "warn", by["Cache rebuilds"]  # ~14% against 10%
        top = by["Spend on the top model"]  # advisory: opus only, so never worse than info
        assert top["advisory"] and top["level"] == "info" and not top["ok"], top
        assert not any("compact too late" in i["title"] for i in data["issues"])


def check_severity():
    sys.path.insert(0, HERE)
    import burn
    assert [burn.severity(x) for x in (0.9, 1.0, 1.5, 2.0, 3)] == [
        "ok", "ok", "warn", "warn", "critical"]


def check_weekly_quota():
    """With a weekly reading: %/h matches tokens/h, and the weekly burndown ends at the reading."""
    import time
    now = datetime.datetime.now(datetime.timezone.utc)
    with tempfile.TemporaryDirectory() as root:
        project = os.path.join(root, "projects", "demo")
        os.makedirs(project)
        cache = os.path.join(root, "token-furnace")
        os.makedirs(cache)
        with open(os.path.join(cache, "usage.json"), "w") as fh:
            json.dump({"fetched": time.time(), "seven_day": {
                "utilization": 40, "resets_at": time.time() + 3 * 86400}}, fh)
        whens = ([now - datetime.timedelta(hours=30) + datetime.timedelta(minutes=10 * i)
                  for i in range(150)]
                 + [now - datetime.timedelta(minutes=30 - 5 * i) for i in range(5)])
        with open(os.path.join(project, "s-week.jsonl"), "w") as fh:
            fh.write("\n".join(assistant(w, 200_000) for w in whens) + "\n")
        run(root, days="7")
        with open(os.path.join(root, "report.html")) as fh:
            page = fh.read()
        start = page.index("window.__REPORT__ = ") + 20
        data = json.loads(page[start:page.index("</script>", start)].replace("<\\/", "</"))
        burn = data["burns"]["claude"]
        assert burn["rate"] > 0 and abs(burn["ratePct"] * burn["limit"] / 100 - burn["rate"]) < 1e-6 * burn["rate"], burn
        points = burn["weekBurndown"]
        assert abs(points[-1][1] - burn["used"]) < 0.5, (points[-1], burn["used"])
        assert points[0][1] == 0 and all(a[1] <= b[1] and a[0] <= b[0] for a, b in zip(points, points[1:]))
        assert points[-1][2] <= points[-1][1]
        assert burn["projection"]["ratePct"] > 0
        # One run-out for tile and chart: points left at the 24 h pace.
        proj = burn["projection"]
        assert abs(proj["hoursToEmpty"] * proj["ratePct"] - (100 - burn["used"])) < 1e-6, proj


def check_config_notes():
    """Config readers pull from Claude settings/.env and Codex config.toml, judged per agent."""
    sys.path.insert(0, HERE)
    import burn
    for k in ("CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS", "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH",
              "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY"):
        os.environ.pop(k, None)
    with tempfile.TemporaryDirectory() as home:
        settings = os.path.join(home, "settings.json")
        os.environ["CLAUDE_CONFIG_DIR"] = home
        os.environ["CODEX_HOME"] = home
        with open(settings, "w") as fh:
            json.dump({}, fh)
        assert burn.claude_subagent_cap(settings) == (None, None)
        with open(settings, "w") as fh:
            json.dump({"env": {burn.SUBAGENT_ENV: "3"}}, fh)
        assert burn.claude_subagent_cap(settings) == (3, "settings")
        with open(settings, "w") as fh:  # over the cap
            json.dump({"env": {burn.SUBAGENT_ENV: "20"}}, fh)
        notes = {n["name"]: n for n in burn.config_notes(["claude"])}
        assert notes["Max concurrent subagents"]["value"] == "20"
        assert not notes["Max concurrent subagents"]["ok"]
        assert not notes["Subagent model"]["ok"]  # unset
        assert all(n["source"] == "claude" for n in burn.config_notes(["claude"]))
        # Codex config.toml, under [agents] or as a dotted key.
        toml = os.path.join(home, "config.toml")
        for text, want in (("[agents]\nmax_concurrent_threads_per_session = 5\n", 5),
                           ("agents.max_concurrent_threads_per_session = 2\n", 2)):
            with open(toml, "w") as fh:
                fh.write(text)
            assert burn.codex_subagent_cap(toml)[0] == want
        with open(toml, "w") as fh:
            fh.write("[agents]\nmax_concurrent_threads_per_session = 3\nmax_depth = 1\n"
                     "default_subagent_reasoning_effort = \"low\"\n"
                     "model_auto_compact_token_limit = 160000\n")
        codex = {n["name"]: n for n in burn.config_notes(["codex"])}
        assert all(n["source"] == "codex" for n in burn.config_notes(["codex"]))
        assert codex["Max concurrent subagents"]["value"] == "3" and codex["Max concurrent subagents"]["ok"]
        assert codex["Agent nesting depth"]["ok"] and codex["Subagent reasoning effort"]["ok"]
        assert codex["Auto-compact token limit"]["ok"]
        os.environ.pop("CLAUDE_CONFIG_DIR", None)
        os.environ.pop("CODEX_HOME", None)


def main():
    now = datetime.datetime.now(datetime.timezone.utc)
    with tempfile.TemporaryDirectory() as root:
        project = os.path.join(root, "projects", "demo")
        os.makedirs(os.path.join(project, "memory"))
        with open(os.path.join(project, "memory", "MEMORY.md"), "w") as fh:
            fh.write("- line\n" * 250)

        lines = [user(now - datetime.timedelta(hours=13), "fix the bug")]
        for i in range(300):
            when = now - datetime.timedelta(hours=13) + datetime.timedelta(seconds=i * 150)
            if i % 5 == 0:
                lines.append(user(when, "<task-notification>done</task-notification>"))
            lines.append(assistant(when, 400_000, [("Bash", "cd /x && sed -n 1,9p f")]))
        with open(os.path.join(project, "aaaaaaaa-leak.jsonl"), "w") as fh:
            fh.write("\n".join(lines) + "\n")

        out = run(root)
        for expected in ("late compaction: peak 400k", "caller reads: 300",
                         "wakeups: 60 (teammate 0, task 60", "loop: 300 turns for 1 human",
                         "long-lived: 12h", "autoCompactWindow is unset",
                         "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS is unset",
                         "has 250 lines"):
            assert expected in out, "missing %r in:\n%s" % (expected, out)
        with open(os.path.join(root, "report.html")) as fh:
            page = fh.read()
        assert "<title>Token Furnace</title>" in page
        prefix = "window.__REPORT__ = "
        suffix = "</script>"
        start = page.index(prefix) + len(prefix)
        end = page.index(suffix, start)
        json_part = page[start:end]
        assert "</script" not in json_part
        report_data = json.loads(json_part.replace("<\\/", "</"))
        assert report_data["issues"]
        assert "caller reads: 300" in json.dumps(report_data)
        assert any("compact too late" in issue["title"] for issue in report_data["issues"])
        assert all(1 <= issue["priority"] <= 3 for issue in report_data["issues"])
        assert [issue["priority"] for issue in report_data["issues"]] == sorted(
            issue["priority"] for issue in report_data["issues"]
        )
        assert any("transcript: " in issue.get("prompt", "") for issue in report_data["issues"])
        # Every issue and check names its agent, and the fix prompt carries the extra context.
        assert all(i.get("source") in ("claude", "codex", "all")
                   for i in report_data["issues"]), report_data["issues"]
        assert all(b.get("source") for b in report_data["baseline"]), report_data["baseline"]
        sub = next(i for i in report_data["issues"] if i["title"] == "Config: subagent fan-out cap")
        assert sub["source"] == "claude" and "Applies to: Claude Code." in sub["prompt"]
        assert "Additional info:" in sub["prompt"]
        assert "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH" in sub["prompt"]
        assert "2-day average" in report_data["burn"]["basis"]
        assert isinstance(report_data["active"], list)
        assert report_data["burndown"]
        assert report_data["kpis"]
        assert report_data["timeline"]
        assert report_data["baseline"]

        doctor_env = dict(os.environ, CLAUDE_CONFIG_DIR=root,
                          XDG_CACHE_HOME=root, TOKEN_FURNACE_PORT="0")
        for key in ("CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS", "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH",
                    "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY"):
            doctor_env.pop(key, None)
        doctor = subprocess.run([os.path.join(HERE, "doctor"), "2", "--source", "claude"],
                                env=doctor_env, capture_output=True, text=True)
        assert doctor.returncode == 1, doctor.stdout + doctor.stderr
        assert "Verdict: 11 leaks found" in doctor.stdout, doctor.stdout
        assert os.path.exists(os.path.join(root, "token-furnace", "report.html"))

        with open(os.path.join(root, "settings.json"), "w") as fh:
            json.dump({"autoCompactWindow": 200000}, fh)
        assert "autoCompactWindow is 200k (from settings): ok." in run(root)
        assert "autoCompactWindow is 800k (from env)" in run(
            root, {"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "800k"})
    print("test_burn: ok")


def check_codex_week():
    """Codex's weekly window comes from the rate_limits it logs; a finished week is ignored."""
    sys.path.insert(0, HERE)
    import burn
    now = datetime.datetime.now(datetime.timezone.utc).timestamp()
    with tempfile.TemporaryDirectory() as home:
        path = os.path.join(home, "sessions", "2026", "rollout-x.jsonl")
        os.makedirs(os.path.dirname(path))
        os.environ["CODEX_HOME"] = home
        for resets, expected in ((now + 3600, 40.0), (now - 3600, None)):
            limits = {"primary": {"used_percent": 9, "window_minutes": 300, "resets_at": now},
                      "secondary": {"used_percent": 40, "window_minutes": 10080, "resets_at": resets}}
            with open(path, "w") as fh:
                fh.write(json.dumps({"type": "event_msg", "payload": {"rate_limits": limits}}) + "\n")
            week = burn.codex_week()
            assert (week and week["used"]) == expected, week
        del os.environ["CODEX_HOME"]


if __name__ == "__main__":
    main()
    check_severity()
    check_last_24h()
    check_weekly_quota()
    check_codex_week()
    check_config_notes()
