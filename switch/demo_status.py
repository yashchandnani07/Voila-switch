#!/usr/bin/env python3
"""One-screen health check for the GST Close Room demo.

    python3 switch/demo_status.py [--period 2026-10] [--watch]

Shows: Magpie reachable, the period's funnel and workflow state, the five agents as Switch's
agent controller sees them (running / failed), and the last Magpie writes per agent. Reads the
controller's local SQLite file read-only; needs no Switch login and prints no secrets.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sqlite3
import subprocess
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent
ROLES = ["gst-coordinator", "gst-agent", "taxonomy-agent", "vendor-agent", "reporting-agent"]
CONTROLLERS = pathlib.Path.home() / ".config" / "switchdash" / "agent-controller" / "servers"


def controller_agents() -> dict[str, dict]:
    result: dict[str, dict] = {}
    for db in CONTROLLERS.glob("*/controller.db"):
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        body = json.loads(con.execute("select body from assignment").fetchone()[0])
        applied = {row[0]: row for row in con.execute("select agent_id, applied_revision, failure_reason from agents")}
        for agent in body["agents"]:
            row = applied.get(agent["agent_id"])
            result[agent["definition"]["name"]] = {
                "desired": agent["desired_state"],
                "applied": row is not None and row[1] == agent["revision"],
                "failure": row[2] if row else None,
            }
    return result


def magpie(*args: str) -> str:
    env_dir = pathlib.Path.home() / ".switch" / "agents" / "localhost-44883" / "gst-coordinator"
    return subprocess.run(
        [sys.executable, str(HERE / "magpie.py"), *args],
        cwd=env_dir, capture_output=True, text=True, timeout=30,
    ).stdout


def render(period: str) -> str:
    out = [f"GST Close Room demo status  ({time.strftime('%H:%M:%S')})", ""]
    agents = controller_agents()
    out.append("Agents (Switch agent controller):")
    for role in ROLES:
        info = agents.get(role)
        if not info:
            out.append(f"  ✗ {role:16} missing: create it (see switch/BUDDY-SETUP.md)")
        elif info["failure"]:
            out.append(f"  ✗ {role:16} FAILED: {info['failure']}")
        elif info["desired"] == "running" and info["applied"]:
            out.append(f"  ✓ {role:16} running")
        else:
            out.append(f"  … {role:16} {info['desired']} (applying)")
    out.append("")
    status = magpie("status", "--period", period)
    out.append("Magpie:" if status else "Magpie: UNREACHABLE (is `bun run dev` running?)")
    for line in status.splitlines()[:14]:
        out.append("  " + line)
    out.append("")
    out.append("Latest writes:")
    for line in magpie("events", "--period", period, "--limit", "8").splitlines()[1:9]:
        out.append("  " + line[:150])
    return "\n".join(out)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--period", default="2026-10")
    parser.add_argument("--watch", action="store_true", help="refresh every 4 seconds")
    args = parser.parse_args()
    while True:
        text = render(args.period)
        if args.watch:
            print("\033[2J\033[H", end="")
        print(text)
        if not args.watch:
            return 0
        time.sleep(4)


if __name__ == "__main__":
    sys.exit(main())
