"""Find fresh makers on launch platforms for DM outreach. Python stdlib only.

Used by the sidekick server's "Find more" job (Stage 1). It is the mechanical
half of the 2026-09-28 motion lead pull, turned into a function:

  list launches   Peerlist Launchpad (best LinkedIn source, about 60% of makers
                  list one), Uneed (official REST API), Fazier (leaderboard)
  resolve maker   the maker's own profile on that platform -> LinkedIn / X link.
                  Only a link the maker listed themselves is used; nothing is
                  guessed or searched for.
  gate            fetch the product homepage: it must load, show a pricing
                  signal, and (motion video) have no video embed in its source
  score           launch recency and a $19+ price, as in the ICP handoff v1.1

Stage 2 (judging ICP fit, dropping directories/agencies/competitors) is done by
Claude through the routine; this module never decides fit on its own beyond the
keyword filter it is given.

Product Hunt is not used here: logged-out pages hide makers' LinkedIn links and
answer scripted requests with a bot check.
"""
import concurrent.futures as cf
import datetime
import html
import json
import re
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0 Safari/537.36")
VIDEO_MARKERS = ("<video", "youtube.com/embed", "youtube-nocookie.com", "player.vimeo.com",
                 "loom.com/embed", "fast.wistia", "wistia.com", "vidyard", "youtu.be/",
                 "youtube.com/watch", "mux.com", ".mp4")
_INSECURE = ssl.create_default_context()
_INSECURE.check_hostname = False
_INSECURE.verify_mode = ssl.CERT_NONE


class Stop(Exception):
    pass


def fetch(url, accept="text/html,application/xhtml+xml", timeout=12, max_bytes=3_000_000):
    """GET a public page. Returns (status, final_url, text). Raises on network errors."""
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept,
                                               "Accept-Language": "en-US,en;q=0.9"})
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError:
        raise
    except urllib.error.URLError as e:
        # A bad certificate on a maker's homepage says nothing about the product;
        # read it anyway (public HTML only, nothing is sent).
        if isinstance(getattr(e, "reason", None), ssl.SSLError):
            resp = urllib.request.urlopen(req, timeout=timeout, context=_INSECURE)
        else:
            raise
    with resp:
        return resp.status, resp.geturl(), resp.read(max_bytes).decode("utf-8", "ignore")


def li_slug(url):
    m = re.search(r"linkedin\.com/in/([^/?#\s\"']+)", url or "", re.I)
    return urllib.parse.unquote(m.group(1)).lower().rstrip("/").rstrip("-") if m else None


def x_handle(url):
    m = re.search(r"(?:x|twitter)\.com/(?:#!/)?@?([A-Za-z0-9_]{1,15})(?:[/?#]|$)", url or "", re.I)
    if not m or m.group(1).lower() in ("home", "intent", "share", "i", "search", "hashtag"):
        return None
    return m.group(1)


def clean_url(u):
    return re.sub(r"[?#].*$", "", u or "").rstrip("/") or None


def score_launch(launch, prices, today=None):
    """Motion ICP handoff v1.1, the parts a script can see."""
    today = today or datetime.date.today()
    pts, why = 0, []
    try:
        age = (today - datetime.date.fromisoformat(launch)).days
    except (TypeError, ValueError):
        age = None
    if age is not None and age <= 14:
        pts += 4
        why.append("launched in the last 14 days +4")
    elif age is not None and age <= 30:
        pts += 2
        why.append("launched 15-30 days ago +2")
    if any(19 <= p <= 2000 for p in prices):
        pts += 2
        why.append("paid plan $19+ seen +2")
    if age is not None and age <= 7:
        pts += 2
        why.append("launch post in the last 7 days +2")
    return pts, "; ".join(why), age


def tier_for(score):
    return "Contact this week" if score >= 8 else "Next batch" if score >= 6 else "Later"


