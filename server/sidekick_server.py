#!/usr/bin/env python3
"""X reply sidekick server - phone app backend + legacy extension queue.

Replaces tools/x-reply-extension/queue-server.py. Python stdlib only.

Two listeners, one process (so every write goes through one lock):

  LEGACY  127.0.0.1:7781  exact queue-server.py API, no auth, for the Chrome
                          extension on this Mac. Never expose this port.
  APP     127.0.0.1:7790  the Android app (PWA) + its API + Claude callbacks.
                          This is the port you expose through ngrok.
                          /app/*    static PWA files (no secrets in them)
                          /api/*    needs header  X-Sidekick-Key: <APP_PASSWORD>
                          /agent/*  needs header  Authorization: Bearer <job token>
                                    (one random token per job, expires, never stored
                                    anywhere but this server's data dir)
                          anything else -> forwarded to Armory when
                                    ARMORY_PASSTHROUGH is set (optional)

Secrets come from environment variables or a `.env` file next to this script
(gitignored). Nothing secret is ever committed. See ../README.md.

SAFETY: never posts, likes, follows or DMs on X, and never messages anyone on
LinkedIn. Claude only writes drafts and shortlists back into the queue, and DM
leads are loaded by server/dm_tool.py; a human presses Reply or Send.
"""
import base64
import gzip
import hashlib
import hmac
import json
import os
import re
import secrets
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_SIDEKICK = os.path.dirname(HERE)
APP_DIR = os.path.join(REPO_SIDEKICK, "app")
KNOWLEDGE_DIR = os.path.join(REPO_SIDEKICK, "knowledge")


# ---------------------------------------------------------------- config

def load_dotenv(path):
    """Minimal KEY=VALUE loader. Real env vars win over the file."""
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            v = v.strip().strip('"').strip("'")
            os.environ.setdefault(k.strip(), v)


load_dotenv(os.path.join(HERE, ".env"))


def env(name, default=""):
    return os.environ.get(name, default).strip()


APP_PASSWORD = env("SIDEKICK_APP_PASSWORD")
APP_PORT = int(env("SIDEKICK_APP_PORT", "7790"))
LEGACY_PORT = int(env("SIDEKICK_LEGACY_PORT", "7781"))  # 0 disables
PUBLIC_URL = env("SIDEKICK_PUBLIC_URL").rstrip("/")
DATA_DIR = env("SIDEKICK_DATA_DIR") or os.path.join(HERE, "data")
EXTRA_ORIGINS = tuple(o.strip().rstrip("/") for o in env("SIDEKICK_ALLOWED_ORIGINS").split(",") if o.strip())

ARMORY_URL = env("ARMORY_URL").rstrip("/")
ARMORY_USER = env("ARMORY_USER")
ARMORY_PASS = env("ARMORY_PASS")
ARMORY_PASSTHROUGH = env("ARMORY_PASSTHROUGH").rstrip("/")

ROUTINE_FIRE_URL = env("ROUTINE_FIRE_URL")
ROUTINE_TOKEN = env("ROUTINE_TOKEN")
# LinkedIn accepts, read from LinkedIn's emails (accept_watch.py). The address is
# the Gmail the LinkedIn account uses; the password is a Gmail app password.
LI_ACCEPT_EMAIL = env("LI_ACCEPT_EMAIL")
LI_ACCEPT_APP_PASSWORD = env("LI_ACCEPT_APP_PASSWORD").replace(" ", "")
LI_ACCEPT_EVERY_MIN = max(5, int(env("LI_ACCEPT_EVERY_MIN", "10") or 10))
# Accepted people are moved at once, but Write with Claude starts at most this often,
# so a run covers everyone accepted since the last one instead of one run each.
LI_ACCEPT_WRITE_EVERY_MIN = max(10, int(env("LI_ACCEPT_WRITE_EVERY_MIN", "120") or 120))

JOB_TOKEN_TTL = 3 * 3600
SCOUT_WINDOW_HOURS = 24
SCOUT_CHUNK = 10
SCOUT_MAX_CANDIDATES = 60
VOICE_EXAMPLES = 30
DRAFT_CHUNK = 20            # items per routine run; keeps each payload draftable

# Retention. These were sized for a handful of replies a day. At 100/day every
# one of them went binding inside a month, and the two corpora are the ones that
# actually hurt: dropping old sends is the same history loss that archiving the
# queue already caused once. Files stay under 10MB and load in tens of ms at
# these sizes, so the headroom is nearly free.
SENDS_KEEP = 20000          # ~200 days at 100/day
REJECTS_KEEP = 20000
JOBS_KEEP = 400             # ~2 months at 5 chunked runs/day
SCOUT_RUNS_KEEP = 60

QUEUE_FILE = os.path.join(DATA_DIR, "reply-queue.json")
OUTREACH_FILE = os.path.join(DATA_DIR, "outreach-queue.json")
JOBS_FILE = os.path.join(DATA_DIR, "jobs.json")
SCOUT_FILE = os.path.join(DATA_DIR, "scout-runs.json")
BLOCK_FILE = os.path.join(DATA_DIR, "blocklist.json")
# Every reply he actually sends, kept outside the queue. The queue gets archived
# and trimmed, which silently dropped 92 of 102 real sends out of the drafting
# context; the voice corpus must not be able to lose history that way again.
SENDS_FILE = os.path.join(DATA_DIR, "voice-sends.json")
# Drafts he threw away, with the reason. The negative half of the voice corpus.
REJECTS_FILE = os.path.join(DATA_DIR, "rejected-drafts.json")
# One bounded record per builder he replies to. See the people section below.
PEOPLE_FILE = os.path.join(DATA_DIR, "people.json")
# Read-only baseline shipped in the repo, used to seed and to backfill.
SENDS_BASELINE = os.path.join(KNOWLEDGE_DIR, "voice-corpus", "abhiijay-real-sends.json")
WATCHLIST_FILE = env("SIDEKICK_WATCHLIST") or os.path.join(KNOWLEDGE_DIR, "tools", "x-reply-scout-watchlist.md")

LEGACY_ORIGINS = ("https://x.com", "https://twitter.com", "https://pro.x.com",
                  "https://www.reddit.com", "https://old.reddit.com",
                  "https://new.reddit.com", "https://reddit.com",
                  "https://www.linkedin.com", "https://linkedin.com")
MAX_ITEMS = 500
MAX_OUTREACH_ITEMS = 500

LOCK = threading.RLock()  # every read-modify-write of a data file


def now_str():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def log(msg):
    sys.stderr.write("[sidekick] %s\n" % msg)


# ---------------------------------------------------------------- storage

def _load(path, key="items"):
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data.get(key, []) if isinstance(data, dict) else data
    except (json.JSONDecodeError, OSError):
        # Never destroy a corrupt file silently; move it aside.
        os.rename(path, path + ".corrupt-" + time.strftime("%Y%m%d-%H%M%S"))
        return []


def _save(path, items, key="items"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"updated": now_str(), key: items}, f, indent=1, ensure_ascii=False)
    os.replace(tmp, path)


def load_queue():
    return _load(QUEUE_FILE)


def save_queue(items):
    _save(QUEUE_FILE, items[:MAX_ITEMS])


def load_outreach():
    return _load(OUTREACH_FILE)


def save_outreach(items):
    _save(OUTREACH_FILE, items[:MAX_OUTREACH_ITEMS])


def load_jobs():
    return _load(JOBS_FILE, "jobs")


def save_jobs(jobs):
    _save(JOBS_FILE, jobs[:JOBS_KEEP], "jobs")


def handle_key(value):
    """Lowercase bare handle for comparisons ("@Foo" -> "foo")."""
    return str(value or "").strip().lstrip("@").lower()


def load_blocklist():
    return _load(BLOCK_FILE)


def blocked_set():
    return {handle_key(b.get("handle")) for b in load_blocklist()}


def block_handle(body):
    handle = normalize_x_handle(body.get("handle"))
    if not handle:
        return 400, {"error": "valid X handle required"}
    items = load_blocklist()
    if handle.lower() not in {handle_key(b.get("handle")) for b in items}:
        items.insert(0, {"handle": handle, "ts": now_str(),
                         "reason": str(body.get("reason") or "")[:300]})
        _save(BLOCK_FILE, items[:2000])
    # Drop anything of theirs still waiting for a reply.
    queue = load_queue()
    skipped = 0
    for i in queue:
        if handle_key(i.get("author")) == handle.lower() and i.get("status") in ("queued", "drafted"):
            i["status"] = "skipped"
            i["agent_note"] = "blocked author"
            skipped += 1
    if skipped:
        save_queue(queue)
    return 200, {"ok": True, "handle": handle, "skipped": skipped}


def unblock_handle(body):
    key = handle_key(body.get("handle"))
    items = load_blocklist()
    kept = [b for b in items if handle_key(b.get("handle")) != key]
    _save(BLOCK_FILE, kept)
    return 200, {"ok": True, "removed": len(items) - len(kept)}


def engagement_gap(views, likes, replies, retweets):
    """High views + low engagement = people see it but few have replied yet,
    so a good reply is likely to be seen. Returns (flag, ratio)."""
    views = views or 0
    eng = (likes or 0) + (replies or 0) + (retweets or 0)
    ratio = round(views / (eng + 1), 1)
    flag = views >= 1000 and (replies or 0) <= 10 and eng <= views * 0.02
    return flag, ratio


def load_scout_runs():
    return _load(SCOUT_FILE, "runs")


def save_scout_runs(runs):
    _save(SCOUT_FILE, runs[:SCOUT_RUNS_KEEP], "runs")


# ---------------------------------------------------------------- X helpers

def normalize_x_handle(value):
    handle = str(value or "").strip()
    handle = re.sub(r"^https?://(?:www\.|mobile\.)?(?:x|twitter)\.com/", "", handle, flags=re.I)
    handle = handle.split("/")[0].split("?")[0].lstrip("@").strip()
    return handle if re.fullmatch(r"[A-Za-z0-9_]{1,50}", handle) else None


def tweet_id_from_url(url):
    m = re.search(r"/status(?:es)?/(\d+)", url or "")
    return m.group(1) if m else None


def item_key_from_url(platform, url):
    url = url or ""
    if platform == "reddit":
        m = re.search(r"/comments/([a-z0-9]+)", url)
        if m:
            return "t3_" + m.group(1)
    elif platform == "linkedin":
        m = re.search(r"(urn:li:[a-zA-Z]+:\d+)", url)
        if m:
            return m.group(1)
    return url.split("?")[0].rstrip("/")[:300] or None


def clean_tweet_url(url):
    """Canonical https://x.com/<handle>/status/<id> (drops ?s=20 share junk)."""
    m = re.search(r"(?:x|twitter)\.com/([A-Za-z0-9_]{1,50})/status(?:es)?/(\d+)", url or "")
    if not m:
        return url
    return "https://x.com/%s/status/%s" % (m.group(1), m.group(2))


def first_url(text):
    m = re.search(r"https?://\S+", text or "")
    return m.group(0).rstrip(").,") if m else ""


def parse_x_time(value):
    try:
        return datetime.strptime(value, "%a %b %d %H:%M:%S %z %Y")
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------- queue ops (shared by both ports)

def queue_add(body):
    """Same rules as queue-server.py /queue/add. Returns (code, payload)."""
    platform = str(body.get("platform", "x")).lower()
    items = load_queue()
    if platform == "x" or body.get("tweet_url"):
        if not body.get("tweet_url") or not (body.get("tweet_text") or body.get("text_missing")):
            return 400, {"error": "tweet_url and tweet_text required"}
        tid = tweet_id_from_url(body["tweet_url"])
        # Any status counts as a duplicate, not just queued/drafted. Limiting it to
        # those two let a post he had already replied to or skipped be queued again
        # and re-drafted from scratch.
        dup = next((i for i in items if tid and i.get("tweet_id") == tid), None)
        if dup:
            return 200, {"ok": True, "duplicate": True, "id": dup.get("id"),
                         "status": dup.get("status")}
        item = {
            "id": uuid.uuid4().hex[:8],
            "ts": now_str(),
            "platform": "x",
            "tweet_url": str(body["tweet_url"])[:500],
            "tweet_id": tid,
            "tweet_text": str(body.get("tweet_text") or "")[:4000],
            "author": str(body.get("author", ""))[:100],
            "author_followers": body.get("author_followers"),
            "note": str(body.get("note", ""))[:500],
            "status": "queued",
            "drafts": [],
        }
        if body.get("text_missing"):
            item["text_missing"] = True
        if body.get("source"):
            item["source"] = str(body["source"])[:40]
    elif platform in ("reddit", "linkedin"):
        if not body.get("url") or not (body.get("text") or body.get("title")):
            return 400, {"error": "url and text/title required"}
        key = (str(body["item_key"])[:300] if body.get("item_key")
               else item_key_from_url(platform, body["url"]))
        if key and any(i.get("item_key") == key and i.get("status") in ("queued", "drafted") for i in items):
            return 200, {"ok": True, "duplicate": True}
        item = {
            "id": uuid.uuid4().hex[:8],
            "ts": now_str(),
            "platform": platform,
            "url": str(body["url"])[:500],
            "item_key": key,
            "title": str(body.get("title", ""))[:400],
            "text": str(body.get("text", ""))[:3000],
            "author": str(body.get("author", ""))[:100],
            "subreddit": str(body.get("subreddit", ""))[:100],
            "meta": str(body.get("meta", ""))[:200],
            "note": str(body.get("note", ""))[:500],
            "link_missing": bool(body.get("link_missing", False)),
            "status": "queued",
            "drafts": [],
        }
    else:
        return 400, {"error": "unknown platform"}
    items.insert(0, item)
    save_queue(items)
    return 200, {"ok": True, "id": item["id"]}


