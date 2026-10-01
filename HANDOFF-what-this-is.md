# HANDOFF: what the X sidekick is and how it works

Read this if you are a Claude picking up this project with no prior context. It
explains the system, the decisions behind it, and the traps that have already
cost real time. `HANDOFF-mac-setup.md` is the separate, narrower document for
installing it on a Mac.

**This repo is PUBLIC.** No password, token, or ngrok URL goes in a commit, in a
file, or in your output. `server/.env` is gitignored and stays that way.

---

## 1. What it does

It helps one person, Abhiijay (@abhiijayVinayak), reply well on X at volume. It
finds posts worth replying to, drafts replies in his voice, and learns from what
he actually sends. A human presses Reply, always.

```
scout finds posts  ->  he picks the ones worth answering  ->  Claude drafts 3
replies per post   ->  he edits and posts one on X        ->  what he sent goes
back into the voice corpus and the person's history
```

The interesting part is the last arrow. Everything else is plumbing.

### The hard safety rule

**Nothing in this system ever posts, likes, follows, replies or DMs on X, or
messages anyone on LinkedIn.** The routine writes drafts to the server; the phone
app and the Chrome extension copy text and open X or LinkedIn; a person types and
presses the button. The same holds for the DM outreach tabs (section 10). If you are ever asked to
automate the actual send, that is a change to the premise of the project - stop
and ask, do not implement it.

---

## 2. The pieces

| Piece | Where | What it is |
|---|---|---|
| Server | `server/sidekick_server.py` | Python 3 standard library, no dependencies. Two ports in one process. |
| Phone app | `app/` | Installable web app (PWA). Hosted on GitHub Pages; talks to the server over ngrok. |
| Chrome extension | *not in this repo* - lives in the workspace at `tools/x-reply-extension/` | Puts a drafts panel on x.com itself. |
| Routine | `routine/ROUTINE.md` | What a cloud Claude session does when the server fires it. **This file is the writer's instructions - it is the highest-leverage file in the repo.** |
| Knowledge | `knowledge/` | Voice guides, corpora, the humanizer, the scout watchlist. |

**Ports.** `7781` is the legacy queue API for the Chrome extension, localhost
only, never exposed. `7790` is the phone app, its API and the Claude callbacks;
this is the one behind ngrok.

**Three auth boundaries.** `/app/*` is public static files. `/api/*` needs the
app password header. `/agent/*` needs a per-job bearer token that expires in 3
hours and dies when the job calls `/done`.

### How a draft job actually runs

1. The app POSTs `/api/draft` with item ids.
2. The server splits them into runs of `DRAFT_CHUNK` (20) and fires the Claude
   Code routine API once per chunk.
3. That cloud session reads `routine/ROUTINE.md` **from GitHub main**, then calls
   back into this server through the ngrok URL for its payload.
4. It writes drafts back to `/agent/job/{id}/drafts` and calls `/done`.

**Consequence worth internalising: editing `ROUTINE.md` locally changes nothing.**
The cloud session clones `main`. An unpushed improvement is an improvement that
does not exist. Push it.

---

## 3. The voice system

This is the heart of it, and the part most likely to be misunderstood.

### Account and voice are different things

From `knowledge/projects/Beamcite/twitter-format-research/VOICE-ROUTING.md`:
**the account supplies the facts, the voice supplies only the register.** For
`account: abhiijayVinayak` the writer produces three drafts per post, one each in
Avery's, Arthur's and Abhiijay's own reply register. All three speak as him, on
his verified facts. Never transfer Avery's or Arthur's life details - their
location, age, revenue, products, relationships.

### Each voice picks its own point

Three drafts exist so he has three genuinely different ways in, not one idea
worded three times. The three R-moves must differ. This was got wrong once, in
the worst possible way - see the failure log below.

### Examples outrank prose

`knowledge/voice-corpus/` holds real replies: 160 of his own paired with the post
each answered, 443 Avery, 896 Arthur. A guide *describes* a voice; a corpus *is*
the voice. When they disagree, the corpus wins. Avery's and Arthur's parent posts
were not in the source pulls, so their files teach register only and cannot tell
you which move a post deserves.

### The humanizer is mandatory, not optional

`knowledge/guides/skill-humanizer-guide.md` plus `knowledge/humanizer-research/`
(files 01-09). Stage 1 strips AI tells, Stage 3 injects human signals. It exists
because drafts read as AI without it. The measured tells to kill: reaction-phrase
openers (`so real,` `fr same,` `wild ratio.`), filler `honestly`/`tbh`, tidy
contrast scaffolds, closing hedges.

