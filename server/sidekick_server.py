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

SAFETY: never posts, likes, follows or DMs on X. Claude only writes drafts and
shortlists back into the queue; a human presses Reply.
"""
import base64
import hmac
import json
import os
import re
import secrets
import sys
import threading
import time
import urllib.error
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

JOB_TOKEN_TTL = 3 * 3600
SCOUT_WINDOW_HOURS = 24
SCOUT_CHUNK = 10
SCOUT_MAX_CANDIDATES = 60
VOICE_EXAMPLES = 30

QUEUE_FILE = os.path.join(DATA_DIR, "reply-queue.json")
OUTREACH_FILE = os.path.join(DATA_DIR, "outreach-queue.json")
JOBS_FILE = os.path.join(DATA_DIR, "jobs.json")
SCOUT_FILE = os.path.join(DATA_DIR, "scout-runs.json")
BLOCK_FILE = os.path.join(DATA_DIR, "blocklist.json")
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
    _save(JOBS_FILE, jobs[:100], "jobs")


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
    _save(SCOUT_FILE, runs[:20], "runs")


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
        dup = next((i for i in items if tid and i.get("tweet_id") == tid
                    and i.get("status") in ("queued", "drafted")), None)
        if dup:
            return 200, {"ok": True, "duplicate": True, "id": dup.get("id")}
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
            if isinstance(body.get("note"), str):
                i["note"] = body["note"][:500]
            save_queue(items)
            return 200, {"ok": True}
    return 404, {"error": "id not found"}


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
        with urllib.request.urlopen(req, timeout=30) as r:
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
        update_job(job["id"], status="failed", error="routine fire failed: %s" % e)
    return False


def voice_examples():
    """Recent real sends (posted_text) - the voice ground truth for drafting."""
    out = []
    for i in load_queue():
        if i.get("status") == "posted" and i.get("posted_text"):
            out.append({"post": (i.get("tweet_text") or i.get("text") or "")[:600],
                        "author": i.get("author"), "posted_text": i["posted_text"]})
        if len(out) >= VOICE_EXAMPLES:
            break
    return out


def start_draft_job(ids=None, account=None, note=""):
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
        job, token = create_job("draft", {
            "item_ids": [i["id"] for i in todo],
            "account": account or "",
            "note": note[:500],
        })
        for i in items:
            if i["id"] in job["payload"]["item_ids"]:
                i["drafting_job"] = job["id"]
        save_queue(items)
    fire_routine(job, token)
    return 200, {"ok": True, "job": public_job(get_job(job["id"]))}


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
        credits = None
        try:
            credits = armory("/twitter/credits").get("credits_remaining")
        except ArmoryError:
            pass
        cutoff = datetime.now(timezone.utc) - timedelta(hours=SCOUT_WINDOW_HOURS)
        blocked = blocked_set()
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
                     key=lambda c: -c["view_gap"])[:SCOUT_MAX_CANDIDATES // 2]
        gap_urls = {c["url"] for c in gap}
        rest = sorted((c for c in pool.values() if c["url"] not in gap_urls), key=scout_rank)
        cands = (gap + rest)[:SCOUT_MAX_CANDIDATES]
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


def start_scout_job():
    if not armory_configured():
        return 400, {"error": "Armory is not configured on the server"}
    running = next((j for j in load_jobs() if j["kind"] == "scout"
                    and j["status"] in ("created", "fetching", "scoring", "fired", "working")
                    and j.get("expires", 0) > time.time()), None)
    if running:
        return 409, {"error": "a scout run is already in progress", "job": public_job(running)}
    job, token = create_job("scout", {})
    with LOCK:
        runs = load_scout_runs()
        runs.insert(0, {"id": "run_" + uuid.uuid4().hex[:8], "job_id": job["id"], "ts": now_str(),
                        "candidates": [], "shortlist": [], "report": None})
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
                "blocked_authors": sorted(blocked_set()),
                "write_to": "/agent/job/%s/drafts" % job["id"]}
    run = next((r for r in load_scout_runs() if r["job_id"] == job["id"]), None)
    return {"job_id": job["id"], "kind": "scout",
            "candidates": run["candidates"] if run else [],
            "window_hours": SCOUT_WINDOW_HOURS,
            "write_to": "/agent/job/%s/scout" % job["id"]}


def agent_write_drafts(job, body):
    results = body.get("items")
    if not isinstance(results, list):
        return 400, {"error": "items list required"}
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
    return 200, {"ok": True, "written": written, "skipped": skipped}


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


def scout_pick(body):
    urls = {clean_tweet_url(u) for u in (body.get("urls") or [])}
    run_id = body.get("run_id")
    runs = load_scout_runs()
    run = next((r for r in runs if r["id"] == run_id), runs[0] if runs else None)
    if not run or not urls:
        return 400, {"error": "run and urls required"}
    added, ids = 0, []
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
                ids.append(resp["id"])
                added += 0 if resp.get("duplicate") else 1
    result = {"ok": True, "added": added, "ids": ids}
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
                             "Content-Type, X-Sidekick-Key, ngrok-skip-browser-warning")

    def _json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
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
                    h.update(armory=armory_configured(), routine=routine_configured(),
                             watchlist=len(parse_watchlist()[0]))
                    return self._json(200, h)
                if path == "/api/queue":
                    return self._json(200, {"items": load_queue()})
                if path == "/api/outreach":
                    return self._json(200, {"items": load_outreach()})
                if path == "/api/blocklist":
                    return self._json(200, {"items": load_blocklist()})
                if path == "/api/jobs":
                    return self._json(200, {"jobs": [public_job(j) for j in load_jobs()[:20]]})
                if path == "/api/scout":
                    runs = load_scout_runs()
                    run = runs[0] if runs else None
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
                    return self._json(*outreach_add(body))
            if path == "/api/draft":
                ids = body.get("ids") if isinstance(body.get("ids"), list) else None
                return self._json(*start_draft_job(ids, body.get("account"), str(body.get("note") or "")))
            if path == "/api/scout":
                return self._json(*start_scout_job())
            if path == "/api/block":
                with LOCK:
                    return self._json(*block_handle(body))
            if path == "/api/unblock":
                with LOCK:
                    return self._json(*unblock_handle(body))
            if path == "/api/scout/pick":
                return self._json(*scout_pick(body))
            return self._json(404, {"error": "not found"})
        except Exception as e:
            log("api error %s: %r" % (path, e))
            return self._json(500, {"error": "server error: %s" % e})

    # ---- Claude callbacks (per-job token)
    def _agent(self, method, path):
        m = re.match(r"^/agent/job/(job_[a-f0-9]{10})(?:/(drafts|scout|done))?$", path)
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
            if action == "done":
                if job["kind"] == "draft":
                    with LOCK:  # release anything Claude did not write back
                        items = load_queue()
                        for i in items:
                            if i.get("drafting_job") == job["id"]:
                                i.pop("drafting_job", None)
                        save_queue(items)
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
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