def queue_update(body):
    if not body.get("id"):
        return 400, {"error": "id required"}
    items = load_queue()
    for i in items:
        if i.get("id") == body["id"]:
            new_status = body.get("status")
            if new_status in ("posted", "skipped", "queued"):
                i["status"] = new_status
                if new_status == "posted":
                    i["posted_ts"] = now_str()
                    if isinstance(body.get("chosen_index"), int):
                        i["chosen_index"] = body["chosen_index"]
            if isinstance(body.get("posted_text"), str):
                i["posted_text"] = body["posted_text"][:2000]
            if isinstance(body.get("sent_verbatim"), bool):
                i["sent_verbatim"] = body["sent_verbatim"]
            if isinstance(body.get("note"), str):
                i["note"] = body["note"][:500]
            save_queue(items)
            # The learning loop: his real wording goes straight into the durable
            # voice corpus, so it survives the queue being archived or trimmed.
            if i.get("status") == "posted":
                record_send(i)
                record_person(i)
            return 200, {"ok": True}
    return 404, {"error": "id not found"}


def reject_draft(body):
    """Drop one bad draft from an item and keep it as a negative example.

    The corpus of what he sends teaches the voice; the corpus of what he throws
    away teaches the tells. Only the first half existed.
    """
    item_id, idx = body.get("id"), body.get("index")
    if not item_id or not isinstance(idx, int):
        return 400, {"error": "id and index required"}
    with LOCK:
        items = load_queue()
        it = next((i for i in items if i.get("id") == item_id), None)
        if not it:
            return 404, {"error": "id not found"}
        drafts = it.get("drafts") or []
        if idx < 0 or idx >= len(drafts):
            return 400, {"error": "index out of range"}
        dead = drafts.pop(idx)
        it["drafts"] = drafts
        if isinstance(it.get("chosen_index"), int):
            if it["chosen_index"] == idx:
                it.pop("chosen_index", None)
            elif it["chosen_index"] > idx:
                it["chosen_index"] -= 1
        if not drafts and it.get("status") == "drafted":
            it["status"] = "queued"          # nothing usable left; send it back
        save_queue(items)

        rejects = _load(REJECTS_FILE, "rejects")
        rejects.insert(0, {"ts": now_str(),
                           "post": (it.get("tweet_text") or it.get("text") or "")[:600],
                           "author": it.get("author"),
                           "url": it.get("tweet_url") or it.get("url"),
                           "text": dead.get("text", ""), "angle": dead.get("angle", ""),
                           "reason": str(body.get("reason", ""))[:300]})
        _save(REJECTS_FILE, rejects[:REJECTS_KEEP], "rejects")
    return 200, {"ok": True, "left": len(drafts)}


def queue_clear_done():
    cutoff = time.time() - 7 * 86400
    items = load_queue()

    def keep(i):
        if i.get("status") in ("queued", "drafted"):
            return True
        try:
            return time.mktime(time.strptime(i["ts"], "%Y-%m-%d %H:%M:%S")) > cutoff
        except (KeyError, ValueError):
            return True

    kept = [i for i in items if keep(i)]
    save_queue(kept)
    return 200, {"ok": True, "removed": len(items) - len(kept)}


def outreach_add(body):
    handle = normalize_x_handle(body.get("handle") or body.get("profile_url"))
    if not handle:
        return 400, {"error": "valid X handle required"}
    items = load_outreach()
    dup = next((i for i in items if str(i.get("handle", "")).lower() == handle.lower()
                and i.get("status") == "queued"), None)
    if dup:
        return 200, {"ok": True, "duplicate": True, "id": dup.get("id")}
    item = {
        "id": uuid.uuid4().hex[:8],
        "ts": now_str(),
        "platform": "x",
        "profile_url": "https://x.com/" + handle,
        "handle": handle,
        "display_name": str(body.get("display_name", ""))[:200],
        "bio": str(body.get("bio", ""))[:1000],
        "followers_text": str(body.get("followers_text", ""))[:100],
        "source": str(body.get("source") or "x_profile_button")[:40],
        "reason": str(body.get("reason") or "no_recent_post_within_48h")[:80],
        "queue": "next_outreach_batch",
        "status": "queued",
    }
    items.insert(0, item)
    save_outreach(items)
    return 200, {"ok": True, "id": item["id"]}


def linkedin_slug(url):
    """Profile slug from a linkedin.com/in/<slug> link, or None."""
    m = re.search(r"linkedin\.com/in/([^/?#\s]+)", url or "", re.I)
    if not m:
        return None
    slug = urllib.parse.unquote(m.group(1)).strip()
    return slug[:100] or None


def outreach_add_linkedin(body):
    """A LinkedIn profile shared from the phone, saved for the next LinkedIn batch.

    Same list as the X profiles (outreach-queue.json), told apart by `platform`.
    Saving a profile never messages anyone.
    """
    url = str(body.get("profile_url") or body.get("url") or "")
    slug = linkedin_slug(url)
    if not slug:
        return 400, {"error": "a linkedin.com/in/ profile link is required"}
    items = load_outreach()
    dup = next((i for i in items if i.get("platform") == "linkedin"
                and str(i.get("handle", "")).lower() == slug.lower()
                and i.get("status") == "queued"), None)
    if dup:
        return 200, {"ok": True, "duplicate": True, "id": dup.get("id")}
    item = {
        "id": uuid.uuid4().hex[:8],
        "ts": now_str(),
        "platform": "linkedin",
        "profile_url": "https://www.linkedin.com/in/%s/" % urllib.parse.quote(slug, safe="-_.~%"),
        "handle": slug,
        "display_name": str(body.get("display_name", ""))[:200],
        "bio": str(body.get("note") or body.get("bio") or "")[:1000],
        "source": str(body.get("source") or "android_share")[:40],
        "reason": str(body.get("reason") or "shared_from_phone")[:80],
        "queue": "next_outreach_batch",
        "status": "queued",
    }
    items.insert(0, item)
    save_outreach(items)
    return 200, {"ok": True, "id": item["id"]}


def outreach_update(body):
    """Remove a saved profile, or mark it as taken into a batch."""
    status = body.get("status")
    if not body.get("id") or status not in ("queued", "removed", "batched"):
        return 400, {"error": "id and status (queued|removed|batched) required"}
    items = load_outreach()
    for i in items:
        if i.get("id") == body["id"]:
            i["status"] = status
            i["updated_ts"] = now_str()
            save_outreach(items)
            return 200, {"ok": True}
    return 404, {"error": "id not found"}


def health_counts():
    items = load_queue()
    outreach = load_outreach()
    return {
        "status": "ok",
        "v": 4,
        "queued": sum(1 for i in items if i.get("status") == "queued"),
        "drafted": sum(1 for i in items if i.get("status") == "drafted"),
        "outreach_queued": sum(1 for i in outreach if i.get("status") == "queued"),
    }


# ---------------------------------------------------------------- DM outreach (LinkedIn + X DMs)
#
# The reply premise, applied to first messages: Claude prepares, a person sends.
# Leads are loaded from Cowork with server/dm_tool.py, which merges them into
# dm-leads.json by id. Nothing here sends anything - the app copies the message
# and opens the profile, and he presses Send in LinkedIn or X himself.
#
# One message per person. X leads compose theirs on the phone from a line
# library (dm-libraries.json: hooks, proofs, CTAs and the rules for which follow
# which), so one Shuffle tap gives a new valid message. LinkedIn leads carry the
# written variants instead (e.g. Video pitch / Feedback ask).
#
# The learning loop: every message marked sent goes into dm-sends.json with the
# exact text, whether he edited it, and which lines it came from; a reply later
# marks that record replied. It lives outside dm-leads.json for the same reason
# voice-sends.json lives outside the queue - trimming leads must never lose it.

DM_LEADS_FILE = os.path.join(DATA_DIR, "dm-leads.json")
DM_LIBS_FILE = os.path.join(DATA_DIR, "dm-libraries.json")
DM_SENDS_FILE = os.path.join(DATA_DIR, "dm-sends.json")
DM_STATE_FILE = os.path.join(DATA_DIR, "dm-state.json")
# Per-campaign rules (ICP, offer, how to write) sent to the routine in job
# payloads. Private: it lives in the data dir, never in this public repo.
DM_CAMPAIGNS_FILE = os.path.join(DATA_DIR, "dm-campaigns.json")
# Everyone already contacted anywhere (LinkedIn slugs, X handles, names), so
# "Find more" never brings back someone who was already connected or messaged.
DM_TOUCHED_FILE = os.path.join(DATA_DIR, "dm-touched.json")
FIND_RUNS_FILE = os.path.join(DATA_DIR, "find-runs.json")
# "Tell Claude" notes from the phone: what to change in the messages it writes.
# Every Write with Claude run reads the newest ones as standing rules, the same
# way rejected-drafts.json works for replies.
DM_FEEDBACK_FILE = os.path.join(DATA_DIR, "dm-feedback.json")
DM_FEEDBACK_KEEP = 2000
DM_FEEDBACK_SENT = 30        # newest notes sent to each write run
DM_CHANNELS = ("linkedin", "x")
# A lead is kind "message" (default) or kind "connect" (LinkedIn only: a profile
# to send a connection request to). Connect leads move ready -> requested ->
# accepted, and accepting turns them into a message lead.
DM_STATUSES = ("ready", "sent", "replied", "skipped", "cant_dm", "requested", "accepted")
FIND_MAX_WANT = 100
WRITE_CHUNK = 15            # leads per "write messages" routine run
DM_LEADS_MAX = 5000
DM_SENDS_KEEP = 20000
DM_RECENT_DAYS = 30          # sent / finished leads the app still lists
DM_DONE_MAX = 300
DM_TEXT_MAX = 4000
# X answers a spam block with "Failed, try again" and blocks sending for 30+ min
# (see the outreach deliverability rules). A failure starts this cooldown.
DM_COOLDOWN_MIN = 30


def load_dm_leads():
    return _load(DM_LEADS_FILE, "leads")


def save_dm_leads(leads):
    _save(DM_LEADS_FILE, leads[:DM_LEADS_MAX], "leads")


def load_dm_libraries():
    libs = _load(DM_LIBS_FILE, "libraries")
    return libs if isinstance(libs, dict) else {}


def load_dm_state():
    st = _load(DM_STATE_FILE, "state")
    return st if isinstance(st, dict) else {}


def save_dm_state(st):
    _save(DM_STATE_FILE, st, "state")


def lead_kind(lead):
    return lead.get("kind") or "message"


def dm_stats(leads, state):
    today = time.strftime("%Y-%m-%d")
    week_ago = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d %H:%M:%S")
    now = time.time()
    out = {}
    for ch in DM_CHANNELS:
        mine = [l for l in leads if l.get("channel") == ch]
        sent = sorted((l["sent_ts"] for l in mine if l.get("sent_ts")), reverse=True)
        asked = sorted((l["requested_ts"] for l in mine if l.get("requested_ts")), reverse=True)
        cool = ((state.get("cooldowns") or {}).get(ch) or {})
        until = cool.get("until") or 0
        out[ch] = {
            "ready": sum(1 for l in mine if l.get("status") == "ready" and lead_kind(l) == "message"),
            "sent_today": sum(1 for t in sent if t.startswith(today)),
            "last_sent_ts": sent[0] if sent else None,
            "cooldown_until": until if until > now else None,
            "cooldown_since": cool.get("ts") if until > now else None,
            "connect_ready": sum(1 for l in mine if l.get("status") == "ready" and lead_kind(l) == "connect"),
            "requested_open": sum(1 for l in mine if l.get("status") == "requested"),
            "requested_today": sum(1 for t in asked if t.startswith(today)),
            "requested_7d": sum(1 for t in asked if t >= week_ago),
            "last_requested_ts": asked[0] if asked else None,
            "needs_message": sum(1 for l in mine if l.get("needs_message") and l.get("status") == "ready"),
        }
    return out