### Measured, not assumed

His real sends versus a rejected batch:

| | his real sends | rejected batch |
|---|---|---|
| median length | 47 chars / 10 words | 57 / 11 |
| ends in a question | 40% | 23% |
| opens with a reaction phrase | **0%** | 7% |
| mentions himself or a product | 30% | 35% |

Two of these are counter-intuitive and have already caused a wrong fix:
**he asks questions more often than the bad batch did**, and length was never the
real problem. The one absolute is the reaction opener. If you are about to write
a voice rule, measure first - the numbers above came from counting, and an
earlier version of this file stated the opposite from reading four examples.

---

## 4. The learning loop

`voice-sends.json` in the data dir is the durable record of every reply he
actually sent. It is seeded from `knowledge/voice-corpus/abhiijay-real-sends.json`
and appended to whenever an item is marked posted. A draft job gets the newest
`VOICE_EXAMPLES` (30) of them.

Entries carry `verbatim`: `false` means he wrote the wording himself, `true`
means he sent a draft untouched. **Hand-written wording outranks an accepted
draft** - an accepted draft only proves a draft was good enough, and learning
style from it is partly learning from this system's own output.

`rejected-drafts.json` is the negative half: drafts he threw away, with a reason
he picked from the app. Treat each reason as a standing rule.

**Why it lives outside the queue.** It used to read the live queue only. The
queue gets archived and trimmed, so 92 of 102 real sends had silently left the
drafting context while the writer saw 10. Any future cap or cleanup must not be
able to do that again.

---

## 5. People memory

`people.json`: one record per builder he replies to - handle, followers, how many
times he has replied, and the last few post/reply pairs. He replies to a bounded
set (128 builders, 24 of them repeat contacts), so what was said last time is
worth having.

**The context guarantee, which is structural rather than a rule to remember:**
only the authors in the current batch are ever sent, each capped to the last 3
interactions, plus one note line that is rewritten rather than appended. A batch
of 20 costs about 19KB whether the file holds 100 people or 10,000, and that does
not grow the longer the system runs. Do not "improve" this by sending the whole
file.

What it is for: not re-asking a question he already asked, and earning
familiarity from the record. Naming someone is honest at 2+ replies and false on
a first contact. An empty record means first contact - write for a stranger.

---

## 6. Data files

All in `SIDEKICK_DATA_DIR`, which points at the Chrome extension's data folder so
the extension and the phone share one queue. None are in git.

| File | Holds | Cap |
|---|---|---|
| `reply-queue.json` | The working queue: queued / drafted / posted / skipped | 500 items |
| `voice-sends.json` | Every reply he sent (the learning loop) | 20000 |
| `rejected-drafts.json` | Drafts he rejected, with reasons | 20000 |
| `people.json` | Per-builder relationship memory | 1000 |
| `scout-runs.json` | Scout candidates and shortlists | 60 runs |
| `jobs.json` | Routine run history and job tokens | 400 |
| `blocklist.json` | Authors never to draft for | - |
| `outreach-queue.json` | Profiles saved for later outreach (X and LinkedIn) | 500 |
| `dm-leads.json` | DM outreach leads: ready / sent / replied / skipped / cant_dm | 5000 |
| `dm-libraries.json` | Line libraries the X DM messages are built from | - |
| `dm-sends.json` | Every first message actually sent, and whether it got a reply | 20000 |
| `dm-state.json` | Send cooldowns after a "Failed, try again" | - |
| `dm-campaigns.json` | Campaign rules for Find more and Write with Claude (private) | - |
| `dm-touched.json` | LinkedIn slugs, X handles and names already contacted | - |
| `find-runs.json` | Find more runs: candidates, kept, dropped | 40 runs |

Sizing was checked at 100 replies/day: every file stays under 10MB and every hot
path runs in tens of milliseconds. Storage is not a constraint; batch size and
Armory credits are.

---

## 7. Failures already paid for

Do not rediscover these.

**Three drafts that were one idea.** `ROUTINE.md` used to say the three drafts
"answer the same post with the same honest anchor" and differ only in register.
That is an instruction to reword one point three times, and it produced exactly
that. Each voice must pick its own point and its own R-move.

**The age hook, 3 of 3.** A post said "when I was 17" and all three drafts
replied claiming to be 17. He *is* 17, so the fact was true - the violation was
the rate. His own correction (RD-16) caps it at roughly 1 in 5 and only when age
is the point. Echoing a detail out of the post back as your own is the tell, not
the fact.

