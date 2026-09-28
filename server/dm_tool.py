#!/usr/bin/env python3
"""Load DM outreach batches into the sidekick, and read the results back.

The phone app's LinkedIn and X DM tabs read dm-leads.json from the sidekick data
dir. Nothing else writes new leads there: Claude (in Cowork) builds a batch file
and runs this. It never sends a message; it only edits JSON files.

  python3 dm_tool.py [--data DIR] load BATCH.json [--allow-repeat] [--dry-run]
  python3 dm_tool.py [--data DIR] library LIBRARY.json
  python3 dm_tool.py [--data DIR] export [--since YYYY-MM-DD] [--channel x|linkedin]
                                         [--campaign NAME] [--json]
  python3 dm_tool.py [--data DIR] status
  python3 dm_tool.py [--data DIR] retire --batch "LABEL" [--dry-run]
  python3 dm_tool.py [--data DIR] campaign CAMPAIGN.json      rules for Find more + Write with Claude
  python3 dm_tool.py [--data DIR] touched TOUCHED.json        people already contacted (merge)

DIR defaults to $SIDEKICK_DATA_DIR, then SIDEKICK_DATA_DIR in server/.env, then
server/data. From the Cowork sandbox, pass --data with the sandbox path of the
same folder (the Mac path in .env does not exist there).

BATCH.json is {"libraries": {...optional...}, "leads": [...]} or a bare list.
One lead:

  id           stable, unique across batches, e.g. "li-mv-b2-chilarai"   (required)
  channel      "linkedin" | "x"                                          (required)
  campaign     e.g. "motion-video", "beamcite"                           (required)
  batch        label shown on the card, e.g. "LinkedIn batch 2"
  n            position in the batch (sort order)
  name         display name (LinkedIn) or first name (X)
  handle       X handle without @ (required for x)
  recipient_id X numeric user id, opens the DM compose screen directly
  profile_url  LinkedIn profile link (required for linkedin)
  product, followers (number), meta (one short line), flag (warning), drop (true = not advised)
  variants     [{"label": "Video pitch", "text": "..."}, ...]   written messages; Shuffle cycles them
  library      id of a line library (X); the phone composes hook + proof + CTA from it
  fields       {"n": first name, "p": product, "plat": where found, "q": buyer query, "cat": category}
  note         anything the sender should know
  kind         "message" (default) or "connect" (LinkedIn: a profile to send a connection request to)
  needs_message  true = no message yet; "Write with Claude" on the phone drafts one
  context      facts for the writer (what they do, how we can help, prior contact)
  headline, site, tagline, tier, score, icp, source, launch   shown on the card / sent to the writer
  status       usually omitted (ready). For history: requested (+requested_ts), sent (+sent_ts,
               sent_text), replied (+reply_text), skipped / cant_dm (+skip_reason)

A message lead needs variants, a library, or needs_message. Leads already in the file keep their status;
a lead still waiting to be sent gets its content refreshed. A person already
messaged on the same channel is never loaded again unless --allow-repeat.
"""
import argparse
import json
import os
import re
import sys
import time
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
CHANNELS = ("linkedin", "x")
STATUSES = ("ready", "sent", "replied", "skipped", "cant_dm", "requested")
CONTENT_FIELDS = ("campaign", "batch", "n", "name", "handle", "recipient_id", "profile_url",
                  "product", "followers", "meta", "flag", "drop", "variants", "library",
                  "fields", "note", "kind", "headline", "site", "tagline", "tier", "score",
                  "icp", "context", "needs_message", "source", "launch")
# Carried over only when a lead is first added (history from before the app).
HISTORY_FIELDS = ("sent_ts", "sent_text", "reply_text", "reply_ts", "requested_ts",
                  "accepted_ts", "skip_reason")
ID_RE = re.compile(r"^[A-Za-z0-9_.:\-]{1,80}$")


# ---------------------------------------------------------------- files

def data_dir(arg):
    if arg:
        return arg
    if os.environ.get("SIDEKICK_DATA_DIR"):
        return os.environ["SIDEKICK_DATA_DIR"]
    env_file = os.path.join(HERE, ".env")
    if os.path.exists(env_file):
        with open(env_file, encoding="utf-8") as f:
            for line in f:
                if line.strip().startswith("SIDEKICK_DATA_DIR="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    return os.path.join(HERE, "data")


def now_str():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def load(path, key, default):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return data.get(key, default) if isinstance(data, dict) else data


def save(path, key, value):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"updated": now_str(), key: value}, f, indent=1, ensure_ascii=False)
    os.replace(tmp, path)