def dm_view():
    """What the app shows: everything waiting on him, plus the recent rest.

    Waiting = to connect, requested (until accepted, up to 90 days), to send.
    Only the libraries the listed leads use are sent along.
    """
    leads = load_dm_leads()
    cutoff = (datetime.now() - timedelta(days=DM_RECENT_DAYS)).strftime("%Y-%m-%d %H:%M:%S")
    long_cut = (datetime.now() - timedelta(days=90)).strftime("%Y-%m-%d %H:%M:%S")
    ready = [l for l in leads if l.get("status") == "ready"]
    asked = [l for l in leads if l.get("status") == "requested"
             and (l.get("requested_ts") or l.get("updated_ts") or "") >= long_cut]
    recent = [l for l in leads if l.get("status") not in ("ready", "requested")
              and (l.get("updated_ts") or l.get("added_ts") or "") >= cutoff]
    recent.sort(key=lambda l: l.get("updated_ts") or "", reverse=True)
    shown = ready + asked + recent[:DM_DONE_MAX]
    # A write job that died without calling back must not leave "writing…" up.
    live = {j["id"] for j in load_jobs() if j["kind"] == "dmwrite"
            and j["status"] in ("created", "fired", "working") and j.get("expires", 0) > time.time()}
    # `context` is for the writer only; leaving it out keeps the phone's payload small.
    shown = [{k: v for k, v in l.items()
              if k != "context" and not (k == "writing_job" and v not in live)} for l in shown]
    chats = lead_chats()
    for l in shown:
        url = chats.get(l.get("id")) or chats.get(l.get("found_by"))
        if url:
            l["claude_url"] = url
    wanted = {l.get("library") for l in shown if l.get("library")}
    libs = {k: v for k, v in load_dm_libraries().items() if k in wanted}
    camps = {k: {"label": v.get("label") or k, "channels": v.get("channels") or list(DM_CHANNELS)}
             for k, v in load_dm_campaigns().items()}
    return {"leads": shown, "libraries": libs, "stats": dm_stats(leads, load_dm_state()),
            "cooldown_min": DM_COOLDOWN_MIN, "campaigns": camps}


def lead_chats():
    """Lead id (or Find more job id) -> the Claude session that worked on it.

    Built from jobs.json, so it also covers leads written before this existed:
    a dmwrite job's payload lists its lead ids. The newest session wins.
    """
    out = {}
    for j in reversed(load_jobs()):          # jobs are newest first
        url = j.get("session_url")
        if not url:
            continue
        if j.get("kind") == "dmwrite":
            for lid in (j.get("payload") or {}).get("lead_ids") or []:
                out[lid] = url
        elif j.get("kind") == "leadfind":
            out[j["id"]] = url
    return out


def load_dm_feedback():
    return _load(DM_FEEDBACK_FILE, "notes")


def dm_feedback(body):
    """A note from the phone about how Claude writes these messages.

    Always kept as a standing rule for every future write run. With
    `rewrite: true` the lead also goes back to "needs a message" carrying the
    note and its current text, and a write run starts for it.
    """
    text = str(body.get("text") or "").strip()[:1000]
    if not text:
        return 400, {"error": "say what to change"}
    lid = body.get("id")
    with LOCK:
        leads = load_dm_leads()
        lead = next((l for l in leads if l.get("id") == lid), None) if lid else None
        notes = load_dm_feedback()
        notes.insert(0, {"ts": now_str(), "text": text,
                         "channel": (lead or {}).get("channel") or body.get("channel"),
                         "campaign": (lead or {}).get("campaign"),
                         "lead": (lead or {}).get("name") or (lead or {}).get("handle"),
                         "message": str(body.get("message") or "")[:DM_TEXT_MAX] or None})
        _save(DM_FEEDBACK_FILE, notes[:DM_FEEDBACK_KEEP], "notes")
        rewrite = bool(body.get("rewrite")) and lead and lead.get("status") == "ready" \
            and lead_kind(lead) == "message"
        if rewrite:
            lead["fix_note"] = text
            lead["previous_text"] = str(body.get("message") or "")[:DM_TEXT_MAX]
            lead["needs_message"] = True
            lead.pop("draft_text", None)
            lead["updated_ts"] = now_str()
            save_dm_leads(leads)
    if not rewrite:
        return 200, {"ok": True, "saved": True}
    code, res = start_write_job({"ids": [lid]})
    res["saved"] = True
    return code, res


# ---------------------------------------------------------------- accepted, from email

def accept_configured():
    return bool(LI_ACCEPT_EMAIL and LI_ACCEPT_APP_PASSWORD)


ACCEPT_RUN_LOCK = threading.Lock()


def accept_check(trigger="timer"):
    """Reads LinkedIn's acceptance emails and moves those people to Message.

    Same move as tapping Accepted on the phone (dm_update), so undo and history
    work the same. Then starts Write with Claude for whoever needs a message,
    at most once per LI_ACCEPT_WRITE_EVERY_MIN.
    """
    import accept_watch
    if not accept_configured():
        return 400, {"error": "LI_ACCEPT_EMAIL / LI_ACCEPT_APP_PASSWORD are not set in server/.env"}
    if not ACCEPT_RUN_LOCK.acquire(blocking=False):
        return 409, {"error": "a check is already running"}
    try:
        st = load_dm_state()
        aw = st.get("accept_watch") or {}
        try:
            found, checked = accept_watch.fetch_acceptances(LI_ACCEPT_EMAIL, LI_ACCEPT_APP_PASSWORD,
                                                            days=21, seen=aw.get("seen") or [])
            err = None
        except Exception as e:      # wrong password, no network: shown in the app
            found, checked, err = [], [], "%s: %s" % (type(e).__name__, e)
        with LOCK:
            requested = [{"id": l["id"], "name": l.get("name") or "", "slug": linkedin_slug(l.get("profile_url"))}
                         for l in load_dm_leads()
                         if l.get("channel") == "linkedin" and lead_kind(l) == "connect" and l.get("status") == "requested"]
        hits = accept_watch.match(found, requested)
        # "X messaged you": a Requested person who writes has accepted; someone in
        # Sent who writes after his message has replied (the email never has the text).
        with LOCK:
            leads_now = load_dm_leads()
        by_slug = {}
        for l in leads_now:
            sl = (linkedin_slug(l.get("profile_url")) or "").lower()
            if l.get("channel") == "linkedin" and sl:
                by_slug.setdefault(sl, l)
        hit_ids = {h["id"] for h in hits}
        replied = []
        for ev in found:
            if ev.get("type") != "messaged":
                continue
            for sl in ev.get("slugs") or []:
                l = by_slug.get(sl)
                if not l:
                    continue
                if lead_kind(l) == "connect" and l.get("status") == "requested" and l["id"] not in hit_ids:
                    hits.append({"id": l["id"], "name": l.get("name")})
                    hit_ids.add(l["id"])
                elif (lead_kind(l) == "message" and l.get("status") == "sent"
                      and (ev.get("ts") or "") > (l.get("sent_ts") or "~")
                      and l["id"] not in {r["id"] for r in replied}):
                    replied.append({"id": l["id"], "name": l.get("name")})
        moved = []
        for h in hits:
            code, _ = dm_update({"id": h["id"], "status": "accepted"})
            if code == 200:
                moved.append(h)
        got_reply = []
        for r in replied:
            code, _ = dm_update({"id": r["id"], "status": "replied"})
            if code == 200:
                got_reply.append(r)
        with LOCK:
            leads = load_dm_leads()
            ids = {h["id"] for h in moved}
            rids = {r["id"] for r in got_reply}
            for l in leads:
                if l["id"] in ids:
                    l["accepted_by"] = "email"
                if l["id"] in rids:
                    l["replied_by"] = "email"
            if ids or rids:
                save_dm_leads(leads)
            st = load_dm_state()
            aw = st.get("accept_watch") or {}
            aw["seen"] = (checked + (aw.get("seen") or []))[:500]
            aw.update(last_ts=now_str(), last_found=len(moved), last_replies=len(got_reply), error=err, trigger=trigger)
            if moved:
                aw["last_moved"] = [{"name": h["name"], "ts": now_str()} for h in moved][:20]
            st["accept_watch"] = aw
            save_dm_state(st)
        if moved or got_reply:
            log("accept check: %d accepted, %d replied" % (len(moved), len(got_reply)))
        wrote = maybe_autowrite()
        return 200, {"ok": not err, "error": err, "moved": [h["name"] for h in moved],
                     "replied": [r["name"] for r in got_reply], "writing": wrote}
    finally:
        ACCEPT_RUN_LOCK.release()


def maybe_autowrite():
    """Write with Claude for LinkedIn people waiting on a message, throttled."""
    if not routine_configured():
        return 0
    with LOCK:
        st = load_dm_state()
        last = (st.get("accept_watch") or {}).get("last_write_ts") or ""
        due = (datetime.now() - timedelta(minutes=LI_ACCEPT_WRITE_EVERY_MIN)).strftime("%Y-%m-%d %H:%M:%S")
        if last > due:
            return 0
    code, res = start_write_job({"channel": "linkedin"})
    if code != 200:
        return 0               # nobody waiting, or a run is already going
    with LOCK:
        st = load_dm_state()
        st.setdefault("accept_watch", {})["last_write_ts"] = now_str()
        save_dm_state(st)
    return res.get("leads", 0)


def accept_loop():
    time.sleep(60)             # let the server settle first
    while True:
        try:
            accept_check("timer")
        except Exception as e:
            log("accept check failed: %r" % e)
        time.sleep(LI_ACCEPT_EVERY_MIN * 60)


def accept_status():
    aw = (load_dm_state().get("accept_watch") or {})
    return {"on": accept_configured(), "every_min": LI_ACCEPT_EVERY_MIN,
            **{k: aw.get(k) for k in ("last_ts", "last_found", "last_replies", "error", "last_moved")}}


def load_dm_campaigns():
    c = _load(DM_CAMPAIGNS_FILE, "campaigns")
    return c if isinstance(c, dict) else {}


def touched_keys():
    """Everyone already contacted: 'li:<slug>' and 'x:<handle>' keys, plus names."""
    keys, names = set(), set()
    t = _load(DM_TOUCHED_FILE, "touched")
    if isinstance(t, dict):
        keys.update("li:" + s.lower().rstrip("/").rstrip("-") for s in t.get("linkedin") or [] if s)
        keys.update("x:" + h.lower().lstrip("@") for h in t.get("x") or [] if h)
        names.update(n.lower() for n in t.get("names") or [] if n and " " in n)
    for l in load_dm_leads():
        slug = linkedin_slug(l.get("profile_url") or "")
        if slug:
            keys.add("li:" + slug.lower().rstrip("/").rstrip("-"))
        if l.get("handle") and l.get("channel") == "x":
            keys.add("x:" + str(l["handle"]).lower().lstrip("@"))
    for o in load_outreach():
        if o.get("platform") == "linkedin" and o.get("handle"):
            keys.add("li:" + str(o["handle"]).lower())
        elif o.get("handle"):
            keys.add("x:" + str(o["handle"]).lower())
    return keys, names


def record_dm_send(lead):
    """Keep the message he sent. One record per lead; re-marking replaces it."""
    text = (lead.get("sent_text") or "").strip()
    sends = _load(DM_SENDS_FILE, "sends")
    sends = [s for s in sends if s.get("lead_id") != lead.get("id")]
    if text:
        entry = {"ts": lead.get("sent_ts") or now_str(), "lead_id": lead.get("id"),
                 "channel": lead.get("channel"), "campaign": lead.get("campaign"),
                 "batch": lead.get("batch"), "to": lead.get("handle") or lead.get("name"),
                 "product": lead.get("product"), "text": text,
                 "lines": lead.get("sent_lines"), "early": bool(lead.get("sent_early"))}
        if isinstance(lead.get("sent_verbatim"), bool):
            entry["verbatim"] = lead["sent_verbatim"]
        if lead.get("status") == "replied":
            # Which first messages get answered is the most useful thing this
            # file can teach, so the reply rides along with the send.
            entry["replied"] = True
            entry["reply_ts"] = lead.get("reply_ts")
            entry["reply"] = (lead.get("reply_text") or "")[:500]
        sends.insert(0, entry)
    _save(DM_SENDS_FILE, sends[:DM_SENDS_KEEP], "sends")


def forget_dm_send(lead_id):
    sends = _load(DM_SENDS_FILE, "sends")
    kept = [s for s in sends if s.get("lead_id") != lead_id]
    if len(kept) != len(sends):
        _save(DM_SENDS_FILE, kept, "sends")