**The corpus was learning from itself.** The "what you actually sent" box was
hidden until `posted_text` already existed, so it could never be filled in, and
marking posted stored the chosen draft as though he had sent it. 44 of 160 seeded
entries are word-for-word a draft. Never record a draft as a send without asking.

**Scout re-offered finished posts.** `queue_add` only treated a tweet as a
duplicate while `queued` or `drafted`, so anything posted or skipped could be
queued again and re-drafted. Every one of the 20 posts on a shortlist turned out
to be already handled. Fixed in four places; if you touch queueing, keep all
four.

**A timed-out fire is not a failed fire.** The fire endpoint provisions a cloud
session before answering and once took over 30s. The job was marked `failed`,
and a failed job rejects callbacks - so the server locked out the very run it had
just started, wasting it. Timeout is now 120s and a timeout leaves the job
firable.

**LaunchAgents cannot read `~/Documents`.** macOS TCC blocks it, so autostart
from a workspace under Documents fails with `Operation not permitted` and an
unhelpful `EX_CONFIG`. The server is started by hand.

**ngrok's browser warning.** Loading the app through a free ngrok URL shows an
interstitial to a real browser. That is why the app is on GitHub Pages and only
the API goes through ngrok. Do not try to suppress the warning.

---

## 8. Operating it

```bash
cd server && nohup ./start.sh > sidekick.log 2>&1 &   # start
curl -s -H "X-Sidekick-Key: $PW" localhost:7790/api/health
```

Health should show `"armory": true, "routine": true` and a watchlist count near
505. `armory: false` means an `ARMORY_*` value is missing; `routine: false` means
`ROUTINE_FIRE_URL` / `ROUTINE_TOKEN` are missing.

**The ngrok tunnel is the fragile part.** It is started ad hoc on a free plan, so
the URL changes if it restarts. When it does, `SIDEKICK_PUBLIC_URL` in `.env`
*and* the routine's allowed-domains list both need the new host, or callbacks
fail and jobs hang at `fired`.

Armory (the research API the scout uses) runs on a **different machine**, reached
over its own ngrok URL. If scouting breaks, check that machine is up before
debugging this one.

---

## 9. If you are about to change something

- Behaviour lives in `routine/ROUTINE.md`, and it only takes effect once pushed
  to `main`.
- Measure before writing a voice rule. The data is in the queue archives and
  `voice-corpus/`; counting takes a minute and has already overturned a
  confident wrong answer.
- Adding to the payload is not free. Check what it costs at a batch of 20.
- Keep the human in the loop. Every feature here assumes he reads the drafts and
  presses the button.

---

## 10. DM outreach: the LinkedIn and X DM tabs

First messages to prospects, sent by hand from the phone. The replies premise
carried over: Claude prepares, he sends, what he sent is kept.

**Where the messages come from.** Not from the routine. Batches are built in the
Cowork workspace from the outreach playbooks and loaded with `server/dm_tool.py
load` (its docstring is the lead schema). The phone never creates leads; a shared
X or LinkedIn profile only lands in that tab's Saved list for the next batch.

**One message per person, one tap to change it.** He asked for this explicitly:
the blueprints already exist, so three drafts per person is noise. X leads carry
fields (first name, product, platform, buyer query, category) plus a library id;
the phone builds hook + proof + CTA from `dm-libraries.json` with the same
follow-on rules as the desktop copy boards (a hook lists the proofs that may
follow it, a proof lists its CTAs, a hook that already promised or gave something
rules out lines that repeat it). Defaults are seeded per lead and redrawn until no
two waiting leads get identical text, because identical DMs at volume are what X
throttles. LinkedIn leads carry written `variants`; Shuffle cycles them.

**The learning record.** Sent stores `sent_text`, `sent_verbatim` (untouched vs
edited) and `sent_lines` (which lines or variant). A reply later marks the same
`dm-sends.json` record `replied` with the reply text. That file answers "which
lines get answered", so like `voice-sends.json` it lives outside the lead list.
Undoing a send removes its record. As with replies, Sent never assumes: if the
text was not copied from the app, it asks what went out.

**Pacing is advice, not a lock.** Daily cap and a random gap per channel (phone
Settings). The gap is derived from the last send's timestamp, so it is the same
on every device without storing anything. "Failed, try again" on X means a spam
block, so marking it starts a 30 minute cooldown the phone shows in red.

**No rebuild under a typing thumb.** Background refreshes (coming back from the X
app, polling) skip a DM panel while its textarea has focus and redraw when focus
leaves. Taps inside the panel always redraw.

**Deploy note.** The app half ships through GitHub Pages (push to main); the
server half needs a restart on the Mac. An app that reaches an older server shows
"restart the server" in both DM tabs instead of breaking.

