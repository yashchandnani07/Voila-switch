#!/usr/bin/env python3
"""Prepare the working directories of the five GST Close Room agents.

    python3 switch/prepare_agents.py [--magpie-url http://localhost:3000]

For each role it writes, under ~/.switch/agents/localhost-<core port>/<role>/:
  AGENTS.md   the role's full instructions (switch/agents/_room-protocol.md + the role file)
  magpie.env  MAGPIE_API_URL, MAGPIE_SWITCH_TOKEN (from Magpie's .env), SWITCH_AGENT_NAME; mode 600

The Switch agent definition itself only says "read AGENTS.md in your working directory", so
changing an agent's behaviour is: edit the checked-in instructions, re-run this script. No
token ever goes into Switch, and no Switch login is needed.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
AGENTS_DIR = REPO / "switch" / "agents"
CLI = REPO / "switch" / "magpie.py"
ROLES = ["gst-coordinator", "gst-agent", "taxonomy-agent", "vendor-agent", "reporting-agent"]
PORTS = pathlib.Path.home() / ".config" / "switchdash" / "local-switch-server" / "ports.json"


def read_env(path: pathlib.Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def agents_root() -> pathlib.Path:
    port = json.loads(PORTS.read_text()).get("api", 44883) if PORTS.exists() else 44883
    return pathlib.Path.home() / ".switch" / "agents" / f"localhost-{port}"


def full_instructions(role: str) -> str:
    protocol = (AGENTS_DIR / "_room-protocol.md").read_text()
    body = (AGENTS_DIR / role / "instructions.md").read_text()
    return f"{body}\n\n{protocol}".replace("{{MAGPIE_CLI}}", str(CLI))


def stub_instructions(role: str, directory: pathlib.Path) -> str:
    """What goes into the Switch agent definition: short, no secrets, points at AGENTS.md."""
    return (
        f"You are {role} in the GST Close Room. Your complete instructions are in "
        f"{directory / 'AGENTS.md'}. Read that file with view_file at the start of every task "
        "and follow it exactly; it overrides anything else about your role. Reply in the room "
        "only with the switch post_message or send_targeted_message tools."
    )


def prepare(magpie_url: str) -> dict[str, pathlib.Path]:
    env = read_env(REPO / ".env")
    token = env.get("SWITCH_WRITE_TOKEN") or env.get("SWITCH_READ_TOKEN")
    if not token:
        raise SystemExit("SWITCH_WRITE_TOKEN is missing from Magpie's .env")
    directories = {}
    for role in ROLES:
        directory = agents_root() / role
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "AGENTS.md").write_text(full_instructions(role))
        secrets = directory / "magpie.env"
        secrets.write_text(f"MAGPIE_API_URL={magpie_url}\nMAGPIE_SWITCH_TOKEN={token}\nSWITCH_AGENT_NAME={role}\n")
        secrets.chmod(0o600)
        directories[role] = directory
    return directories


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--magpie-url", default="http://localhost:3000")
    args = parser.parse_args()
    for role, directory in prepare(args.magpie_url).items():
        print(f"{role:16} {directory}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