def dm_update(body):
    """One lead changed on the phone: an edit, a shuffle, or a status move.

    Status moves: ready -> sent -> replied, or ready -> skipped / cant_dm.
    Moving back is allowed (undo), and undoing a send also drops it from
    dm-sends.json so a mis-tap never teaches anything.
    """
    lid = body.get("id")
    if not lid:
        return 400, {"error": "id required"}
    new = body.get("status")
    if new is not None and new not in DM_STATUSES:
        return 400, {"error": "unknown status"}
    with LOCK:
        leads = load_dm_leads()
        lead = next((l for l in leads if l.get("id") == lid), None)
        if not lead:
            return 404, {"error": "id not found"}
        ts = now_str()
        if isinstance(body.get("draft_text"), str):
            lead["draft_text"] = body["draft_text"][:DM_TEXT_MAX]
        if body.get("draft_text", "") is None:
            lead.pop("draft_text", None)          # back to the composed message
        if "pick" in body:
            pick = body.get("pick")
            if isinstance(pick, dict):
                lead["pick"] = {k: str(pick[k])[:60] for k in ("hook", "proof", "cta", "sal") if pick.get(k)}
            elif pick is None:
                lead.pop("pick", None)
        if isinstance(body.get("variant_index"), int):
            lead["variant_index"] = max(0, body["variant_index"])
        if isinstance(body.get("note"), str):
            lead["note"] = body["note"][:500]
        if isinstance(body.get("reply_text"), str):
            lead["reply_text"] = body["reply_text"][:DM_TEXT_MAX]
        if isinstance(body.get("sent_text"), str):
            lead["sent_text"] = body["sent_text"][:DM_TEXT_MAX]
        if isinstance(body.get("sent_verbatim"), bool):
            lead["sent_verbatim"] = body["sent_verbatim"]
        if isinstance(body.get("sent_lines"), str):
            lead["sent_lines"] = body["sent_lines"][:120]

        if body.get("kind") in ("connect", "message"):
            lead["kind"] = body["kind"]          # only used to undo an "accepted"
        if new in ("requested", "accepted") and lead_kind(lead) != "connect":
            return 400, {"error": "requested/accepted are for connect leads"}

        prev = lead.get("status")
        if new and new != prev:
            lead["status"] = new
            if new == "sent":
                if prev in ("ready", "skipped", "cant_dm"):
                    lead["sent_ts"] = ts
                    lead["sent_early"] = bool(body.get("sent_early"))
                lead.pop("reply_ts", None)
            elif new == "replied":
                lead["reply_ts"] = ts
            elif new == "requested":
                if not lead.get("requested_ts"):
                    lead["requested_ts"] = ts
                for k in ("accepted_ts", "needs_message", "skip_reason"):
                    lead.pop(k, None)
            elif new == "accepted":
                # Now a 1st-degree connection: the same person becomes someone
                # to message, carrying everything known about them.
                lead["accepted_ts"] = ts
                lead["kind"] = "message"
                lead["status"] = "ready"
                if not lead.get("variants") and not lead.get("library"):
                    lead["needs_message"] = True
            elif new == "ready":
                if lead_kind(lead) == "connect":
                    drop = ("requested_ts", "accepted_ts", "needs_message", "skip_reason")
                else:
                    drop = ("sent_ts", "sent_early", "sent_verbatim", "sent_lines", "reply_ts", "skip_reason")
                for k in drop:
                    lead.pop(k, None)
            elif new in ("skipped", "cant_dm"):
                lead["skip_reason"] = str(body.get("reason") or "")[:200]
        lead["updated_ts"] = ts
        save_dm_leads(leads)

        status = lead.get("status")
        if status in ("sent", "replied") and (
                new in ("sent", "replied") or isinstance(body.get("sent_text"), str)):
            record_dm_send(lead)
        elif new in ("ready", "skipped", "cant_dm") and prev in ("sent", "replied"):
            forget_dm_send(lid)
        stats = dm_stats(leads, load_dm_state())
    return 200, {"ok": True, "lead": lead, "stats": stats}


def dm_failed(body):
    """X said "Failed, try again": start the cooldown for that channel."""
    ch = body.get("channel")
    if ch not in DM_CHANNELS:
        return 400, {"error": "channel must be linkedin or x"}
    minutes = body.get("minutes") if isinstance(body.get("minutes"), int) else DM_COOLDOWN_MIN
    minutes = max(5, min(minutes, 24 * 60))
    with LOCK:
        st = load_dm_state()
        st.setdefault("cooldowns", {})[ch] = {"ts": now_str(), "until": time.time() + minutes * 60,
                                              "lead_id": str(body.get("id") or "")[:40]}
        fails = st.setdefault("failures", [])
        fails.insert(0, {"ts": now_str(), "channel": ch, "lead_id": str(body.get("id") or "")[:40]})
        st["failures"] = fails[:200]
        save_dm_state(st)
        stats = dm_stats(load_dm_leads(), st)
    return 200, {"ok": True, "stats": stats}


def clamp_int(value, low, high, default):
    try:
        return max(low, min(high, int(value)))
    except (TypeError, ValueError):
        return default


def short_campaign(cid):
    return {"motion-video": "mv", "beamcite": "bc"}.get(cid, re.sub(r"[^a-z0-9]", "", cid.lower())[:4] or "c")


# ---------------------------------------------------------------- Find more (lead finder job)
#
# Same two stages as the reply scout. Stage 1 runs here, in a thread: pull fresh
# launches (lead_finder.py), keep makers who listed a LinkedIn (or X) link, check
# their homepage, skip anyone already touched, score. Stage 2 fires the routine
# (kind "leadfind") so Claude judges ICP fit with the campaign's rules and drops
# directories, agencies and competitors. Only then are leads added. Nothing is
# ever sent: a connect lead is just a profile link for him to open.

def load_find_runs():
    return _load(FIND_RUNS_FILE, "runs")


def save_find_runs(runs):
    _save(FIND_RUNS_FILE, runs[:40], "runs")


def update_find_run(job_id, **fields):
    with LOCK:
        runs = load_find_runs()
        for r in runs:
            if r.get("job_id") == job_id:
                r.update(fields)
        save_find_runs(runs)


def start_find_job(body):
    campaigns = load_dm_campaigns()
    campaign = str(body.get("campaign") or "")
    if campaign not in campaigns:
        return 400, {"error": "unknown campaign; load one with dm_tool.py campaign"}
    channel = body.get("channel") if body.get("channel") in DM_CHANNELS else "linkedin"
    want = clamp_int(body.get("want"), 1, FIND_MAX_WANT, 20)
    days = clamp_int(body.get("days"), 3, 45, 14)
    running = next((j for j in load_jobs() if j["kind"] == "leadfind"
                    and j["status"] in ("created", "fetching", "scoring", "fired", "working")
                    and j.get("expires", 0) > time.time()), None)
    if running:
        return 409, {"error": "a Find more run is already going", "job": public_job(running)}
    job, token = create_job("leadfind", {"campaign": campaign, "channel": channel,
                                         "want": want, "days": days})
    with LOCK:
        runs = load_find_runs()
        runs.insert(0, {"id": "find_" + uuid.uuid4().hex[:8], "job_id": job["id"], "ts": now_str(),
                        "campaign": campaign, "channel": channel, "want": want, "days": days,
                        "candidates": [], "added": [], "report": None})
        save_find_runs(runs)
    threading.Thread(target=run_find_stage1, args=(job["id"], token), daemon=True).start()
    return 200, {"ok": True, "job": public_job(get_job(job["id"]))}


def run_find_stage1(job_id, token):
    try:
        import lead_finder
        job = get_job(job_id)
        p = job["payload"]
        camp = load_dm_campaigns().get(p["campaign"], {})
        find_cfg = camp.get("find") or {}
        keys, names = touched_keys()
        update_job(job_id, status="fetching", progress="starting")
        cands, report = lead_finder.find(
            need="linkedin" if p["channel"] == "linkedin" else "x", want=p["want"], days=p["days"],
            touched=keys, touched_names=names,
            exclude_keywords=find_cfg.get("exclude_keywords") or (),
            require_no_video=bool(find_cfg.get("require_no_video", True)),
            require_pricing=bool(find_cfg.get("require_pricing", True)),
            time_budget=int(find_cfg.get("time_budget_s") or 420),
            progress=lambda msg: update_job(job_id, progress=msg[:120]))
        update_find_run(job_id, candidates=cands, stage1=report)
        if not cands:
            update_job(job_id, status="done", report="Nothing new passed the checks. " + find_summary(report))
            return
        if routine_configured():
            update_job(job_id, status="scoring", progress="%d candidates, Claude is checking fit" % len(cands))
            fire_routine(get_job(job_id), token)
        else:
            added = add_found_leads(job_id, [{"key": c["key"]} for c in cands[:p["want"]]],
                                    note="Not checked by Claude (routine is off)")
            update_job(job_id, status="done", report="Added %d without Claude's check. %s"
                       % (added, find_summary(report)))
    except Exception as e:  # never kill the server from a background run
        log("find failed: %r" % e)
        update_job(job_id, status="failed", error=str(e)[:300])


def find_summary(report):
    bits = []
    for name, st in (report.get("sources") or {}).items():
        if st.get("listed"):
            bits.append("%s: %d launches, %d with a link, %d passed" % (
                name, st["listed"], st.get("with_contact", 0), st.get("passed", 0)))
    if report.get("errors"):
        bits.append("errors: " + "; ".join(report["errors"]))
    if report.get("stopped"):
        bits.append(report["stopped"])
    return " | ".join(bits)


def add_found_leads(job_id, keep, note=""):
    """Turn judged candidates into leads. `keep` = [{key, icp, note, tier}]."""
    run = next((r for r in load_find_runs() if r.get("job_id") == job_id), None)
    if not run:
        return 0
    by_key = {c["key"]: c for c in run.get("candidates") or []}
    stamp, added = now_str(), []
    mmdd = time.strftime("%m%d")
    with LOCK:
        leads = load_dm_leads()
        have = {l.get("id") for l in leads}
        taken, _ = touched_keys()
        order = max([l.get("order") or 0 for l in leads] + [0])
        for k in keep:
            c = by_key.get(k.get("key"))
            if not c or c["key"] in taken:
                continue
            base = (c["key"].split(":", 1)[1] if ":" in c["key"] else c["key"]).lower()
            lid = ("li" if run["channel"] == "linkedin" else "x") + "-%s-f%s-%s" % (
                short_campaign(run["campaign"]), mmdd, re.sub(r"[^a-z0-9_.-]", "", base)[:50])
            if lid in have:
                continue
            order += 1
            tier = k.get("tier") or c.get("tier")
            flag = "; ".join(x for x in (k.get("note"), note) if x)
            lead = {"id": lid, "channel": run["channel"], "campaign": run["campaign"],
                    "batch": "Found %s" % time.strftime("%b %d").replace(" 0", " "),
                    "name": c.get("maker") or "", "product": c.get("product") or "",
                    "meta": " · ".join(x for x in (tier, "score %s" % c.get("score"), c.get("source")) if x),
                    "flag": flag[:400], "headline": c.get("headline") or "", "site": c.get("site"),
                    "tagline": c.get("tagline") or "", "tier": tier, "score": c.get("score"),
                    "icp": k.get("icp") or "", "source": c.get("source"), "launch": c.get("launch"),
                    "fields": {"n": c.get("first") or "", "p": c.get("product") or ""},
                    "status": "ready", "order": order, "added_ts": stamp, "updated_ts": stamp,
                    "found_by": job_id}
            if run["channel"] == "linkedin":
                lead.update(kind="connect", profile_url=c.get("linkedin"))
            else:
                h = lead_x_handle(c.get("x"))
                lead.update(kind="message", handle=h, profile_url="https://x.com/" + (h or ""),
                            needs_message=True)
            leads.append(lead)
            have.add(lid)
            taken.add(c["key"])
            added.append(lid)
        save_dm_leads(leads)
    update_find_run(job_id, added=added)
    return len(added)


def lead_x_handle(url):
    m = re.search(r"(?:x|twitter)\.com/@?([A-Za-z0-9_]{1,15})", url or "", re.I)
    return m.group(1) if m else None


def agent_write_leads(job, body):
    keep = body.get("keep")
    if not isinstance(keep, list):
        return 400, {"error": "keep list required"}
    keep = [k for k in keep if isinstance(k, dict) and k.get("key")][:job["payload"].get("want", 20)]
    n = add_found_leads(job["id"], keep)
    drops = [d for d in (body.get("drop") or []) if isinstance(d, dict)][:200]
    update_find_run(job["id"], dropped=drops, report=str(body.get("report") or "")[:2000])
    return 200, {"ok": True, "added": n}


def find_add_unchecked(body):
    """The routine never answered: add the best candidates by score, flagged."""
    run = next((r for r in load_find_runs() if r.get("job_id") == body.get("job_id")), None)
    if not run:
        return 404, {"error": "run not found"}
    job = get_job(run["job_id"]) or {}
    if job.get("status") in ("created", "fetching", "scoring", "fired", "working") and job.get("expires", 0) > time.time():
        return 409, {"error": "Claude is still checking these"}
    n = add_found_leads(run["job_id"], [{"key": c["key"]} for c in (run.get("candidates") or [])[:run.get("want", 20)]],
                        note="Not checked by Claude")
    return 200, {"ok": True, "added": n}


def find_status():
    runs = load_find_runs()
    run = dict(runs[0]) if runs else None
    job = get_job(run["job_id"]) if run else None
    if run:
        run["candidate_count"] = len(run.get("candidates") or [])
        run["added_count"] = len(run.get("added") or [])
        run.pop("candidates", None)
    return {"run": run, "job": public_job(job) if job else None}


# ---------------------------------------------------------------- Write with Claude (dmwrite job)
#
# Leads with no message yet (a connection that just accepted, a found X lead)
# are drafted by the routine: one to three versions per person, written to the
# campaign's rules, which ride along in the payload from dm-campaigns.json.

