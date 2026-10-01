"""Who accepted a LinkedIn connection request, read from LinkedIn's own emails.

LinkedIn emails the account when someone accepts ("Jane Doe accepted your
invitation" / "start a conversation with your new connection, Jane Doe"). This
reads those from the Gmail inbox the LinkedIn account uses, over IMAP with a
Gmail app password, and returns who accepted. Python stdlib only.

It never touches LinkedIn, and it opens the mailbox read-only: nothing is
marked read, moved or deleted. Bodies are only fetched for emails whose subject
looks like an acceptance; everything else is skipped on its headers.

Matching is strict, because a wrong match would send a message to a stranger's
queue: an email names one person in its subject and links their profile, and
both must agree (profile slug in the email + same first name). An acceptance
email can also carry "people you may know" links further down; the name check
is what keeps those from counting.
"""

import email
import email.header
import email.utils
import imaplib
import re
import urllib.parse

IMAP_HOST = "imap.gmail.com"
SUBJECT_RE = re.compile(r"accepted your invitation|new connection|are now connected", re.I)
NAME_RES = (
    re.compile(r"^(?P<n>.+?)\s+(?:has\s+)?accepted your invitation", re.I),
    re.compile(r"new connection,?\s+(?P<n>.+?)\s*$", re.I),
    re.compile(r"you and (?P<n>.+?) are now connected", re.I),
)
SLUG_RE = re.compile(r"linkedin\.com/(?:comm/)?in/([^/?#\s\"'<>&]+)", re.I)


def _decode(value):
    out = []
    for part, enc in email.header.decode_header(value or ""):
        out.append(part.decode(enc or "utf-8", "replace") if isinstance(part, bytes) else part)
    return " ".join("".join(out).split())


def subject_name(subject):
    """The person a LinkedIn acceptance subject names, or None."""
    for rx in NAME_RES:
        m = rx.search(subject or "")
        if m:
            return m.group("n").strip(" ,.!")
    return None


def first_word(name):
    w = re.findall(r"[^\W\d_]+", (name or "").lower())
    return w[0] if w else ""


def body_text(msg):
    parts = []
    for p in (msg.walk() if msg.is_multipart() else [msg]):
        if p.get_content_type() in ("text/plain", "text/html"):
            try:
                parts.append(p.get_payload(decode=True).decode(p.get_content_charset() or "utf-8", "replace"))
            except (AttributeError, LookupError):
                continue
    return "\n".join(parts)


def slugs_in(text):
    seen = []
    for s in SLUG_RE.findall(text or ""):
        s = urllib.parse.unquote(s).strip().lower()
        if s and s not in seen:
            seen.append(s)
    return seen


def parse_acceptance(subject, text):
    """-> {"name", "slugs"} for an acceptance email, else None."""
    if not SUBJECT_RE.search(subject or "") and "accepted your invitation" not in (text or "").lower():
        return None
    return {"name": subject_name(subject), "slugs": slugs_in(text)}


def match(acceptances, requested):
    """Pairs each acceptance with at most one requested lead.

    requested: [{"id", "name", "slug"}]. A lead matches when its profile slug is
    linked in the email and its first name is the subject's first name. With no
    name in the subject, only the email's first profile link counts. A name
    alone (no matching link) counts only when exactly one requested lead has
    that full name.
    """
    by_slug = {}
    for r in requested:
        if r.get("slug"):
            by_slug.setdefault(r["slug"].lower(), r)
    hits = {}
    for a in acceptances:
        name, slugs = a.get("name"), a.get("slugs") or []
        found = None
        if name:
            fw = first_word(name)
            found = next((by_slug[s] for s in slugs if s in by_slug and first_word(by_slug[s]["name"]) == fw), None)
            if not found:
                same = [r for r in requested if " ".join(r.get("name", "").lower().split()) == " ".join(name.lower().split())]
                found = same[0] if len(same) == 1 else None
        elif slugs and slugs[0] in by_slug:
            found = by_slug[slugs[0]]
        if found and found["id"] not in hits:
            hits[found["id"]] = {"id": found["id"], "name": found.get("name"), "email_subject_name": name,
                                 "email_ts": a.get("ts")}
    return list(hits.values())


def fetch_acceptances(user, password, days=4, seen=(), timeout=30):
    """Acceptance emails from LinkedIn in the last `days` days.

    -> (acceptances, message_ids_checked). `seen` message ids are skipped
    without fetching their bodies.
    """
    seen = set(seen)
    box = imaplib.IMAP4_SSL(IMAP_HOST, 993, timeout=timeout)
    try:
        box.login(user, password)
        # All Mail also covers archived ones; INBOX if the folder name differs.
        typ, _ = box.select('"[Gmail]/All Mail"', readonly=True)
        if typ != "OK":
            box.select("INBOX", readonly=True)
        typ, data = box.uid("SEARCH", "X-GM-RAW", '"from:linkedin.com newer_than:%dd"' % int(days))
        uids = (data[0] or b"").split() if typ == "OK" else []
        found, checked = [], []
        for uid in uids[-300:]:
            typ, d = box.uid("FETCH", uid, "(BODY.PEEK[HEADER.FIELDS (SUBJECT MESSAGE-ID DATE)])")
            if typ != "OK" or not d or not isinstance(d[0], tuple):
                continue
            head = email.message_from_bytes(d[0][1])
            mid = (head.get("Message-ID") or uid.decode()).strip()
            subject = _decode(head.get("Subject"))
            if mid in seen or not SUBJECT_RE.search(subject):
                continue
            typ, d = box.uid("FETCH", uid, "(BODY.PEEK[])")
            if typ != "OK" or not d or not isinstance(d[0], tuple):
                continue
            msg = email.message_from_bytes(d[0][1])
            a = parse_acceptance(subject, body_text(msg))
            checked.append(mid)
            if a:
                dt = email.utils.parsedate_to_datetime(head.get("Date")) if head.get("Date") else None
                a["ts"] = dt.strftime("%Y-%m-%d %H:%M:%S") if dt else None
                found.append(a)
        return found, checked
    finally:
        try:
            box.logout()
        except Exception:
            pass