def mtime(path):
    try:
        return os.stat(path).st_mtime_ns
    except OSError:
        return None


def write_leads(ddir, change):
    """Read-modify-write dm-leads.json, redoing the change if the server wrote
    the file in between (it may be saving a tap from the phone)."""
    path = os.path.join(ddir, "dm-leads.json")
    for _ in range(5):
        before = mtime(path)
        leads = load(path, "leads", [])
        result = change(leads)
        if result is None:
            return None
        if mtime(path) == before:
            save(path, "leads", leads)
            return result
        time.sleep(0.2)
    sys.exit("dm-leads.json kept changing while writing; try again in a moment")


# ---------------------------------------------------------------- checks

def person_key(lead):
    if lead.get("channel") == "x":
        return "x:" + str(lead.get("handle") or "").lstrip("@").lower()
    m = re.search(r"linkedin\.com/in/([^/?#\s]+)", str(lead.get("profile_url") or ""), re.I)
    return "linkedin:" + (m.group(1).lower() if m else str(lead.get("name") or "").lower())


def check_library(lib_id, lib):
    errs = []
    for part in ("hooks", "proofs", "ctas"):
        if not isinstance(lib.get(part), dict) or not lib[part]:
            errs.append("%s: '%s' must be a non-empty object" % (lib_id, part))
            continue
        for k, v in lib[part].items():
            if not isinstance(v, dict) or not str(v.get("t") or "").strip():
                errs.append("%s: %s.%s has no text (t)" % (lib_id, part, k))
    if errs:
        return errs
    for k, h in lib["hooks"].items():
        for p in h.get("proofs") or []:
            if p not in lib["proofs"]:
                errs.append("%s: hook %s points at unknown proof %s" % (lib_id, k, p))
        for c in h.get("ctas") or []:
            if c not in lib["ctas"]:
                errs.append("%s: hook %s points at unknown CTA %s" % (lib_id, k, c))
    for k, p in lib["proofs"].items():
        for c in p.get("ctas") or []:
            if c not in lib["ctas"]:
                errs.append("%s: proof %s points at unknown CTA %s" % (lib_id, k, c))
    return errs


def check_lead(lead, libraries):
    errs = []
    lid = str(lead.get("id") or "")
    tag = lid or "(no id)"
    if not ID_RE.match(lid):
        errs.append("%s: id must be 1-80 of A-Z a-z 0-9 _ . : -" % tag)
    if lead.get("channel") not in CHANNELS:
        errs.append("%s: channel must be linkedin or x" % tag)
    if not str(lead.get("campaign") or "").strip():
        errs.append("%s: campaign is required" % tag)
    if lead.get("channel") == "x" and not re.fullmatch(r"@?[A-Za-z0-9_]{1,50}", str(lead.get("handle") or "")):
        errs.append("%s: X leads need a valid handle" % tag)
    if lead.get("channel") == "linkedin" and "linkedin.com/in/" not in str(lead.get("profile_url") or ""):
        errs.append("%s: LinkedIn leads need a linkedin.com/in/ profile_url" % tag)
    kind = lead.get("kind") or "message"
    if kind not in ("message", "connect"):
        errs.append("%s: kind must be message or connect" % tag)
    if kind == "connect" and lead.get("channel") != "linkedin":
        errs.append("%s: connect leads are LinkedIn only" % tag)
    if lead.get("status") == "requested" and kind != "connect":
        errs.append("%s: only connect leads can be requested" % tag)
    variants = lead.get("variants")
    if variants is not None:
        if not isinstance(variants, list) or not all(
                isinstance(v, dict) and str(v.get("text") or "").strip() for v in variants):
            errs.append("%s: variants must be a list of {label, text}" % tag)
    if (kind == "message" and lead.get("status", "ready") == "ready" and not variants
            and not lead.get("library") and not lead.get("needs_message")):
        errs.append("%s: needs variants, a library, or needs_message: true" % tag)
    if lead.get("library") and not variants and lead["library"] not in libraries:
        errs.append("%s: library %s is not loaded" % (tag, lead["library"]))
    if lead.get("status", "ready") not in STATUSES:
        errs.append("%s: status must be one of %s" % (tag, ", ".join(STATUSES)))
    return errs