def gate_homepage(site):
    """What the homepage source says: loads, video embed, pricing signal, prices."""
    code, final, body = fetch(site, timeout=10)
    low = body.lower()
    text = re.sub(r"<script.*?</script>|<style.*?</style>", " ", low, flags=re.S)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text)
    pricing = bool(re.search(r'href="[^"]*(pricing|/plans|/price|#pricing|/buy|/upgrade)', low)
                   or re.search(r"\bpricing\b", text)
                   or re.search(r"[$€£]\s?\d+(\.\d+)?\s?(/|per )\s?(mo|month|year|yr|user)", text))
    prices = [float(x) for x in re.findall(r"[$€£]\s?(\d{1,4}(?:\.\d{1,2})?)", text)][:40]
    title = re.search(r"<title[^>]*>(.*?)</title>", body, re.S | re.I)
    return {"code": code, "final": final[:200], "video": [v for v in VIDEO_MARKERS if v in low],
            "pricing": pricing, "prices": prices, "text_len": len(text),
            "title": html.unescape(title.group(1).strip())[:120] if title else ""}


# ---------------------------------------------------------------- sources
#
# Each source lists launches cheaply, then resolves one launch at a time (the
# maker's links, the product site) only when the finder asks for it.

class Peerlist:
    name = "Peerlist"
    API = "https://peerlist.io/api/v1/users/projects/spotlight?year=%d&week=%d&limit=20%s"

    @staticmethod
    def list(since, until, deadline):
        out, seen = [], set()
        weeks = sorted({(d.isocalendar()[0], d.isocalendar()[1])
                        for d in (since + datetime.timedelta(days=i)
                                  for i in range((until - since).days + 1))}, reverse=True)
        for year, week in weeks:
            cursor, pages = "", 0
            while pages < 20:
                if time.time() > deadline:
                    raise Stop()
                _, _, body = fetch(Peerlist.API % (year, week, "&cursor=" + cursor if cursor else ""),
                                   accept="application/json")
                data = json.loads(body).get("data") or {}
                items = data.get("spotlight") or []
                for it in items:
                    day = (it.get("featuredOn") or "")[:10]
                    who = it.get("createdBy") or {}
                    if not day or not (since.isoformat() <= day <= until.isoformat()):
                        continue
                    if it.get("id") in seen:
                        continue
                    seen.add(it.get("id"))
                    out.append({"source": "Peerlist", "product": it.get("title") or "",
                                "tagline": it.get("tagline") or "", "launch": day,
                                "maker": who.get("displayName") or "", "first": who.get("firstName") or "",
                                "headline": (who.get("headline") or "")[:200],
                                "maker_profile": "https://peerlist.io/" + (who.get("profileHandle") or ""),
                                "_handle": who.get("profileHandle"), "_project": it.get("projectURL"),
                                "votes": it.get("upvotesCount")})
                nxt = data.get("cursor")
                pages += 1
                if not items or not nxt or nxt == cursor:
                    break
                cursor = nxt
                time.sleep(0.8)
        return out

    @staticmethod
    def resolve(s):
        if not s.get("_handle"):
            return s
        _, _, t = fetch("https://peerlist.io/" + s["_handle"])
        m = re.search(r'"LinkedIn":"(https?://[^"]+)"', t)
        s["linkedin"] = m.group(1) if m else None
        m = re.search(r'"(?:Twitter|X)":"(https?://[^"]+)"', t)
        s["x"] = m.group(1) if m else None
        return s

    @staticmethod
    def resolve_site(s):
        if s.get("_project"):
            _, _, t = fetch("https://peerlist.io" + s["_project"])
            m = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', t, re.S)
            urls = re.findall(r'"url":"(https?://[^"]+)"', m.group(1) if m else "")
            urls = [u for u in urls if not re.search(r"peerlist|cloudfront|linkedin|x\.com|twitter", u, re.I)]
            s["site"] = clean_url(urls[0]) if urls else None
        return s