### LinkedIn connect list, Find more, Write with Claude (2026-09-28)

**Two kinds of lead.** `kind: "message"` (default) and `kind: "connect"`
(LinkedIn only: a profile to send a connection request to). Connect leads move
`ready -> requested -> accepted`, and accepting turns the same record into a
message lead (`needs_message: true` when it has no text yet). One record per
person, so history (requested_ts, accepted_ts) is never split. Undoing an accept
sends `{kind: "connect", status: "requested"}`.

**Find more is the scout pattern again.** Stage 1 is mechanical and runs on the
Mac (`server/lead_finder.py`, stdlib): Peerlist Launchpad API (about 60% of makers
list their LinkedIn), Uneed's official API, Fazier's leaderboard. Only a link the
maker listed on their own profile is used; nothing is searched for or guessed,
the same rule as the old PH connect runs. Then the homepage check (the gates from
the motion ICP handoff), dedupe against `dm-touched.json` plus every lead on
file, and the v1.1 recency/price score. Stage 2 is the routine (`kind:
leadfind`), which only judges fit against the campaign rules. A failed Stage 2
adds the best by score, flagged "not checked by Claude", so a run is never
wasted. Product Hunt is deliberately absent: logged-out requests don't see
makers' LinkedIn links and scripted ones hit a bot check.

**Write with Claude** (`kind: dmwrite`) drafts for `needs_message` leads in
chunks of 15. The campaign rules ride in the payload from `dm-campaigns.json` in
the data dir, so business rules (offers, prices, proof lines) stay out of this
public repo. `sent_examples` (his real first messages, replied ones first) are
the voice ground truth, like `voice_examples` for replies.

**Number boxes.** Scout takes `want` (1-60): the candidate pool scales to
`max(60, 3 x want)` and the routine shortlists up to `want`. Each DM tab has a
"This session" box stored per device; the count is sends (or requests) since it
was set.

**Measured, not assumed (2026-09-28 sandbox run):** Peerlist listed 494 launches
for 10 days; 40 of 72 checked makers had a LinkedIn link; 13 passed the homepage
gates in 90 s. The account was signed out by LinkedIn after about 82 connection
requests in one day, which is why the connect cap defaults to 25.

### Light-phone pass (2026-10-01)

His phone has 4GB RAM and runs on mobile data, and Android kills the app while
LinkedIn is open. What that changed:

- **"Opened" and the current person live in localStorage** (`sk_dmopened`, 12h;
  `sk_li_focus_*`). In memory, the reload behind LinkedIn wiped the green "Sent?"
  step. A **✓ Sent** button is now always on the bar too, opened or not.
- **Refreshes are conditional.** GETs carry the ETag of what is on screen; an
  unchanged answer is a bodyless 304 and nothing is redrawn. Bodies over 1KB are
  gzipped (dm 194KB -> 30KB, queue 153KB -> 46KB). Preflights are cached 2h.
  Only the visible tab is rebuilt; hidden ones draw when opened.
- **Service worker is cache-first** (`sidekick-v6`), refreshed in the background,
  so a new app version shows on the second open after a deploy.
- **LinkedIn opens in the LinkedIn app** (Android intent) by default; Settings
  can switch to the browser (one reused tab).
- **Tell Claude** (LinkedIn): a note is stored in `dm-feedback.json` and every
  dmwrite payload carries the newest 30 as `feedback`. "Save + rewrite this one"
  sets `fix_note` + `previous_text` and starts a write run for that person. Each
  lead carries `claude_url`, the session that wrote (dmwrite) or found
  (leadfind) it, derived from jobs.json. Leads loaded from a Cowork batch have
  none. A finished cloud session cannot write back to the server, so the note,
  not the chat, is what changes future drafts.

### LinkedIn accepts from email (2026-10-01)

`server/accept_watch.py` reads LinkedIn's "accepted your invitation" emails from
the LinkedIn account's Gmail (IMAP, app password, read-only, every
`LI_ACCEPT_EVERY_MIN`, default 10) and moves matching Requested leads to Message
through `dm_update`, the same path as tapping Accepted (`accepted_by: "email"`).
A match needs the profile slug linked in the email and the subject's first name
to agree; a full-name-only match counts only when unique. That keeps "people you
may know" links inside the same email from counting. Write with Claude then
starts at most every `LI_ACCEPT_WRITE_EVERY_MIN` (120), one run for everyone
waiting. Status rides in `/api/health` (`accept_watch`), not `/api/dm`, so its
ticking clock does not break the DM list's 304s. Never touches LinkedIn.