def warnings_for(lead):
    """Rule reminders, printed so they get flagged before the batch goes out."""
    out = []
    texts = [v.get("text", "") for v in lead.get("variants") or []]
    if lead.get("channel") == "x":
        if any(re.search(r"https?://|www\.|beamcite\s*\.?\s*com", t, re.I) for t in texts):
            out.append("link in an X first message (X spam rule: no link in message one)")
        if (lead.get("followers") or 0) >= 2000:
            out.append("%s followers, outside the <2k green zone" % lead.get("followers"))
    return out


# ---------------------------------------------------------------- commands

def cmd_library(args):
    ddir = data_dir(args.data)
    with open(args.file, encoding="utf-8") as f:
        lib = json.load(f)
    lib_id = lib.get("id")
    if not lib_id:
        sys.exit("library needs an id")
    errs = check_library(lib_id, lib)
    if errs:
        sys.exit("\n".join(errs))
    path = os.path.join(ddir, "dm-libraries.json")
    libs = load(path, "libraries", {})
    libs[lib_id] = lib
    save(path, "libraries", libs)
    print("library %s saved (%d hooks, %d proofs, %d CTAs)" % (
        lib_id, len(lib["hooks"]), len(lib["proofs"]), len(lib["ctas"])))


def cmd_load(args):
    ddir = data_dir(args.data)
    if not os.path.isdir(ddir):
        sys.exit("data dir not found: %s" % ddir)
    with open(args.file, encoding="utf-8") as f:
        batch = json.load(f)
    incoming = batch if isinstance(batch, list) else batch.get("leads") or []
    new_libs = {} if isinstance(batch, list) else (batch.get("libraries") or {})

    libs_path = os.path.join(ddir, "dm-libraries.json")
    libs = load(libs_path, "libraries", {})
    errs = []
    for lib_id, lib in new_libs.items():
        errs += check_library(lib_id, lib)
    known_libs = dict(libs, **new_libs)
    seen_ids = set()
    for lead in incoming:
        errs += check_lead(lead, known_libs)
        if lead.get("id") in seen_ids:
            errs.append("%s: id appears twice in this file" % lead.get("id"))
        seen_ids.add(lead.get("id"))
    if errs:
        sys.exit("Nothing loaded. Fix these first:\n  " + "\n  ".join(errs))

    report = {"added": [], "refreshed": [], "kept": [], "repeat": [], "dupe": [], "warn": []}

    def merge(leads):
        by_id = {l.get("id"): l for l in leads}
        contacted = {person_key(l): l for l in leads if l.get("status") in ("sent", "replied")}
        waiting = {person_key(l): l for l in leads if l.get("status") in ("ready", "requested")}
        order = max([l.get("order") or 0 for l in leads] + [0])
        stamp = now_str()
        for src in incoming:
            lead = {k: src[k] for k in CONTENT_FIELDS if k in src}
            if lead.get("handle"):
                lead["handle"] = str(lead["handle"]).lstrip("@")
            if src.get("channel") == "x" and not lead.get("profile_url"):
                lead["profile_url"] = "https://x.com/" + lead["handle"]
            for w in warnings_for(dict(src, **lead)):
                report["warn"].append("%s: %s" % (src["id"], w))
            old = by_id.get(src["id"])
            if old:
                if old.get("status") == "ready":
                    if old.get("accepted_ts") or (old.get("kind") or "message") != (lead.get("kind") or "message"):
                        # It moved on in the app (e.g. a connect that was accepted):
                        # refresh the facts, never its kind or message state.
                        for k in ("kind", "needs_message", "variants", "library"):
                            lead.pop(k, None)
                    old.update(lead)
                    old["updated_ts"] = stamp
                    report["refreshed"].append(src["id"])
                else:
                    report["kept"].append("%s (%s)" % (src["id"], old.get("status")))
                continue
            key = person_key(src)
            if key in contacted and not args.allow_repeat:
                c = contacted[key]
                report["repeat"].append("%s: already messaged as %s on %s" % (
                    src["id"], c.get("id"), (c.get("sent_ts") or "")[:10]))
                continue
            if key in waiting:
                report["dupe"].append("%s: same person already waiting as %s" % (
                    src["id"], waiting[key].get("id")))
                continue
            order += 1
            lead.update(id=src["id"], channel=src["channel"], status=src.get("status", "ready"),
                        order=order, added_ts=stamp, updated_ts=stamp)
            for k in HISTORY_FIELDS:
                if src.get(k):
                    lead[k] = src[k]
            leads.append(lead)
            by_id[lead["id"]] = lead
            (waiting if lead["status"] in ("ready", "requested") else contacted)[key] = lead
            report["added"].append(src["id"])
        return report

    if args.dry_run:
        merge(load(os.path.join(ddir, "dm-leads.json"), "leads", []))
    else:
        if new_libs:
            libs.update(new_libs)
            save(libs_path, "libraries", libs)
        write_leads(ddir, merge)

    print(("DRY RUN, nothing written. " if args.dry_run else "") +
          "added %d, refreshed %d, left alone %d, skipped as already messaged %d, "
          "skipped as duplicate %d" % (len(report["added"]), len(report["refreshed"]),
                                       len(report["kept"]), len(report["repeat"]), len(report["dupe"])))
    for k, label in (("repeat", "already messaged"), ("dupe", "duplicate"),
                     ("kept", "not touched (already moved on)"), ("warn", "RULE WARNING")):
        for line in report[k]:
            print("  %s: %s" % (label, line))


