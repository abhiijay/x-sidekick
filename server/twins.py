"""Twin LinkedIn leads: one person sent a connection request from two accounts.

The operator asked (2026-11-22) to load the same people on a1 and k1 for
connection requests, because nobody knows who will accept which account.
A person must still be messaged from one account only. So once any account
has connected with them (accepted) or messaged them (sent / replied), every
other account's copy that is still waiting (a connect lead, or an accepted
person not yet messaged) is skipped.

The waiting copy is skipped, never deleted; the request on LinkedIn stays as
it is. Used by the server on every status change and every peer sync, so it
works whichever device the tap came from.
"""
import re


def li_slug(lead):
    m = re.search(r"linkedin\.com/in/([^/?#\s]+)", str(lead.get("profile_url") or ""), re.I)
    return m.group(1).lower().rstrip("/").rstrip("-") if m else ""


def sender(lead):
    return str(lead.get("sender") or "a1").strip().lower()


def connected(lead):
    """This copy is the account that won the person: accepted, or messaged."""
    return lead.get("channel") == "linkedin" and bool(li_slug(lead)) and (
        bool(lead.get("accepted_ts")) or lead.get("status") in ("sent", "replied"))


def retire_twins(leads, ts):
    """Skip waiting connect copies of people another account already has. Returns the skipped leads."""
    winner = {}
    for l in leads:
        if connected(l):
            s = li_slug(l)
            cur = winner.get(s)
            if cur is None or str(l.get("accepted_ts") or l.get("sent_ts") or "") < str(cur.get("accepted_ts") or cur.get("sent_ts") or "~"):
                winner[s] = l
    out = []
    for l in leads:
        if l.get("channel") != "linkedin":
            continue
        w = winner.get(li_slug(l))
        if w is None or l is w or sender(l) == sender(w):
            continue
        waiting_connect = (l.get("kind") or "message") == "connect" and l.get("status") in ("ready", "requested")
        # Both accepted before the devices synced: keep the first, skip the later one's message.
        accepted_unsent = (l.get("kind") or "message") == "message" and l.get("status") == "ready" and bool(l.get("accepted_ts"))
        if waiting_connect or accepted_unsent:
            l["status"] = "skipped"
            l["skip_reason"] = "%s already connected: message them from %s only" % (sender(w), sender(w))
            l["updated_ts"] = ts
            out.append(l)
    return out
