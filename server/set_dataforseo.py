#!/usr/bin/env python3
"""Add (or change) the DataForSEO login on this device's sidekick server.

The server needs it to put buyer questions to ChatGPT for Research and Write
with Claude. Run it in Termux on the phone (or on the Mac):

    git -C ~/x-sidekick pull && python ~/x-sidekick/server/set_dataforseo.py

It asks for the API login and API password (the password is not shown while
you type), checks them with DataForSEO, saves them to server/.env (readable
only by you) and restarts the sidekick. Nothing is printed or logged except
the account's balance.
"""
import base64, getpass, json, os, shutil, subprocess, sys, time, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ENV = os.path.join(HERE, ".env")
KEYS = ("DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD")


def check(login, password):
    """Returns (ok, message). One free call: the account's own user data."""
    req = urllib.request.Request("https://api.dataforseo.com/v3/appendix/user_data")
    req.add_header("Authorization", "Basic " + base64.b64encode(("%s:%s" % (login, password)).encode()).decode())
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return False, "DataForSEO said %s. Check the login and the API password (not your website password)." % e.code
    except (urllib.error.URLError, OSError) as e:
        return False, "Could not reach DataForSEO: %s" % e
    if data.get("status_code") != 20000:
        return False, "DataForSEO said: %s" % data.get("status_message")
    task = (data.get("tasks") or [{}])[0]
    res = (task.get("result") or [{}])[0] or {}
    money = (res.get("money") or {}).get("balance")
    return True, "Login works." + (" Balance: $%.2f" % money if isinstance(money, (int, float)) else "")


def save(login, password):
    lines = []
    if os.path.exists(ENV):
        with open(ENV, "r", encoding="utf-8") as f:
            lines = [l for l in f.read().splitlines() if not l.split("=", 1)[0].strip() in KEYS]
    lines += ["DATAFORSEO_LOGIN=" + login, "DATAFORSEO_PASSWORD=" + password]
    tmp = ENV + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, ENV)


def restart():
    if shutil.which("sidekick"):          # the phone's start command (Termux)
        print("Restarting the sidekick...")
        subprocess.run(["sidekick"])
        return True
    print("Restart the server yourself so it reads the new login (on the Mac: server/start.sh).")
    return False


def ask_is_on():
    pw = ""
    with open(ENV, "r", encoding="utf-8") as f:
        for l in f:
            if l.startswith("SIDEKICK_APP_PASSWORD="):
                pw = l.split("=", 1)[1].strip().strip('"').strip("'")
    req = urllib.request.Request("http://127.0.0.1:7790/api/health", headers={"X-Sidekick-Key": pw})
    for _ in range(10):
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return json.loads(r.read().decode("utf-8")).get("ask")
        except Exception:
            time.sleep(1)
    return None


def main():
    print("DataForSEO login for the sidekick (the API login and API password from")
    print("app.dataforseo.com -> API Access, not your website password).\n")
    login = input("API login (usually your email): ").strip()
    password = getpass.getpass("API password (hidden): ").strip()
    if not login or not password:
        sys.exit("Nothing saved: both are needed.")
    ok, msg = check(login, password)
    print(msg)
    if not ok:
        if input("Save it anyway? [y/N] ").strip().lower() != "y":
            sys.exit("Nothing saved.")
    save(login, password)
    print("Saved to %s (only you can read it)." % ENV)
    if restart():
        on = ask_is_on()
        print("ChatGPT check on the server: %s" % ("ON. Research and Write with Claude can ask ChatGPT now." if on
                                                   else "still off. Open ~/sidekick.log to see why." if on is False
                                                   else "could not check, the server did not answer."))


if __name__ == "__main__":
    main()