def cmd_export(args):
    ddir = data_dir(args.data)
    leads = load(os.path.join(ddir, "dm-leads.json"), "leads", [])
    since = args.since or "0000"
    rows = [l for l in leads if (l.get("status") != "ready" or l.get("accepted_ts"))
            and (l.get("updated_ts") or "") >= since
            and (not args.channel or l.get("channel") == args.channel)
            and (not args.campaign or l.get("campaign") == args.campaign)]
    rows.sort(key=lambda l: l.get("sent_ts") or l.get("updated_ts") or "")
    if args.json:
        keep = ("id", "channel", "kind", "campaign", "batch", "n", "name", "handle", "profile_url", "product",
                "status", "requested_ts", "accepted_ts", "sent_ts", "sent_text", "sent_verbatim", "sent_early", "sent_lines",
                "reply_ts", "reply_text", "skip_reason", "note", "updated_ts")
        print(json.dumps([{k: l[k] for k in keep if k in l} for l in rows], indent=1, ensure_ascii=False))
        return
    if not rows:
        print("Nothing sent, replied or skipped since %s." % (args.since or "the start"))
        return
    print("| channel | campaign | batch | # | who | product | status | sent | edited | reply |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    for l in rows:
        who = ("@" + l["handle"]) if l.get("channel") == "x" and l.get("handle") else (l.get("name") or "")
        edited = {True: "no", False: "yes"}.get(l.get("sent_verbatim"), "-")
        reply = (l.get("reply_text") or "").replace("\n", " ").replace("|", "/")[:80]
        status = l.get("status") + (" (%s)" % l["skip_reason"] if l.get("skip_reason") else "")
        if l.get("accepted_ts") and l.get("status") == "ready":
            status = "accepted %s, message not sent yet" % l["accepted_ts"][:10]
        print("| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |" % (
            l.get("channel"), l.get("campaign"), l.get("batch", ""), l.get("n", ""), who,
            l.get("product", ""), status, (l.get("sent_ts") or "")[:16] + (" early" if l.get("sent_early") else ""),
            edited, reply))


def cmd_status(args):
    ddir = data_dir(args.data)
    leads = load(os.path.join(ddir, "dm-leads.json"), "leads", [])
    state = load(os.path.join(ddir, "dm-state.json"), "state", {})
    today = time.strftime("%Y-%m-%d")
    print("data dir: %s" % ddir)
    for ch in CHANNELS:
        mine = [l for l in leads if l.get("channel") == ch]
        by = {}
        for l in mine:
            k = (l.get("campaign"), l.get("batch") or "-")
            by.setdefault(k, {}).setdefault(l.get("status"), 0)
            by[k][l.get("status")] += 1
        sent_today = sum(1 for l in mine if (l.get("sent_ts") or "").startswith(today))
        cool = (state.get("cooldowns") or {}).get(ch) or {}
        cool_txt = ""
        if (cool.get("until") or 0) > time.time():
            cool_txt = ", COOLDOWN until %s" % datetime.fromtimestamp(cool["until"]).strftime("%H:%M")
        print("\n%s: %d leads, %d sent today%s" % (ch, len(mine), sent_today, cool_txt))
        for (camp, batch), counts in sorted(by.items(), key=lambda kv: str(kv[0])):
            print("  %s / %s: %s" % (camp, batch, ", ".join("%s %d" % kv for kv in sorted(counts.items()))))
    sends = load(os.path.join(ddir, "dm-sends.json"), "sends", [])
    print("\nsent messages kept for learning: %d (%d with a reply)" % (
        len(sends), sum(1 for s in sends if s.get("replied"))))


def cmd_campaign(args):
    """Save one campaign's rules. The JSON names a markdown rules file next to it:
    {"id", "label", "channels": [...], "find": {...}, "rules_file": "x.md"}."""
    ddir = data_dir(args.data)
    with open(args.file, encoding="utf-8") as f:
        camp = json.load(f)
    cid = camp.get("id")
    if not cid or not re.fullmatch(r"[a-z0-9-]{2,40}", cid):
        sys.exit("campaign needs an id like motion-video")
    rules_file = camp.pop("rules_file", None)
    if rules_file:
        path = os.path.join(os.path.dirname(os.path.abspath(args.file)), rules_file)
        with open(path, encoding="utf-8") as f:
            camp["rules"] = f.read()
    if not camp.get("rules"):
        sys.exit("campaign needs rules (rules_file or rules)")
    if len(camp["rules"]) > 24000:
        sys.exit("rules are %d chars; keep them under 24000, they ride in every job" % len(camp["rules"]))
    path = os.path.join(ddir, "dm-campaigns.json")
    camps = load(path, "campaigns", {})
    camps[cid] = camp
    save(path, "campaigns", camps)
    print("campaign %s saved (%d chars of rules, channels %s)" % (
        cid, len(camp["rules"]), ", ".join(camp.get("channels") or CHANNELS)))


def cmd_touched(args):
    """Merge a list of already-contacted people into dm-touched.json:
    {"linkedin": [slugs or urls], "x": [handles or urls], "names": ["Full Name"]}."""
    ddir = data_dir(args.data)
    with open(args.file, encoding="utf-8") as f:
        new = json.load(f)
    path = os.path.join(ddir, "dm-touched.json")
    cur = load(path, "touched", {}) or {}

    def li(v):
        m = re.search(r"linkedin\.com/in/([^/?#\s]+)", v or "", re.I)
        return (m.group(1) if m else v or "").strip().lower().rstrip("/").rstrip("-")

    def xh(v):
        m = re.search(r"(?:x|twitter)\.com/@?([A-Za-z0-9_]{1,15})", v or "", re.I)
        return (m.group(1) if m else v or "").strip().lstrip("@").lower()

    out = {"linkedin": sorted({s for s in map(li, (cur.get("linkedin") or []) + (new.get("linkedin") or [])) if s}),
           "x": sorted({s for s in map(xh, (cur.get("x") or []) + (new.get("x") or [])) if s}),
           "names": sorted({n.strip() for n in (cur.get("names") or []) + (new.get("names") or []) if n and n.strip()})}
    save(path, "touched", out)
    print("touched list: %d LinkedIn, %d X, %d names" % (len(out["linkedin"]), len(out["x"]), len(out["names"])))


def cmd_retire(args):
    ddir = data_dir(args.data)
    stamp = now_str()

    def change(leads):
        hit = [l for l in leads if l.get("batch") == args.batch and l.get("status") == "ready"]
        if args.dry_run:
            print("would retire %d waiting leads in %s" % (len(hit), args.batch))
            return None
        for l in hit:
            l.update(status="skipped", skip_reason="batch retired", updated_ts=stamp)
        print("retired %d waiting leads in %s" % (len(hit), args.batch))
        return len(hit)

    write_leads(ddir, change)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", help="sidekick data dir")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("load")
    p.add_argument("file")
    p.add_argument("--allow-repeat", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    p = sub.add_parser("library")
    p.add_argument("file")
    p = sub.add_parser("export")
    p.add_argument("--since")
    p.add_argument("--channel", choices=CHANNELS)
    p.add_argument("--campaign")
    p.add_argument("--json", action="store_true")
    sub.add_parser("status")
    p = sub.add_parser("retire")
    p.add_argument("--batch", required=True)
    p.add_argument("--dry-run", action="store_true")
    p = sub.add_parser("campaign")
    p.add_argument("file")
    p = sub.add_parser("touched")
    p.add_argument("file")
    args = ap.parse_args()
    {"load": cmd_load, "library": cmd_library, "export": cmd_export,
     "status": cmd_status, "retire": cmd_retire, "campaign": cmd_campaign,
     "touched": cmd_touched}[args.cmd](args)


if __name__ == "__main__":
    main()