def start_write_job(body):
    ids = set(body.get("ids") or []) if isinstance(body.get("ids"), list) else None
    live = {j["id"] for j in load_jobs() if j["kind"] == "dmwrite"
            and j["status"] in ("created", "fired", "working") and j.get("expires", 0) > time.time()}
    with LOCK:
        leads = load_dm_leads()
        todo = [l for l in leads if l.get("status") == "ready" and lead_kind(l) == "message"
                and l.get("needs_message") and l.get("writing_job") not in live
                and (not ids or l.get("id") in ids)
                and (not body.get("channel") or l.get("channel") == body.get("channel"))]
        if not todo:
            return 400, {"error": "no one is waiting for a message"}
        fired = []
        for start in range(0, len(todo), WRITE_CHUNK):
            chunk = todo[start:start + WRITE_CHUNK]
            job, token = create_job("dmwrite", {"lead_ids": [l["id"] for l in chunk],
                                                "note": str(body.get("note") or "")[:500]})
            for l in chunk:
                l["writing_job"] = job["id"]
            fired.append((job, token))
        save_dm_leads(leads)
    for job, token in fired:
        if not fire_routine(job, token):
            with LOCK:  # the run never started: don't leave leads showing "writing"
                leads = load_dm_leads()
                for l in leads:
                    if l.get("writing_job") == job["id"]:
                        l.pop("writing_job", None)
                save_dm_leads(leads)
    jobs = [public_job(get_job(j["id"])) for j, _ in fired]
    if all(j["status"] == "failed" for j in jobs):
        return 502, {"error": jobs[0].get("error") or "Claude could not be started", "jobs": jobs}
    return 200, {"ok": True, "job": jobs[0], "jobs": jobs, "leads": len(todo)}


def dm_payload_for_write(job):
    ids = set(job["payload"].get("lead_ids") or [])
    keep = ("id", "channel", "campaign", "name", "handle", "profile_url", "product", "tagline", "site",
            "headline", "meta", "flag", "note", "icp", "tier", "fields", "reply_text", "context",
            "fix_note", "previous_text")
    leads = [{k: l[k] for k in keep if l.get(k)} for l in load_dm_leads() if l.get("id") in ids]
    camps = load_dm_campaigns()
    used = {l.get("campaign") for l in leads}
    sends = _load(DM_SENDS_FILE, "sends")
    # His real first messages are the voice ground truth, the replied ones first.
    examples = sorted(sends, key=lambda s: not s.get("replied"))[:12]
    return {"job_id": job["id"], "kind": "dmwrite", "note": job["payload"].get("note"),
            "leads": leads,
            "campaigns": {c: camps[c] for c in used if c in camps},
            "sent_examples": [{"channel": s.get("channel"), "campaign": s.get("campaign"),
                               "text": s.get("text"), "replied": bool(s.get("replied")),
                               "edited_by_him": s.get("verbatim") is False} for s in examples],
            # His "Tell Claude" notes, newest first: standing rules for these campaigns.
            "feedback": [{k: n.get(k) for k in ("ts", "text", "campaign", "lead", "message") if n.get(k)}
                         for n in load_dm_feedback()
                         if not n.get("campaign") or n.get("campaign") in used][:DM_FEEDBACK_SENT],
            "write_to": "/agent/job/%s/dmwrite" % job["id"]}


def agent_write_dm(job, body):
    items = body.get("items")
    if not isinstance(items, list):
        return 400, {"error": "items list required"}
    allowed = set(job["payload"].get("lead_ids") or [])
    written = 0
    with LOCK:
        leads = load_dm_leads()
        by_id = {l["id"]: l for l in leads}
        for it in items:
            lead = by_id.get(it.get("id")) if isinstance(it, dict) else None
            if not lead or lead["id"] not in allowed:
                continue
            variants = [{"label": str(v.get("label") or "Message")[:40], "text": str(v.get("text"))[:DM_TEXT_MAX]}
                        for v in (it.get("variants") or []) if isinstance(v, dict) and str(v.get("text") or "").strip()]
            if it.get("flag"):
                lead["flag"] = "; ".join(x for x in (lead.get("flag"), str(it["flag"])[:300]) if x)
            if it.get("not_a_fit") and lead.get("status") == "ready":
                # The ICP gate: no message for someone outside the campaign's ICP.
                # Lands in Done with Claude's reason; "Back" in the app undoes it.
                lead["status"] = "skipped"
                lead["skip_reason"] = ("Not a fit (Claude): " + str(it["not_a_fit"]))[:200]
                lead["not_fit_ts"] = now_str()
                lead.pop("needs_message", None)
                lead.pop("writing_job", None)
                lead["updated_ts"] = now_str()
                continue
            if variants and lead.get("status") == "ready":
                lead["variants"] = variants[:3]
                lead["variant_index"] = 0
                lead.pop("needs_message", None)
                lead.pop("draft_text", None)
                lead.pop("fix_note", None)
                lead.pop("previous_text", None)
                lead["written_ts"] = now_str()
                written += 1
            lead.pop("writing_job", None)
            lead["updated_ts"] = now_str()
        save_dm_leads(leads)
    return 200, {"ok": True, "written": written}


def dm_cooldown_clear(body):
    ch = body.get("channel")
    if ch not in DM_CHANNELS:
        return 400, {"error": "channel must be linkedin or x"}
    with LOCK:
        st = load_dm_state()
        (st.get("cooldowns") or {}).pop(ch, None)
        save_dm_state(st)
        stats = dm_stats(load_dm_leads(), st)
    return 200, {"ok": True, "stats": stats}


# ---------------------------------------------------------------- Armory

class ArmoryError(Exception):
    pass


def armory_configured():
    return bool(ARMORY_URL and ARMORY_USER and ARMORY_PASS)


def armory(path, body=None, timeout=90):
    """Call Armory with the server's own credentials. Raises ArmoryError."""
    if not armory_configured():
        raise ArmoryError("Armory is not configured (ARMORY_URL / ARMORY_USER / ARMORY_PASS)")
    auth = base64.b64encode(("%s:%s" % (ARMORY_USER, ARMORY_PASS)).encode()).decode()
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(ARMORY_URL + path, data=data, method="POST" if data else "GET")
    req.add_header("Authorization", "Basic " + auth)
    req.add_header("ngrok-skip-browser-warning", "true")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        raise ArmoryError("Armory %s %s: %s" % (path, e.code, detail))
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise ArmoryError("Armory unreachable: %s" % e)
    except json.JSONDecodeError:
        raise ArmoryError("Armory returned non-JSON for %s" % path)


def fetch_tweet(tweet_id):
    """Full text + author for one tweet via Armory /twitter/tweet (~15 credits)."""
    resp = armory("/twitter/tweet", {"tweets": [tweet_id]})
    tweets = resp.get("tweets") or []
    return tweets[0] if tweets else None


# Paths Claude may reach through /agent/armory/... (read-only research routes).
AGENT_ARMORY_ALLOWED = ("/twitter/tweet", "/twitter/thread", "/twitter/replies",
                        "/twitter/user", "/twitter/search", "/twitter/credits")


# ---------------------------------------------------------------- watchlist

def parse_watchlist(path=WATCHLIST_FILE):
    """Return (active_handles, never_handles) from the scout watchlist markdown."""
    active, never = [], set()
    if not os.path.exists(path):
        return active, never
    section = ""
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            if line.startswith("## "):
                section = line.lower()
                continue
            m = re.match(r"\|\s*@([A-Za-z0-9_]{1,50})\s*\|", line)
            if not m:
                continue
            handle = m.group(1)
            cells = [c.strip().lower() for c in line.strip().strip("|").split("|")]
            status = cells[-1] if cells else ""
            if "never" in section:
                never.add(handle.lower())
            elif ("tier a" in section or "tier b" in section) and "dormant" not in status:
                if handle.lower() not in {h.lower() for h in active}:
                    active.append(handle)
    return active, never


# ---------------------------------------------------------------- jobs + routine webhook

def public_job(job):
    return {k: v for k, v in job.items() if k not in ("token_hash", "payload")}


def token_hash(token):
    return hmac.new(b"sidekick-job", token.encode(), "sha256").hexdigest()


def create_job(kind, payload):
    token = secrets.token_urlsafe(32)
    job = {
        "id": "job_" + uuid.uuid4().hex[:10],
        "kind": kind,
        "status": "created",
        "ts": now_str(),
        "expires": time.time() + JOB_TOKEN_TTL,
        "token_hash": token_hash(token),
        "payload": payload,
        "session_url": None,
        "error": None,
        "report": None,
    }
    with LOCK:
        jobs = load_jobs()
        jobs.insert(0, job)
        save_jobs(jobs)
    return job, token


def update_job(job_id, **fields):
    with LOCK:
        jobs = load_jobs()
        for j in jobs:
            if j["id"] == job_id:
                j.update(fields)
                save_jobs(jobs)
                return j
    return None


def get_job(job_id):
    return next((j for j in load_jobs() if j["id"] == job_id), None)


def routine_configured():
    return bool(ROUTINE_FIRE_URL and ROUTINE_TOKEN and PUBLIC_URL)


def fire_routine(job, token):
    """POST the Claude Code routine /fire endpoint. The text carries the job
    pointer + a one-job token; Claude pulls the payload from /agent/job/<id>."""
    if not routine_configured():
        update_job(job["id"], status="failed",
                   error="Claude routine not configured (ROUTINE_FIRE_URL / ROUTINE_TOKEN / SIDEKICK_PUBLIC_URL)")
        return False
    text = (
        "SIDEKICK JOB\n"
        "kind: %s\n"
        "job_id: %s\n"
        "base_url: %s\n"
        "job_token: %s\n"
        "Follow routine/ROUTINE.md in the repo. Send every request with headers "
        "'Authorization: Bearer <job_token>' and 'ngrok-skip-browser-warning: true'. "
        "Never post to X."
    ) % (job["kind"], job["id"], PUBLIC_URL, token)
    req = urllib.request.Request(ROUTINE_FIRE_URL, data=json.dumps({"text": text}).encode(), method="POST")
    req.add_header("Authorization", "Bearer " + ROUTINE_TOKEN)
    req.add_header("anthropic-version", "2023-06-01")
    req.add_header("Content-Type", "application/json")
    try:
        # The fire endpoint provisions a cloud session before it answers, which
        # took over 30s on 2026-09-26. The old timeout gave up while the run was
        # already starting, and the job was then marked failed - which made the
        # server reject that run's own callbacks, wasting the whole run.
        with urllib.request.urlopen(req, timeout=120) as r:
            resp = json.loads(r.read().decode("utf-8"))
        update_job(job["id"], status="fired", session_url=resp.get("claude_code_session_url"))
        return True
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        retry = e.headers.get("Retry-After")
        msg = "routine fire failed %s: %s" % (e.code, detail)
        if retry:
            msg += " (retry after %ss)" % retry
        update_job(job["id"], status="failed", error=msg)
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as e:
        # A timeout is not proof the fire failed: the run may already be starting.
        # Leave the job firable so its callbacks are still accepted, rather than
        # marking it failed and locking out a run that is about to call back.
        if isinstance(e, (TimeoutError, urllib.error.URLError)) and "timed out" in str(e):
            update_job(job["id"], status="fired",
                       error="fire response timed out; the run may still be live")
            return True
        update_job(job["id"], status="failed", error="routine fire failed: %s" % e)
    return False


def _norm_send(t):
    return re.sub(r"\s+", " ", (t or "").strip().lower())


def load_sends():
    """Accumulated real sends, seeded once from the repo baseline."""
    sends = _load(SENDS_FILE, "sends")
    if not sends and os.path.exists(SENDS_BASELINE):
        try:
            with open(SENDS_BASELINE) as fh:
                sends = json.load(fh)
            _save(SENDS_FILE, sends, "sends")
            log("voice corpus seeded with %d real sends" % len(sends))
        except Exception as e:
            log("voice baseline load failed: %r" % e)
            sends = []
    return sends


def record_send(item, verbatim=None):
    """Append one reply he actually sent. Called when an item is marked posted.

    `verbatim` says whether he sent a draft untouched (True) or typed/edited the
    wording himself (False). His own wording is the stronger training signal, so
    the flag is kept rather than collapsing both into one undifferentiated pile.
    """
    text = (item.get("posted_text") or "").strip()
    if not text:
        return
    with LOCK:
        sends = load_sends()
        if any(_norm_send(s.get("posted_text")) == _norm_send(text) for s in sends):
            return
        entry = {"post": (item.get("tweet_text") or item.get("text") or "")[:600],
                 "author": item.get("author"),
                 "url": item.get("tweet_url") or item.get("url"),
                 "posted_text": text, "ts": now_str()}
        if verbatim is None and item.get("sent_verbatim") is not None:
            verbatim = item["sent_verbatim"]
        if verbatim is not None:
            entry["verbatim"] = bool(verbatim)
        sends.insert(0, entry)
        _save(SENDS_FILE, sends[:SENDS_KEEP], "sends")


def add_send(body):
    """Log a reply he sent that never went through the queue.

    Replies get sent straight from X all the time. Without this the corpus only
    ever learns from posts that happened to be queued here.
    """
    text = str(body.get("posted_text") or "").strip()
    if not text:
        return 400, {"error": "posted_text required"}
    item = {"tweet_text": str(body.get("post") or "")[:600],
            "author": str(body.get("author") or "")[:100],
            "url": str(body.get("url") or "")[:500],
            "posted_text": text[:2000]}
    before = len(load_sends())
    record_send(item, verbatim=False)
    after = len(load_sends())
    if after == before:
        return 200, {"ok": True, "duplicate": True, "total": after}
    return 200, {"ok": True, "total": after}


# ---------------------------------------------------------------- people
#
# He replies to the same bounded set of builders, so what was said last time is
# worth remembering. The danger is obvious: a per-person log that only ever grows
# will eventually dominate the drafting context. Three limits keep it flat:
#
#   1. Only the authors in THIS job are ever sent. A batch of 11 items carries at
#      most 11 records, no matter how many people are on file.
#   2. Each record keeps the last PERSON_HISTORY interactions on disk and sends
#      only PERSON_HISTORY_SENT of them, each truncated.
#   3. The rolling `note` is one short line, rewritten rather than appended, so it
#      cannot creep. Nothing here grows with how long the system has been running.