class Uneed:
    name = "Uneed"
    API = "https://mcp.uneed.best/v1/trending?period=daily&date=%s&limit=50"

    @staticmethod
    def list(since, until, deadline):
        out = []
        d = until
        while d >= since:
            if time.time() > deadline:
                raise Stop()
            _, _, body = fetch(Uneed.API % d.isoformat(), accept="application/json")
            for p in json.loads(body).get("ranking") or []:
                out.append({"source": "Uneed", "product": p.get("name") or "",
                            "tagline": p.get("description") or "", "launch": p.get("launch_date") or d.isoformat(),
                            "site": clean_url(p.get("url")), "pricing": p.get("pricing"),
                            "category": p.get("category"), "votes": p.get("vote_count"),
                            "_slug": p.get("slug")})
            d -= datetime.timedelta(days=1)
        return out

    @staticmethod
    def resolve(s):
        _, _, t = fetch("https://www.uneed.best/tool/" + (s.get("_slug") or ""))
        m = re.search(r'Publisher</p>.*?href="/profile/([^"]+)"', t, re.S)
        if not m:
            return s
        s["maker_profile"] = "https://www.uneed.best/profile/" + m.group(1)
        _, _, pt = fetch(s["maker_profile"])
        nm = re.search(r"<title>([^<|]+)", pt)
        s["maker"] = re.sub(r"\s*\(@[^)]*\)\s*-\s*Uneed\s*$", "", html.unescape(nm.group(1)).strip()) if nm else ""
        links = [l for l in set(re.findall(r'href="(https?://[^"]+)"', pt)) if not re.search(r"uneed", l, re.I)]
        s["linkedin"] = next((l for l in sorted(links) if li_slug(l)), None)
        s["x"] = next((l for l in sorted(links) if x_handle(l)), None)
        return s

    resolve_site = staticmethod(lambda s: s)


class Fazier:
    name = "Fazier"

    @staticmethod
    def list(since, until, deadline):
        out, seen = [], set()
        d = until
        while d >= since:
            if time.time() > deadline:
                raise Stop()
            _, _, t = fetch("https://fazier.com/leaderboard/daily/%d/%d/%d" % (d.year, d.month, d.day))
            for slug in sorted(set(re.findall(r'href="/launches/([^"/?#]+)"', t))):
                if slug not in seen:
                    seen.add(slug)
                    out.append({"source": "Fazier", "product": slug, "launch": d.isoformat(), "_slug": slug})
            d -= datetime.timedelta(days=1)
        return out

    @staticmethod
    def resolve(s):
        _, _, t = fetch("https://fazier.com/launches/" + s["_slug"])
        m = re.search(r"<h1[^>]*>(.*?)</h1>", t, re.S)
        if m:
            s["product"] = html.unescape(re.sub(r"<[^>]+>", "", m.group(1)).strip()) or s["product"]
        m = re.search(r'<meta name="description" content="([^"]*)"', t)
        s["tagline"] = html.unescape(m.group(1)) if m else ""
        m = (re.search(r'href="(https?://[^"]+)\?ref=fazier"[^>]*>\s*Visit', t)
             or re.search(r'href="(https?://[^"?]+)[^"]*"[^>]*>Visit', t))
        s["site"] = clean_url(m.group(1)) if m else None
        pr = re.findall(r">(Paid|Freemium|Free)<", t)
        s["pricing"] = pr[0] if pr else None
        seg = t[t.find("Makers</h5>"):t.find("Makers</h5>") + 3000] if "Makers</h5>" in t else ""
        for maker_id in dict.fromkeys(re.findall(r'href="/p/([^"]+)"', seg)):
            _, _, pt = fetch("https://fazier.com/p/" + maker_id)
            m = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', pt, re.S)
            nd = m.group(1) if m else ""
            um = re.search(r'"social_links":\s*(\[[^\]]*\])', nd)
            try:
                socials = [x.get("url") for x in json.loads(um.group(1))] if um else []
            except ValueError:
                socials = []
            li = next((u for u in socials if u and li_slug(u)), None)
            xx = next((u for u in socials if u and x_handle(u)), None)
            if li or xx:
                nm = re.search(r'"full_name":\s*"([^"]*)"', nd)
                s["maker"] = json.loads('"%s"' % nm.group(1)) if nm else maker_id
                s["maker_profile"] = "https://fazier.com/p/" + maker_id
                s["linkedin"], s["x"] = li, xx
                break
        return s

    resolve_site = staticmethod(lambda s: s)


SOURCES = (Peerlist, Uneed, Fazier)


