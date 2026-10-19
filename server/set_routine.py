#!/usr/bin/env python3
"""Turn on Claude's check (the x-sidekick routine) on this device.

  python server/set_routine.py

Find more, Write with Claude and the scout all hand their judgment to a Claude
Code routine. Without it Find more is off, because it would add people nobody
checked. Get both values from claude.ai/code/routines -> x-sidekick -> Edit ->
API trigger. They are saved only to server/.env on this device (mode 600).
"""
import os, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ENV = os.path.join(HERE, ".env")
KEYS = ("ROUTINE_FIRE_URL", "ROUTINE_TOKEN")


def save(values):
    lines = []
    if os.path.exists(ENV):
        with open(ENV, "r", encoding="utf-8") as f:
            lines = [l for l in f.read().splitlines() if l.split("=", 1)[0].strip() not in values]
    lines += ["%s=%s" % (k, values[k]) for k in KEYS]
    tmp = ENV + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, ENV)


def main():
    print(__doc__)
    url = input("Routine fire URL (https://api.anthropic.com/v1/claude_code/routines/trig_.../fire): ").strip()
    if not (url.startswith("https://api.anthropic.com/") and url.rstrip("/").endswith("/fire")):
        sys.exit("That does not look like a routine fire URL. Nothing saved.")
    import getpass
    token = getpass.getpass("Routine token (sk-ant-oat01-..., hidden as you type): ").strip()
    if not token.startswith("sk-ant-"):
        sys.exit("That does not look like a routine token. Nothing saved.")
    save({"ROUTINE_FIRE_URL": url, "ROUTINE_TOKEN": token})
    print("Saved to %s (only you can read it)." % ENV)
    if shutil.which("sidekick"):
        print("Restarting the sidekick...")
        subprocess.run(["sidekick"])
    else:
        print("Restart the server so it reads them (on the Mac: server/start.sh).")
    print("Find more now sends everyone it finds to Claude's check before they show up.")


if __name__ == "__main__":
    main()