PERSON_HISTORY = 8          # kept on disk per person
PERSON_HISTORY_SENT = 3     # sent to the writer per person
PERSON_POST_CHARS = 160
PERSON_REPLY_CHARS = 140
PERSON_NOTE_CHARS = 200
PEOPLE_MAX = 1000           # disk cap; context is bounded separately
PERSON_STALE_DAYS = 365     # one-off contacts older than this are prunable


def load_people():
    return _load(PEOPLE_FILE, "people")


def person_key(author):
    return handle_key(author)


def record_person(item):
    """Upsert the author of one posted item, keeping their history bounded."""
    key = person_key(item.get("author"))
    if not key:
        return
    with LOCK:
        people = load_people()
        rec = next((p for p in people if p.get("key") == key), None)
        if not rec:
            rec = {"key": key, "handle": str(item.get("author") or "").lstrip("@"),
                   "first_seen": now_str(), "replies": 0, "history": [], "note": ""}
            people.append(rec)
        if item.get("author_followers"):
            rec["followers"] = item["author_followers"]
        rec["last_seen"] = now_str()
        rec["replies"] = rec.get("replies", 0) + 1
        entry = {"ts": now_str(),
                 "post": (item.get("tweet_text") or item.get("text") or "")[:PERSON_POST_CHARS],
                 "reply": (item.get("posted_text") or "")[:PERSON_REPLY_CHARS]}
        if item.get("tweet_url") or item.get("url"):
            entry["url"] = item.get("tweet_url") or item.get("url")
        # Newest first, capped. Old interactions fall off rather than accumulate.
        rec["history"] = ([entry] + rec.get("history", []))[:PERSON_HISTORY]
        _save(PEOPLE_FILE, prune_people(people), "people")


def prune_people(people):
    """Keep the file from growing forever.

    This is disk hygiene, not a context control - the context is already bounded
    by only ever sending the current batch's authors. Someone replied to once,
    long ago, is not a relationship worth remembering; repeat contacts are kept
    regardless of age.
    """
    if len(people) <= PEOPLE_MAX:
        return people
    cutoff = (datetime.now() - timedelta(days=PERSON_STALE_DAYS)).strftime("%Y-%m-%d %H:%M:%S")
    keep = [p for p in people
            if (p.get("replies") or 0) > 1 or (p.get("last_seen") or "") >= cutoff]
    if len(keep) <= PEOPLE_MAX:
        return keep
    return sorted(keep, key=lambda p: (p.get("last_seen") or ""), reverse=True)[:PEOPLE_MAX]


def people_for(authors):
    """Bounded records for just these authors - never the whole file."""
    want = {person_key(a) for a in authors if person_key(a)}
    if not want:
        return []
    out = []
    for p in load_people():
        if p.get("key") not in want:
            continue
        out.append({"handle": p.get("handle"), "followers": p.get("followers"),
                    "replies": p.get("replies", 0), "last_seen": p.get("last_seen"),
                    "note": (p.get("note") or "")[:PERSON_NOTE_CHARS],
                    "history": p.get("history", [])[:PERSON_HISTORY_SENT]})
    return out


def update_person_notes(notes):
    """Let the writer keep one short line per person. Rewritten, never appended."""
    if not isinstance(notes, list):
        return 0
    n = 0
    with LOCK:
        people = load_people()
        by_key = {p.get("key"): p for p in people}
        for entry in notes:
            if not isinstance(entry, dict):
                continue
            rec = by_key.get(person_key(entry.get("handle")))
            if not rec:
                continue
            rec["note"] = str(entry.get("note", ""))[:PERSON_NOTE_CHARS]
            n += 1
        if n:
            _save(PEOPLE_FILE, people, "people")
    return n


def voice_examples():
    """Real sends - the voice ground truth for drafting.

    Newest first from the durable corpus, so archiving the queue can no longer
    shrink it. The live queue is still read first in case a send has not been
    recorded yet (e.g. posted_text edited directly in the extension).
    """
    out, seen = [], set()

    def add(post, author, text):
        k = _norm_send(text)
        if not k or k in seen:
            return
        seen.add(k)
        out.append({"post": (post or "")[:600], "author": author, "posted_text": text})

    for i in load_queue():
        if i.get("status") == "posted" and i.get("posted_text"):
            add(i.get("tweet_text") or i.get("text"), i.get("author"), i["posted_text"])
    for s in load_sends():
        if len(out) >= VOICE_EXAMPLES:
            break
        add(s.get("post"), s.get("author"), s.get("posted_text"))
    return out[:VOICE_EXAMPLES]


def start_draft_job(ids=None, account=None, note=""):
    """Start drafting, splitting large batches across several routine runs.

    One run per item is wasteful and one run for 100 items is unusable: at ~1.5KB
    an item plus its people record, a 100-item payload is ~55K tokens before the
    writer has read a single guide. DRAFT_CHUNK keeps each run's payload small
    enough to draft well, and a failure then costs one chunk instead of the batch.
    """
    fired = []
    with LOCK:
        items = load_queue()
        blocked = blocked_set()
        todo = [i for i in items if i.get("status") == "queued"
                and i.get("platform", "x") in ("x", "linkedin")
                and (not ids or i.get("id") in ids)
                and handle_key(i.get("author")) not in blocked]
        if not todo:
            return 400, {"error": "nothing queued to draft"}
        busy = {i["id"] for i in todo if i.get("drafting_job")}
        todo = [i for i in todo if i["id"] not in busy] or todo
        by_id = {i["id"]: i for i in items}
        for start in range(0, len(todo), DRAFT_CHUNK):
            chunk = todo[start:start + DRAFT_CHUNK]
            job, token = create_job("draft", {
                "item_ids": [i["id"] for i in chunk],
                "account": account or "",
                "note": note[:500],
            })
            for i in chunk:
                by_id[i["id"]]["drafting_job"] = job["id"]
            fired.append((job, token))
        save_queue(items)
    for job, token in fired:
        fire_routine(job, token)
    jobs = [public_job(get_job(j["id"])) for j, _ in fired]
    # `job` stays the first one so existing callers keep working.
    return 200, {"ok": True, "job": jobs[0], "jobs": jobs, "chunks": len(jobs),
                 "items": sum(len(j["payload"]["item_ids"]) for j, _ in fired)
                 if fired and "payload" in fired[0][0] else None}


def handled_tweets():
    """Every tweet already in the queue, whatever became of it.

    A post he has replied to, skipped, or is mid-draft on is finished business.
    It used to come back as a scout candidate and get queued a second time, which
    cost a whole drafting run for a reply he had already sent.
    """
    ids, urls = set(), set()
    for i in load_queue():
        if i.get("tweet_id"):
            ids.add(str(i["tweet_id"]))
        u = i.get("tweet_url") or i.get("url")
        if u:
            urls.add(clean_tweet_url(u))
    return ids, urls


def is_handled(cand, ids, urls):
    tid = cand.get("tweet_id") or tweet_id_from_url(cand.get("url") or "")
    if tid and str(tid) in ids:
        return True
    return bool(cand.get("url")) and clean_tweet_url(cand["url"]) in urls


def scout_rank(c):
    """Lower is better: fresh, uncrowded, with a bonus for a view/engagement gap."""
    bonus = 6 if c.get("high_view_low_eng") else 0
    return (c.get("replies") or 0) + c["age_hours"] * 2 - bonus


