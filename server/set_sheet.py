#!/usr/bin/env python3
"""Connect this device's sidekick to the lead sheet ("Beamcite Lead CRM").

Run it in Termux on the phone (or on the Mac):

    git -C ~/x-sidekick pull && python ~/x-sidekick/server/set_sheet.py

1. It makes a token (a long random password the sheet and this server share)
   and shows it, so you can paste it into the sheet's Apps Script.
2. You deploy the script as a web app and paste its URL back here.
3. It tests the connection, saves URL, token and this device's Sender code
   (a1, a2, k1 or k2) to server/.env (readable only by you), and restarts.
"""
import json, os, secrets, shutil, subprocess, sys, urllib.error, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ENV = os.path.join(HERE, ".env")
KEYS = ("SIDEKICK_SHEET_URL", "SIDEKICK_SHEET_TOKEN", "SIDEKICK_SHEET_SENDER", "SIDEKICK_ACCOUNT_STAGE")
CODE = "https://raw.githubusercontent.com/abhiijay/x-sidekick/main/sheet/Code.gs"


def read_env():
    out = {}
    if os.path.exists(ENV):
        with open(ENV, "r", encoding="utf-8") as f:
            for l in f:
                if "=" in l and not l.strip().startswith("#"):
                    k, v = l.rstrip("\n").split("=", 1)
                    out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def save(values):
    lines = []
    if os.path.exists(ENV):
        with open(ENV, "r", encoding="utf-8") as f:
            lines = [l for l in f.read().splitlines() if l.split("=", 1)[0].strip() not in values]
    lines += ["%s=%s" % (k, values[k]) for k in KEYS if k in values]
    tmp = ENV + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, ENV)


def test(url, token):
    try:
        with urllib.request.urlopen(url + "?" + urllib.parse.urlencode({"token": token}), timeout=60) as r:
            raw = r.read().decode("utf-8", "replace")
    except (urllib.error.URLError, OSError) as e:
        return False, "Could not reach it: %s" % e
    try:
        data = json.loads(raw)
    except ValueError:
        return False, ("It answered with a web page, not data. Check: Deploy > Manage deployments > the web app has "
                       "'Who has access: Anyone', and you copied the URL ending in /exec.")
    if data.get("error"):
        return False, "The sheet said: %s" % data["error"]
    return True, "Connected. The LinkedIn Outreach tab has %s rows." % data.get("rows")


def set_stage(stage):
    """`set_sheet.py --new-account` / `--established`: change only that."""
    save({"SIDEKICK_ACCOUNT_STAGE": stage})
    print("Saved: this LinkedIn account is %s." % stage)
    if stage == "new":
        print("Find more now leaves out big founders who rarely accept a new account.")
    if shutil.which("sidekick"):
        print("Restarting the sidekick...")
        subprocess.run(["sidekick"])
    else:
        print("Restart the server so it reads it (on the Mac: server/start.sh).")


def main():
    if "--new-account" in sys.argv or "--established" in sys.argv:
        return set_stage("new" if "--new-account" in sys.argv else "established")
    have = read_env()
    typed = input("Token you put in the sheet's TOKEN property (press Enter to make a new one): ").strip()
    token = typed or have.get("SIDEKICK_SHEET_TOKEN") or secrets.token_urlsafe(32)
    if len(token) < 16:
        sys.exit("That token is too short. Use at least 16 characters. Nothing saved.")
    print("STEP 1. In the sheet: Extensions > Apps Script.")
    print("  - Replace everything in Code.gs with the file at:")
    print("    " + CODE)
    print("  - Project Settings (gear) > Script properties > Add script property:")
    print("      Property: TOKEN")
    print("      Value:    " + token)
    print("  - Deploy > New deployment > type Web app > Execute as: Me, Who has access: Anyone > Deploy.")
    print("    (Already deployed? Deploy > Manage deployments > edit > Version: New version > Deploy.)")
    print("  - Copy the Web app URL (it ends in /exec).\n")
    url = input("STEP 2. Paste the web app URL here: ").strip()
    if not url.startswith("https://script.google.com/") or not url.rstrip("/").endswith("/exec"):
        sys.exit("That does not look like a web app URL (https://script.google.com/macros/s/.../exec). Nothing saved.")
    sender = (input("STEP 3. This device's Sender code [a1]: ").strip().lower() or "a1")
    if sender not in ("a1", "a2", "k1", "k2"):
        sys.exit("Sender must be a1, a2, k1 or k2. Nothing saved.")
    new = input("STEP 4. Is this LinkedIn account new (a few hundred connections or less)? [%s] "
                % ("Y/n" if sender == "a2" else "y/N")).strip().lower()
    stage = "new" if (new == "y" or (not new and sender == "a2")) else "established"
    ok, msg = test(url, token)
    print(msg)
    if not ok and input("Save it anyway? [y/N] ").strip().lower() != "y":
        sys.exit("Nothing saved.")
    save({"SIDEKICK_SHEET_URL": url, "SIDEKICK_SHEET_TOKEN": token, "SIDEKICK_SHEET_SENDER": sender,
          "SIDEKICK_ACCOUNT_STAGE": stage})
    print("Saved to %s (only you can read it)." % ENV)
    if shutil.which("sidekick"):
        print("Restarting the sidekick...")
        subprocess.run(["sidekick"])
    else:
        print("Restart the server so it reads the sheet settings (on the Mac: server/start.sh).")
    print("Find more > Spreadsheet now takes free people from the sheet and marks them %s. Third-party apps adds new people to the sheet as %s." % (sender, sender))


if __name__ == "__main__":
    main()