def find(need, want, days=14, touched=None, touched_names=None, exclude_keywords=(),
         require_no_video=True, require_pricing=True, time_budget=420, progress=None, today=None):
    """Return (candidates, report). need = "linkedin" or "x".

    Stops once it has about twice `want` passing candidates (so the judge has a
    choice) or when the time budget runs out.
    """
    today = today or datetime.date.today()
    since = today - datetime.timedelta(days=max(1, days) - 1)
    deadline = time.time() + time_budget
    touched = touched or set()
    touched_names = touched_names or set()
    target = max(want * 2, want + 5)
    kw = [k.lower() for k in exclude_keywords if k]
    found, report, lock = [], {"sources": {}, "errors": [], "stopped": None}, threading.Lock()
    seen_contacts = set()

    def contact_key(s):
        if need == "linkedin":
            slug = li_slug(s.get("linkedin"))
            return ("li:" + slug) if slug else None
        h = x_handle(s.get("x"))
        return ("x:" + h.lower()) if h else None

    def work(src, s):
        st = report["sources"][src.name]
        src.resolve(s)
        key = contact_key(s)
        if not key:
            return None
        st["with_contact"] += 1
        name_key = re.sub(r"\s+", " ", (s.get("maker") or "").strip().lower())
        with lock:
            if key in touched or key in seen_contacts or (" " in name_key and name_key in touched_names):
                st["already_touched"] += 1
                return None
            seen_contacts.add(key)
        src.resolve_site(s)
        if not s.get("site") or re.search(r"chromewebstore|apps\.apple|play\.google|github\.com", s["site"], re.I):
            st["no_site"] += 1
            return None
        try:
            g = gate_homepage(s["site"])
        except Exception:
            st["site_down"] += 1
            return None
        if str(g["code"]) != "200" or g["text_len"] < 200:
            st["site_down"] += 1
            return None
        if require_no_video and g["video"]:
            st["has_video"] += 1
            return None
        if require_pricing and not g["pricing"]:
            st["no_pricing"] += 1
            return None
        pts, why, age = score_launch(s.get("launch"), g["prices"], today)
        st["passed"] += 1
        return {"source": src.name, "product": s.get("product"), "tagline": (s.get("tagline") or "")[:200],
                "site": s.get("site"), "launch": s.get("launch"), "age_days": age,
                "maker": s.get("maker"), "first": s.get("first") or (s.get("maker") or "").split(" ")[0],
                "headline": s.get("headline") or "", "maker_profile": s.get("maker_profile"),
                "linkedin": s.get("linkedin"), "x": s.get("x"), "category": s.get("category"),
                "prices": sorted({int(p) if p == int(p) else p for p in g["prices"] if 5 <= p <= 2000})[:6],
                "site_title": g["title"], "score": pts, "score_why": why, "tier": tier_for(pts),
                "key": contact_key(s)}

    try:
        for src in SOURCES:
            st = report["sources"].setdefault(src.name, {"listed": 0, "checked": 0, "with_contact": 0,
                                                         "already_touched": 0, "no_site": 0, "site_down": 0,
                                                         "has_video": 0, "no_pricing": 0, "passed": 0})
            if len(found) >= target:
                break
            if progress:
                progress("listing %s" % src.name)
            try:
                stubs = src.list(since, today, deadline)
            except Stop:
                raise
            except Exception as e:
                report["errors"].append("%s: %s" % (src.name, str(e)[:160]))
                continue
            st["listed"] = len(stubs)
            stubs = [s for s in stubs if s.get("pricing") != "Free"
                     and not any(k in ("%s %s" % (s.get("product"), s.get("tagline"))).lower() for k in kw)]
            stubs.sort(key=lambda s: s.get("launch") or "", reverse=True)
            with cf.ThreadPoolExecutor(6) as ex:
                for i in range(0, len(stubs), 18):
                    if len(found) >= target:
                        break
                    if time.time() > deadline:
                        raise Stop()
                    chunk = stubs[i:i + 18]
                    for res in ex.map(lambda s: _safe(work, src, s), chunk):
                        st["checked"] += 1
                        if res:
                            found.append(res)
                    if progress:
                        progress("%s: %d checked, %d found" % (src.name, st["checked"], len(found)))
    except Stop:
        report["stopped"] = "time budget reached"
    found.sort(key=lambda c: (-c["score"], c.get("age_days") if c.get("age_days") is not None else 99))
    return found, report


def _safe(fn, *a):
    try:
        return fn(*a)
    except Exception:
        return None