def run_scout_stage1(job_id, token):
    """Background thread: watchlist OR-search via Armory, 24h window, 1 per author."""
    try:
        handles, never = parse_watchlist()
        if not handles:
            raise ArmoryError("watchlist is empty or missing: %s" % WATCHLIST_FILE)
        want = (get_job(job_id) or {}).get("payload", {}).get("want") or 20
        max_cands = max(SCOUT_MAX_CANDIDATES, min(180, want * 3))
        credits = None
        try:
            credits = armory("/twitter/credits").get("credits_remaining")
        except ArmoryError:
            pass
        cutoff = datetime.now(timezone.utc) - timedelta(hours=SCOUT_WINDOW_HOURS)
        blocked = blocked_set()
        done_ids, done_urls = handled_tweets()
        pool, errors = {}, []
        for n in range(0, len(handles), SCOUT_CHUNK):
            chunk = handles[n:n + SCOUT_CHUNK]
            query = "(" + " OR ".join("from:" + h for h in chunk) + ") -filter:replies"
            update_job(job_id, status="fetching", progress="chunk %d/%d" % (
                n // SCOUT_CHUNK + 1, (len(handles) + SCOUT_CHUNK - 1) // SCOUT_CHUNK))
            try:
                resp = armory("/twitter/search", {"keywords": [query], "limit": 20})
                tweets = resp.get("tweets") or []
                # Truncation check from the scout guide: full page still inside window.
                times = [parse_x_time(t.get("created_at")) for t in tweets]
                times = [t for t in times if t]
                if len(tweets) >= 20 and times and min(times) > cutoff:
                    resp = armory("/twitter/search", {"keywords": [query], "limit": 40})
                    tweets = resp.get("tweets") or []
                if resp.get("credits_remaining") is not None:
                    credits = resp["credits_remaining"]
            except ArmoryError as e:
                errors.append(str(e))
                if "credit_floor" in str(e) or " 429" in str(e):
                    break
                continue
            for t in tweets:
                created = parse_x_time(t.get("created_at"))
                author = str(t.get("author") or "")
                if not created or created < cutoff or not t.get("url"):
                    continue
                if author.lower() in never or author.lower() in blocked:
                    continue
                if is_handled({"url": t["url"], "tweet_id": tweet_id_from_url(t["url"])},
                              done_ids, done_urls):
                    continue          # already replied to, skipped, or being drafted
                age_h = (datetime.now(timezone.utc) - created).total_seconds() / 3600
                cand = {
                    "url": clean_tweet_url(t["url"]),
                    "tweet_id": tweet_id_from_url(t["url"]),
                    "author": author,
                    "author_followers": t.get("author_followers"),
                    "text": t.get("text", ""),
                    "age_hours": round(age_h, 1),
                    "likes": t.get("likes"), "replies": t.get("replies"),
                    "retweets": t.get("retweets"), "views": t.get("views"),
                    "created_at": t.get("created_at"),
                }
                cand["high_view_low_eng"], cand["view_gap"] = engagement_gap(
                    t.get("views"), t.get("likes"), t.get("replies"), t.get("retweets"))
                # Max 1 post per author: prefer a high-views/low-engagement post,
                # then the fresher, less crowded one.
                prev = pool.get(author.lower())
                if not prev or scout_rank(cand) < scout_rank(prev):
                    pool[author.lower()] = cand
        # Mixed pool: up to half high-views/low-engagement posts (best gap first),
        # the rest by freshness and low crowding, so gap posts are well represented
        # without crowding out everything else.
        gap = sorted((c for c in pool.values() if c["high_view_low_eng"]),
                     key=lambda c: -c["view_gap"])[:max_cands // 2]
        gap_urls = {c["url"] for c in gap}
        rest = sorted((c for c in pool.values() if c["url"] not in gap_urls), key=scout_rank)
        cands = (gap + rest)[:max_cands]
        with LOCK:
            runs = load_scout_runs()
            for r in runs:
                if r["job_id"] == job_id:
                    r.update(candidates=cands, credits_remaining=credits, errors=errors,
                             handles_checked=len(handles))
            save_scout_runs(runs)
        if not cands:
            update_job(job_id, status="done", report="No posts in the last 24h from the watchlist. "
                       "Not lowering the bar to stale posts." + (" Errors: " + "; ".join(errors) if errors else ""))
            return
        update_job(job_id, status="scoring", progress="%d candidates" % len(cands))
        job = get_job(job_id)
        fire_routine(job, token)
    except Exception as e:  # never kill the server from a background run
        log("scout failed: %r" % e)
        update_job(job_id, status="failed", error=str(e))


def start_scout_job(want=20):
    if not armory_configured():
        return 400, {"error": "Armory is not configured on the server"}
    running = next((j for j in load_jobs() if j["kind"] == "scout"
                    and j["status"] in ("created", "fetching", "scoring", "fired", "working")
                    and j.get("expires", 0) > time.time()), None)
    if running:
        return 409, {"error": "a scout run is already in progress", "job": public_job(running)}
    # How many posts he wants this session (the phone's number box). The
    # candidate pool grows with it so the shortlist still has room to choose.
    want = clamp_int(want, 1, 60, 20)
    job, token = create_job("scout", {"want": want})
    with LOCK:
        runs = load_scout_runs()
        runs.insert(0, {"id": "run_" + uuid.uuid4().hex[:8], "job_id": job["id"], "ts": now_str(),
                        "want": want, "candidates": [], "shortlist": [], "report": None})
        save_scout_runs(runs)
    threading.Thread(target=run_scout_stage1, args=(job["id"], token), daemon=True).start()
    return 200, {"ok": True, "job": public_job(get_job(job["id"]))}


# ---------------------------------------------------------------- share ingest

def ingest_share(body):
    """Android share sheet -> reply queue (tweet link) or outreach (profile link)."""
    raw = " ".join(str(body.get(k) or "") for k in ("url", "text", "title"))
    url = str(body.get("url") or "").strip() or first_url(raw)
    note = str(body.get("note") or "")[:500]
    if not url:
        return 400, {"error": "no link found in what was shared"}
    tid = tweet_id_from_url(url)
    if tid and re.search(r"(?:x|twitter)\.com/", url):
        turl = clean_tweet_url(url)
        text, author, followers, missing = str(body.get("tweet_text") or ""), "", None, False
        m = re.search(r"(?:x|twitter)\.com/([A-Za-z0-9_]{1,50})/status", turl)
        author = "@" + m.group(1) if m else ""
        fetch_error = None
        if not text:
            try:
                t = fetch_tweet(tid)
                if t:
                    text = t.get("text") or ""
                    if t.get("author"):
                        author = "@" + str(t["author"]).lstrip("@")
                    followers = t.get("author_followers")
            except ArmoryError as e:
                fetch_error = str(e)
        if not text:
            missing = True
        if handle_key(author) in blocked_set():
            return 409, {"error": "%s is on your block list" % author, "kind": "reply", "blocked": True}
        with LOCK:
            code, resp = queue_add({"platform": "x", "tweet_url": turl, "tweet_text": text,
                                    "author": author, "author_followers": followers,
                                    "note": note, "text_missing": missing, "source": "android_share"})
        resp["kind"] = "reply"
        if fetch_error:
            resp["warning"] = "queued without text (Claude will fetch it): " + fetch_error
        return code, resp
    handle = normalize_x_handle(url) if re.search(r"(?:x|twitter)\.com/", url) else None
    if handle:
        with LOCK:
            code, resp = outreach_add({"handle": handle, "source": "android_share",
                                       "reason": str(body.get("reason") or "shared_from_phone")})
        resp["kind"] = "outreach"
        resp["handle"] = handle
        return code, resp
    if linkedin_slug(url):
        # A LinkedIn profile, not a post: save it for the next LinkedIn batch.
        with LOCK:
            code, resp = outreach_add_linkedin({"profile_url": url, "note": note,
                                                "source": "android_share"})
        resp["kind"] = "outreach"
        resp["platform"] = "linkedin"
        resp["handle"] = linkedin_slug(url)
        return code, resp
    if "linkedin.com" in url or "reddit.com" in url:
        platform = "linkedin" if "linkedin.com" in url else "reddit"
        text = str(body.get("text") or body.get("title") or url)
        with LOCK:
            code, resp = queue_add({"platform": platform, "url": url, "text": text, "note": note})
        resp["kind"] = "reply"
        return code, resp
    return 400, {"error": "not an X post or profile link: " + url[:120]}


# ---------------------------------------------------------------- agent (Claude) writes

def agent_job_payload(job):
    if job["kind"] == "draft":
        ids = set(job["payload"].get("item_ids", []))
        items = [i for i in load_queue() if i.get("id") in ids]
        return {"job_id": job["id"], "kind": "draft", "account": job["payload"].get("account"),
                "note": job["payload"].get("note"), "items": items,
                "voice_examples": voice_examples(),
                # Only the authors in this batch, so this cannot grow over time.
                "people": people_for(i.get("author") for i in items),
                "blocked_authors": sorted(blocked_set()),
                "write_to": "/agent/job/%s/drafts" % job["id"]}
    if job["kind"] == "dmwrite":
        return dm_payload_for_write(job)
    if job["kind"] == "leadfind":
        run = next((r for r in load_find_runs() if r["job_id"] == job["id"]), None) or {}
        camp = load_dm_campaigns().get(job["payload"].get("campaign"), {})
        return {"job_id": job["id"], "kind": "leadfind", "campaign": job["payload"].get("campaign"),
                "channel": job["payload"].get("channel"), "want": job["payload"].get("want"),
                "rules": camp, "candidates": run.get("candidates") or [],
                "write_to": "/agent/job/%s/leads" % job["id"]}
    run = next((r for r in load_scout_runs() if r["job_id"] == job["id"]), None)
    return {"job_id": job["id"], "kind": "scout",
            "candidates": run["candidates"] if run else [],
            "want": (run or {}).get("want") or 20,
            "window_hours": SCOUT_WINDOW_HOURS,
            "write_to": "/agent/job/%s/scout" % job["id"]}


def agent_write_drafts(job, body):
    results = body.get("items")
    if not isinstance(results, list):
        return 400, {"error": "items list required"}
    # One short rewritten line per person; it replaces, so it cannot creep.
    noted = update_person_notes(body.get("people_notes"))
    allowed = set(job["payload"].get("item_ids", []))
    written, skipped = 0, 0
    with LOCK:
        items = load_queue()
        by_id = {i["id"]: i for i in items}
        for r in results:
            it = by_id.get(r.get("id"))
            if not it or it["id"] not in allowed:
                continue
            if r.get("tweet_text") and it.get("text_missing"):
                it["tweet_text"] = str(r["tweet_text"])[:4000]
                it.pop("text_missing", None)
            drafts = [{"text": str(d.get("text", ""))[:1000], "angle": str(d.get("angle", ""))[:300]}
                      for d in (r.get("drafts") or []) if isinstance(d, dict) and d.get("text")]
            if isinstance(r.get("avery_reference"), dict):
                it["avery_reference"] = {k: str(r["avery_reference"].get(k, ""))[:600]
                                         for k in ("example", "pattern", "template", "source_url")}
            if r.get("agent_note"):
                it["agent_note"] = str(r["agent_note"])[:500]
            if drafts and it.get("status") == "queued":
                it["drafts"] = drafts[:6]
                it["status"] = "drafted"
                it["drafted_ts"] = now_str()
                written += 1
            elif not drafts:
                skipped += 1
            it.pop("drafting_job", None)
        save_queue(items)
    return 200, {"ok": True, "written": written, "skipped": skipped, "people_noted": noted}


def agent_write_scout(job, body):
    shortlist = body.get("shortlist")
    if not isinstance(shortlist, list):
        return 400, {"error": "shortlist list required"}
    with LOCK:
        runs = load_scout_runs()
        run = next((r for r in runs if r["job_id"] == job["id"]), None)
        if not run:
            return 404, {"error": "scout run not found"}
        known = {c["url"]: c for c in run.get("candidates", [])}
        out = []
        for s in shortlist:
            url = clean_tweet_url(str(s.get("url", "")))
            base = known.get(url)
            if not base:
                continue  # Claude may only rank what Stage 1 fetched
            out.append(dict(base, **{
                "score": s.get("score"),
                "reply_signal": str(s.get("reply_signal", ""))[:200],
                "summary": str(s.get("summary", ""))[:300],
                "suggested_move": str(s.get("suggested_move", ""))[:120],
                "why": str(s.get("why", ""))[:300],
            }))
        run["shortlist"] = out
        run["report"] = str(body.get("report", ""))[:2000]
        save_scout_runs(runs)
    return 200, {"ok": True, "shortlisted": len(out)}


def scout_dismiss(body):
    """Hide one scout candidate without blocking its author.

    Skipping a post and never wanting to hear from someone again are different
    decisions; blocking was the only way to clear a card, which was too blunt.
    The flag lives on the run so it survives a reload and stays scoped to it.
    """
    urls = {clean_tweet_url(u) for u in (body.get("urls") or [])}
    if body.get("url"):
        urls.add(clean_tweet_url(body["url"]))
    urls.discard("")
    if not urls:
        return 400, {"error": "url or urls required"}
    run_id = body.get("run_id")
    with LOCK:
        runs = load_scout_runs()
        run = next((r for r in runs if r["id"] == run_id), runs[0] if runs else None)
        if not run:
            return 404, {"error": "no scout run"}
        hit = 0
        for key in ("shortlist", "candidates"):
            for c in run.get(key, []):
                if c.get("url") in urls:
                    c["dismissed"] = True
                    hit += 1
        save_scout_runs(runs)
    return 200, {"ok": True, "dismissed": hit}


def scout_undismiss(body):
    """Undo a skip, so a mis-tap is not permanent."""
    urls = {clean_tweet_url(u) for u in (body.get("urls") or [])}
    if body.get("url"):
        urls.add(clean_tweet_url(body["url"]))
    urls.discard("")
    if not urls:
        return 400, {"error": "url or urls required"}
    with LOCK:
        runs = load_scout_runs()
        run = next((r for r in runs if r["id"] == body.get("run_id")), runs[0] if runs else None)
        if not run:
            return 404, {"error": "no scout run"}
        for key in ("shortlist", "candidates"):
            for c in run.get(key, []):
                if c.get("url") in urls:
                    c.pop("dismissed", None)
        save_scout_runs(runs)
    return 200, {"ok": True}


def scout_pick(body):
    urls = {clean_tweet_url(u) for u in (body.get("urls") or [])}
    run_id = body.get("run_id")
    runs = load_scout_runs()
    run = next((r for r in runs if r["id"] == run_id), runs[0] if runs else None)
    if not run or not urls:
        return 400, {"error": "run and urls required"}
    added, ids, skipped_dupes = 0, [], []
    pool = {c["url"]: c for c in run.get("shortlist", []) + run.get("candidates", [])}
    with LOCK:
        for u in urls:
            c = pool.get(u)
            if not c or handle_key(c.get("author")) in blocked_set():
                continue
            note = "source: x-reply-scout"
            if c.get("suggested_move"):
                note += " | suggested: %s" % c["suggested_move"]
            if c.get("reply_signal"):
                note += " | signal: %s" % c["reply_signal"]
            code, resp = queue_add({"platform": "x", "tweet_url": c["url"], "tweet_text": c.get("text", ""),
                                    "author": "@" + c["author"].lstrip("@"),
                                    "author_followers": c.get("author_followers"),
                                    "note": note, "source": "scout"})
            if resp.get("id"):
                if resp.get("duplicate"):
                    # Already in the queue in some state. Never hand it to a
                    # drafting run again - that is what wasted the runs.
                    skipped_dupes.append(resp.get("status") or "duplicate")
                    continue
                ids.append(resp["id"])
                added += 1
    result = {"ok": True, "added": added, "ids": ids}
    if skipped_dupes:
        result["already_handled"] = len(skipped_dupes)
    if body.get("draft") and ids:
        code, dj = start_draft_job(ids=ids, account=body.get("account"))
        result["draft_job"] = dj.get("job")
        result["draft_error"] = dj.get("error")
    return 200, result


# ---------------------------------------------------------------- auth

_fails = {}  # client -> [timestamps]


def client_id(handler):
    fwd = handler.headers.get("X-Forwarded-For", "")
    return fwd.split(",")[0].strip() or handler.client_address[0]


def check_app_key(handler):
    if not APP_PASSWORD:
        return False
    cid = client_id(handler)
    recent = [t for t in _fails.get(cid, []) if t > time.time() - 600]
    if len(recent) >= 10:
        return False  # 10 wrong passwords in 10 minutes: lock this client out for a while
    supplied = handler.headers.get("X-Sidekick-Key", "")
    if supplied and hmac.compare_digest(supplied.encode(), APP_PASSWORD.encode()):
        return True
    recent.append(time.time())
    _fails[cid] = recent
    return False


def check_job_token(handler, job):
    auth = handler.headers.get("Authorization", "")
    if not auth.startswith("Bearer ") or not job:
        return False
    if job.get("expires", 0) < time.time() or job.get("status") in ("done", "failed"):
        return False
    return hmac.compare_digest(token_hash(auth[7:].strip()), job.get("token_hash", ""))


# ---------------------------------------------------------------- HTTP plumbing

class BaseHandler(BaseHTTPRequestHandler):
    timeout = 15
    protocol_version = "HTTP/1.1"

    def handle(self):
        try:
            super().handle()
        except Exception:
            pass

    def cors_origins(self):
        return ()

    def _cors(self):
        origin = self.headers.get("Origin", "")
        if origin in self.cors_origins():
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers",
                             "Content-Type, X-Sidekick-Key, ngrok-skip-browser-warning, If-None-Match")
            # The app only starts sending If-None-Match once it can read an ETag,
            # so a phone on a newer app never breaks against an older server.
            self.send_header("Access-Control-Expose-Headers", "ETag")
            # Every call carries custom headers, so each needs a CORS preflight.
            # Caching it (Chrome allows 2h) halves the round trips on mobile data.
            self.send_header("Access-Control-Max-Age", "7200")

    def _json(self, code, payload):
        """Sends JSON. Light on a phone on mobile data: a GET whose answer has not
        changed since the app's last copy is a bodyless 304, and anything else
        over 1KB is gzipped (the queue and DM list shrink about 5x)."""
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        etag = None
        if code == 200 and self.command == "GET":
            etag = '"%s"' % hashlib.sha1(body).hexdigest()[:20]
            if self.headers.get("If-None-Match") == etag:
                self.send_response(304)
                self._cors()
                self.send_header("ETag", etag)
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return
        gz = len(body) > 1024 and "gzip" in (self.headers.get("Accept-Encoding") or "")
        if gz:
            body = gzip.compress(body, 5)
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        if gz:
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        if etag:
            self.send_header("ETag", etag)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length <= 0 or length > 2_000_000:
                return None
            data = json.loads(self.rfile.read(length).decode("utf-8"))
            return data if isinstance(data, dict) else None
        except (ValueError, json.JSONDecodeError):
            return None

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.server_name_tag, fmt % args))


