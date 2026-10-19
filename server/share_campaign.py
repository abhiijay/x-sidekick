#!/usr/bin/env python3
"""Give another person's sidekick a campaign (its ICP and message rules).

Run it here, on the device that already has the campaign:

  python3 share_campaign.py https://their-sidekick.ngrok-free.dev motion-video [supacite ...]

It asks for that sidekick's app password (typed, never saved), reads the
campaigns it already has, adds the ones named here (replacing older copies of
the same name and keeping all its others), and sends the list of LinkedIn
people already contacted from here, so their Find more never picks them.
It never sends leads, messages or anything else.
"""
import getpass
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))


def env_value(key):
    if os.environ.get(key):
        return os.environ[key]
    try:
        with open(os.path.join(HERE, ".env"), encoding="utf-8") as f:
            for line in f:
                if line.startswith(key + "="):
                    return line.split("=", 1)[1].strip()
    except OSError:
        pass
    return ""


def load(path, key):
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError):
        return None
    return d.get(key, d) if isinstance(d, dict) else d


def call(url, password, path, body=None):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url + path, data=data, method="POST" if data else "GET", headers={
        "X-Sidekick-Key": password, "ngrok-skip-browser-warning": "1",
        "Content-Type": "application/json", "User-Agent": "sidekick-share"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 401:
            sys.exit("That sidekick refused the password.")
        sys.exit("That sidekick answered %d. Is it running the latest code (sidekick-stop, sidekick-start)?" % e.code)
    except Exception as e:
        sys.exit("Could not reach %s (%s). Is it running?" % (url, type(e).__name__))


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    url = sys.argv[1].rstrip("/")
    names = sys.argv[2:]
    data_dir = env_value("SIDEKICK_DATA_DIR") or os.path.join(HERE, "data")
    mine = load(os.path.join(data_dir, "dm-campaigns.json"), "campaigns") or {}
    missing = [n for n in names if n not in mine]
    if missing:
        sys.exit("Not on this device: %s. Here: %s" % (", ".join(missing), ", ".join(sorted(mine))))

    password = getpass.getpass("App password of the sidekick at %s: " % url)
    theirs = call(url, password, "/api/sync/doc?name=campaigns").get("data") or {}
    theirs = theirs if isinstance(theirs, dict) else {}
    had = sorted(theirs)
    for n in names:
        theirs[n] = mine[n]

    # Everyone contacted from here, so their Find more leaves them alone.
    touched = set()
    t = load(os.path.join(data_dir, "dm-touched.json"), "touched") or {}
    touched.update("li:" + s for s in (t.get("linkedin") or []) if s)
    for l in load(os.path.join(data_dir, "dm-leads.json"), "leads") or []:
        m = re.search(r"linkedin\.com/in/([^/?#]+)", l.get("profile_url") or "")
        if m:
            touched.add("li:" + m.group(1).lower().rstrip("/"))

    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    out = call(url, password, "/api/sync/put", {
        "docs": {"campaigns": {"updated": stamp, "data": theirs}},
        "touched": sorted(touched)})
    took = (out.get("docs") or {}).get("campaigns")
    print("Campaigns there before: %s" % (", ".join(had) or "none"))
    print("Campaigns there now:    %s" % ", ".join(sorted(theirs)) if took else
          "It kept its own campaigns (its copy is newer). Nothing changed.")
    print("Already-contacted people sent: %d (%s new to it)" % (len(touched), out.get("touched", 0)))


if __name__ == "__main__":
    main()