class LegacyHandler(BaseHandler):
    """Byte-for-byte the queue-server.py API, for the Chrome extension."""
    server_name_tag = "queue"

    def cors_origins(self):
        return LEGACY_ORIGINS

    def do_GET(self):
        with LOCK:
            if self.path == "/health":
                return self._json(200, health_counts())
            if self.path == "/queue":
                return self._json(200, {"items": load_queue()})
            if self.path == "/outreach":
                return self._json(200, {"items": load_outreach()})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        body = self._body()
        with LOCK:
            if self.path == "/queue/clear-done":
                return self._json(*queue_clear_done())
            if not body:
                return self._json(400, {"error": "json body required"})
            if self.path == "/queue/add":
                return self._json(*queue_add(body))
            if self.path == "/queue/update":
                return self._json(*queue_update(body))
            if self.path == "/outreach/add":
                return self._json(*outreach_add(body))
        self._json(404, {"error": "not found"})


STATIC_TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
                ".css": "text/css; charset=utf-8", ".webmanifest": "application/manifest+json",
                ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
                ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8"}


class AppHandler(BaseHandler):
    server_name_tag = "app"

    def cors_origins(self):
        return EXTRA_ORIGINS

    # ---- routing
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/" and not ARMORY_PASSTHROUGH:
            return self._redirect("/app/")
        if path.startswith("/app"):
            return self._static(path)
        if path.startswith("/api/"):
            return self._api("GET", path)
        if path.startswith("/agent/"):
            return self._agent("GET", path)
        return self._passthrough("GET")

    def do_POST(self):
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            return self._api("POST", path)
        if path.startswith("/agent/"):
            return self._agent("POST", path)
        return self._passthrough("POST")

    def _redirect(self, where):
        self.send_response(302)
        self.send_header("Location", where)
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---- static PWA
    def _static(self, path):
        rel = path[len("/app"):].lstrip("/")
        if rel in ("", "share") or rel.startswith("share"):
            rel = "index.html"
        full = os.path.realpath(os.path.join(APP_DIR, rel))
        if not full.startswith(os.path.realpath(APP_DIR) + os.sep) or not os.path.isfile(full):
            return self._json(404, {"error": "not found"})
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", STATIC_TYPES.get(os.path.splitext(full)[1], "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        # sw.js must be re-checked so app updates land; the rest can revalidate too.
        self.send_header("Cache-Control", "no-cache")
        if rel == "sw.js":
            self.send_header("Service-Worker-Allowed", "/app/")
        self.end_headers()
        self.wfile.write(data)

    # ---- app API (password)
    def _api(self, method, path):
        if not APP_PASSWORD:
            return self._json(503, {"error": "server has no SIDEKICK_APP_PASSWORD set"})
        if not check_app_key(self):
            time.sleep(0.5)
            return self._json(401, {"error": "wrong or missing password"})
        body = self._body() if method == "POST" else None
        if method == "POST" and body is None and path not in ("/api/queue/clear-done", "/api/scout"):
            return self._json(400, {"error": "json body required"})
        body = body or {}
        try:
            if method == "GET":
                if path == "/api/health":
                    with LOCK:
                        h = health_counts()
                        dm = dm_stats(load_dm_leads(), load_dm_state())
                    h.update(armory=armory_configured(), routine=routine_configured(),
                             watchlist=len(parse_watchlist()[0]),
                             sends=len(load_sends()),
                             dm=True, dm_ready={ch: dm[ch]["ready"] for ch in DM_CHANNELS},
                             # Here, not in /api/dm: its clock ticks every check, and
                             # that would defeat the 304s on the big DM list.
                             accept_watch=accept_status())
                    return self._json(200, h)
                if path == "/api/dm":
                    with LOCK:
                        return self._json(200, dm_view())
                if path == "/api/leads/find":
                    with LOCK:
                        return self._json(200, find_status())
                if path == "/api/queue":
                    return self._json(200, {"items": load_queue()})
                if path == "/api/outreach":
                    return self._json(200, {"items": load_outreach()})
                if path == "/api/people":
                    with LOCK:
                        return self._json(200, {"people": sorted(
                            load_people(), key=lambda p: -(p.get("replies") or 0))})
                if path == "/api/blocklist":
                    return self._json(200, {"items": load_blocklist()})
                if path == "/api/jobs":
                    return self._json(200, {"jobs": [public_job(j) for j in load_jobs()[:20]]})
                if path == "/api/scout":
                    with LOCK:
                        runs = load_scout_runs()
                        run = runs[0] if runs else None
                        if run:
                            # Hide anything since queued, replied to or skipped, so an
                            # older run stops offering finished business.
                            ids, urls = handled_tweets()
                            run = dict(run)
                            had_shortlist = bool(run.get("shortlist"))
                            hidden = 0
                            for k in ("shortlist", "candidates"):
                                raw = run.get(k) or []
                                run[k] = [c for c in raw if not is_handled(c, ids, urls)]
                                if k == "shortlist":
                                    hidden = len(raw) - len(run[k])
                            run["handled_hidden"] = hidden
                            # Tell the app the shortlist is used up rather than absent,
                            # so it does not fall back to raw unranked candidates.
                            run["shortlist_done"] = had_shortlist and not run["shortlist"]
                    job = get_job(run["job_id"]) if run else None
                    return self._json(200, {"run": run, "job": public_job(job) if job else None})
                return self._json(404, {"error": "not found"})
            if path == "/api/share":
                return self._json(*ingest_share(body))
            if path == "/api/queue/update":
                with LOCK:
                    return self._json(*queue_update(body))
            if path == "/api/queue/clear-done":
                with LOCK:
                    return self._json(*queue_clear_done())
            if path == "/api/outreach/add":
                with LOCK:
                    if linkedin_slug(str(body.get("profile_url") or body.get("url") or "")):
                        return self._json(*outreach_add_linkedin(body))
                    return self._json(*outreach_add(body))
            if path == "/api/outreach/update":
                with LOCK:
                    return self._json(*outreach_update(body))
            if path == "/api/dm/update":
                return self._json(*dm_update(body))
            if path == "/api/dm/failed":
                return self._json(*dm_failed(body))
            if path == "/api/dm/cooldown/clear":
                return self._json(*dm_cooldown_clear(body))
            if path == "/api/draft":
                ids = body.get("ids") if isinstance(body.get("ids"), list) else None
                return self._json(*start_draft_job(ids, body.get("account"), str(body.get("note") or "")))
            if path == "/api/scout":
                return self._json(*start_scout_job(body.get("want")))
            if path == "/api/leads/find":
                return self._json(*start_find_job(body))
            if path == "/api/leads/find/add-unchecked":
                return self._json(*find_add_unchecked(body))
            if path == "/api/dm/write":
                return self._json(*start_write_job(body))
            if path == "/api/dm/feedback":
                return self._json(*dm_feedback(body))
            if path == "/api/dm/accept-check":
                return self._json(*accept_check("phone"))
            if path == "/api/block":
                with LOCK:
                    return self._json(*block_handle(body))
            if path == "/api/unblock":
                with LOCK:
                    return self._json(*unblock_handle(body))
            if path == "/api/scout/pick":
                return self._json(*scout_pick(body))
            if path == "/api/sends/add":
                return self._json(*add_send(body))
            if path == "/api/draft/reject":
                return self._json(*reject_draft(body))
            if path == "/api/scout/dismiss":
                return self._json(*scout_dismiss(body))
            if path == "/api/scout/undismiss":
                return self._json(*scout_undismiss(body))
            return self._json(404, {"error": "not found"})
        except Exception as e:
            log("api error %s: %r" % (path, e))
            return self._json(500, {"error": "server error: %s" % e})

    # ---- Claude callbacks (per-job token)
    def _agent(self, method, path):
        m = re.match(r"^/agent/job/(job_[a-f0-9]{10})(?:/(drafts|scout|leads|dmwrite|done))?$", path)
        am = re.match(r"^/agent/armory/(job_[a-f0-9]{10})(/twitter/[a-z/]+)$", path)
        job_id = (m or am).group(1) if (m or am) else None
        job = get_job(job_id) if job_id else None
        if not check_job_token(self, job):
            time.sleep(0.5)
            return self._json(401, {"error": "bad, expired or finished job token"})
        body = self._body() if method == "POST" else None
        try:
            if am:
                sub = am.group(2)
                if sub not in AGENT_ARMORY_ALLOWED:
                    return self._json(403, {"error": "armory route not allowed: " + sub})
                try:
                    return self._json(200, armory(sub, body if method == "POST" else None))
                except ArmoryError as e:
                    return self._json(502, {"error": str(e)})
            action = m.group(2)
            if method == "GET" and not action:
                if job["status"] == "fired":
                    update_job(job["id"], status="working")
                with LOCK:
                    return self._json(200, agent_job_payload(job))
            if method != "POST" or body is None:
                return self._json(400, {"error": "json body required"})
            if action == "drafts" and job["kind"] == "draft":
                return self._json(*agent_write_drafts(job, body))
            if action == "scout" and job["kind"] == "scout":
                return self._json(*agent_write_scout(job, body))
            if action == "leads" and job["kind"] == "leadfind":
                return self._json(*agent_write_leads(job, body))
            if action == "dmwrite" and job["kind"] == "dmwrite":
                return self._json(*agent_write_dm(job, body))
            if action == "done":
                if job["kind"] == "draft":
                    with LOCK:  # release anything Claude did not write back
                        items = load_queue()
                        for i in items:
                            if i.get("drafting_job") == job["id"]:
                                i.pop("drafting_job", None)
                        save_queue(items)
                if job["kind"] == "dmwrite":
                    with LOCK:
                        leads = load_dm_leads()
                        for l in leads:
                            if l.get("writing_job") == job["id"]:
                                l.pop("writing_job", None)
                        save_dm_leads(leads)
                if job["kind"] == "leadfind" and body.get("failed"):
                    # Claude could not judge them: keep the best by score, flagged.
                    run = next((r for r in load_find_runs() if r["job_id"] == job["id"]), {})
                    if not run.get("added"):
                        add_found_leads(job["id"], [{"key": c["key"]} for c in
                                                    (run.get("candidates") or [])[:job["payload"].get("want", 20)]],
                                        note="Not checked by Claude (the check failed)")
                update_job(job["id"], status="failed" if body.get("failed") else "done",
                           report=str(body.get("report", ""))[:4000], finished=now_str())
                return self._json(200, {"ok": True})
            return self._json(400, {"error": "action does not match job kind"})
        except Exception as e:
            log("agent error %s: %r" % (path, e))
            return self._json(500, {"error": "server error: %s" % e})

    # ---- optional: keep Armory reachable on the same ngrok URL
    def _passthrough(self, method):
        if not ARMORY_PASSTHROUGH:
            return self._json(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length", 0) or 0)
        data = self.rfile.read(length) if length > 0 else None
        req = urllib.request.Request(ARMORY_PASSTHROUGH + self.path, data=data, method=method)
        for h in ("Authorization", "Content-Type", "Accept", "X-Armory-Token"):
            if self.headers.get(h):
                req.add_header(h, self.headers[h])
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                code, headers, payload = r.status, r.headers, r.read()
        except urllib.error.HTTPError as e:
            code, headers, payload = e.code, e.headers, e.read()
        except (urllib.error.URLError, OSError) as e:
            return self._json(502, {"error": "armory passthrough failed: %s" % e})
        self.send_response(code)
        self.send_header("Content-Type", headers.get("Content-Type", "application/json"))
        self.send_header("Content-Length", str(len(payload)))
        if headers.get("WWW-Authenticate"):
            self.send_header("WWW-Authenticate", headers["WWW-Authenticate"])
        self.end_headers()
        self.wfile.write(payload)


def serve(port, handler):
    httpd = ThreadingHTTPServer(("127.0.0.1", port), handler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    if not APP_PASSWORD:
        log("WARNING: SIDEKICK_APP_PASSWORD is not set - the app API refuses every request.")
    elif len(APP_PASSWORD) < 12:
        log("WARNING: SIDEKICK_APP_PASSWORD is short. Use 12+ random characters; the app port is public via ngrok.")
    if LEGACY_PORT:
        serve(LEGACY_PORT, LegacyHandler)
        log("extension queue  http://127.0.0.1:%d  (local only, never expose)" % LEGACY_PORT)
    serve(APP_PORT, AppHandler)
    log("phone app + API  http://127.0.0.1:%d/app/  (expose this one via ngrok)" % APP_PORT)
    log("data dir %s | armory %s | routine %s | public url %s" % (
        DATA_DIR, "on" if armory_configured() else "OFF", "on" if routine_configured() else "OFF",
        PUBLIC_URL or "(unset)"))
    if accept_configured():
        threading.Thread(target=accept_loop, daemon=True).start()
        log("LinkedIn accepts: checking %s every %d min" % (LI_ACCEPT_EMAIL, LI_ACCEPT_EVERY_MIN))
    else:
        log("LinkedIn accepts: off (set LI_ACCEPT_EMAIL + LI_ACCEPT_APP_PASSWORD in .env)")
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
