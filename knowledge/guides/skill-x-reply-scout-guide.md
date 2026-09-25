---
type: guide
kind: sop
title: "X Reply Scout - runtime guide"
channel: twitter
related: ["[[tools/x-reply-scout-watchlist]]", "[[guides/twitter-api-reference]]", "[[projects/Beamcite/twitter-format-research/REPLY-PLAYBOOK]]"]
tags: [x, twitter, k77builds, replies, scout, adr-016]
created: 2026-07-04
updated: 2026-09-21
---

# X Reply Scout - runtime guide

Finds fresh posts worth replying to for @k77builds, so Bro never has to scroll X
hunting for targets. ADR-016: this file is the logic; any skill/scheduled task
pointing here is a thin wrapper.

**Triggers:** "run the reply scout", "find posts to reply to", "scout replies",
"what should I reply to today", "reply targets".

**Decided 2026-07-04 (Bro):** Two-stage blueprint.
- **Stage 1** = watchlist OR-search (Tier A + Tier B) via the API.
- **Stage 2** = Chrome "Build in Public" list scroll on br1, triggered when Stage 1
  yields fewer than the run target.
24h window; shortlist-first (no auto-queue); **target = 20 drafted
replies per run**. Keyword search rejected. The watchlist can include the full
Lead CRM personal-account hit list; follower size is a tie-breaker, not an
inclusion gate.

**Blueprint proven 2026-07-04 (first sample run):** Stage 1 returned 7 in-window
candidates; Stage 2 (Build-in-Public list) turned that into ~18. The For You and
Following feeds were near-useless for our niche (F1, politics, science, design
ads) - Build in Public is the only Chrome surface that yields on-lane targets.

**Decided 2026-07-11 (Bro): the lanes are wider than GEO/SEO.** The scout was
scoped too narrow. @k77builds does not only reply inside the GEO/SEO space. The
on-lane set is the whole builder/tech world:

- **GEO / SEO / AI-search** - the home lane, still top priority.
- **Early founders and early-to-mid-stage startups** - launch posts, first-customer
  or first-revenue moments, "just shipped" posts.
- **SaaS builders** - product, pricing, churn, growth posts.
- **Indie / "vibe" coders** - build-with-AI, shipped-with-Cursor/Claude, solo-dev posts.
- **Anything going viral in the tech niche** - if a tech/builder post is taking off,
  it is a target regardless of exact sub-topic.

Two size rules change with this:
- **Small accounts are valid targets, not drops.** Low-follower on-lane builders
  count. The old "closer to 2-10x our size wins" is now a reach tie-breaker, not a
  gate that removes small accounts.
- **Viral tech posts are in-lane at any author size.** Reach is the point, so a
  post blowing up in tech is a target even above our normal band. Caveat (honest,
  not a block): on a very large or already-crowded viral post the reply competes
  with hundreds and gets buried, so only take it when we can get in early with a
  strong R-move. The Never-reply list still applies to non-viral posts.

**Added 2026-07-25 from a reviewed creator field report:** reach alone is a weak
signal. The better target is a post whose comment section people are likely to
open. Combine velocity, low crowding, and reply-section demand. When X exposes
reply views, inspect the top reply's views for the strongest shortlisted
candidates. Source: [Sahil Panhotra's reply-growth field report](https://x.com/SahilPanhotra/status/2080315390941700360).
Treat its thresholds as anecdotal, not as platform policy or hard gates.

## Flow

### Step 0 - setup
1. `TZ='Asia/Kolkata' date` (always).
2. Read every active Tier A and Tier B handle from
   `tools/x-reply-scout-watchlist.md`. Deduplicate handles case-insensitively,
   skip `dormant`, and split the full result into chunks of at most 10 handles.
3. Connection per `tools/supasidebar-content-team-plugin/shared/config/api-reference.md` (ngrok URL + basic auth). Optionally `GET /twitter/credits` (free).

### Step 1 - fetch (verified syntax, 2026-07-04)
One call per chunk (max ~10 handles per OR query):

```
POST {NGROK_URL}/twitter/search
{"keywords":["(from:h1 OR from:h2 OR ... ) -filter:replies"],"limit":20}
```

- Returns latest-first, original posts only, ~300 credits per page regardless of handle count.
- **Truncation check:** if `count == limit` AND the oldest returned tweet is newer
  than 24h ago, re-pull with `limit: 40` (page may have cut off inside the window).
- Run every generated chunk so every active watchlist account is checked. Cost
  scales with the number of chunks, so read `/twitter/credits` before a large
  watchlist run and report a credit-floor blocker instead of silently checking
  only part of the list.

### Step 2 - window filter
- Keep posts from the **last 24h**. Never reply to anything older than 24h
  (looks bot-like, visibility dead).
- Max **1 post per author per day**. If an author has several, keep the best-scoring one.
- **If Stage 1 yields fewer than the run target (20), run Stage 2 (Chrome
  Build-in-Public scroll) to top up the pool before scoring.**

### Step 3 - score each candidate (from REPLY-PLAYBOOK)
Read `projects/Beamcite/twitter-format-research/REPLY-PLAYBOOK.md` before scoring.
Rank by:

1. **Freshness** - newer wins; <2h old is gold (playbook: first 30-60 min velocity decides distribution).
2. **Comment crowding** - LOW reply count beats high. A 6h-old post with 3 replies can beat a 1h-old post with 80.
3. **Reply-section demand** - prefer posts that make people open the comments:
   questions, debatable claims, demonstrations, useful media, breaking tech
   context, or a visible discussion. For the strongest candidates, check the
   top visible reply's views when X exposes them. High post views with dead
   replies is a warning, not an automatic win.
4. **Topic fit** - any on-lane post counts (see the lanes above): GEO/SEO/AI-search is top, then early-founder / startup / SaaS / indie-coder posts and viral tech posts, then general BIP. Off-lane (F1, politics, general news) still drops. Question posts are top targets within any lane (R1).
5. **Size / reach** - viral posts win on reach at any author size; for non-viral posts, on-lane accounts near 2-10x our size win, but small on-lane accounts are valid targets, not drops. Only the Never-reply list is excluded (unless the post is genuinely viral and we can get in early).
6. **R-move availability** - can we attach a real value core, an original visual,
   a verified fact, a live test, an honest take, or a specific question? If no
   honest R-move exists, drop it. Do not force a reply to hit the target.

### Step 4 - shortlist (in chat, Bro ticks)
Show the pool (aim ~20 with Stage 2) as a table: handle | age | views | replies |
reply-section signal | source | one-line summary | suggested R-move | url. Bro
picks which to draft.
**Never auto-draft the whole list.** Do not pad past what has a real R-move -
playbook forbids forced replies even to hit the 20 target.

### Step 5 - hand off to x-reply-writer (scout does NOT draft or write the queue)

The scout's job ends at the ticked shortlist. Invoke the **x-reply-writer** skill
with the ticked posts (url + full text + author + age/reply context). x-reply-writer
owns everything downstream and the scout must NOT do any of it itself:

- the **account gate** (draft BOTH @k77builds + @kshetezVinayak decoy variants),
- the full QC + **AI judge pass** (Kshetez test against KSHETEZ-CORPUS / REJECTED-DRAFTS),
- **writing the drafts into `tools/x-reply-extension/data/reply-queue.json`** so Bro
  pastes from the k77 sidekick (mechanics live in the x-reply-writer guide).

The scout finding, then writing shortcut single-variant drafts + the queue file
itself, was the wrong boundary (corrected 2026-07-04, Bro). Scout finds; writer writes.

### Step 6 - write back
- New handle discovered during the run -> add to watchlist per its update protocol.
  This now includes early-founder / startup / SaaS / indie-coder handles, not just
  GEO/SEO/BIP - grow the watchlist across all lanes so Stage 1 covers them too.
- Log posted replies via x-data-manager as usual (playbook rule).

## Stage 2 - Chrome "Build in Public" scroll (br1) - verified 2026-07-04

Runs when Stage 1 is under the run target (20). Claude in Chrome on Bro's
logged-in X (browser = **br1**, deviceId `c607f8df-ab6c-4814-ba8e-ba9b8cffb8d0`).

1. **Scroll only. Zero interactions** - no likes, no follows, no replies, no DMs.
2. Navigate `x.com/home`, click the **"Build in Public"** tab (a pinned List -
   inherently reverse-chron, so "recency/Latest" is already on). Do NOT use For
   You or Following: verified off-lane for our niche (F1, politics, science,
   design ads) and near-zero on-lane yield.
3. **Harvest mechanics (both verified needed):**
   - Programmatic `window.scrollBy` STALLS after the first jump and stops
     triggering X's infinite loader. Use **real wheel scrolls** via the
     computer tool (`action:scroll`, ~7-9 ticks) - those fire the loader.
   - The feed is **virtualized** (only ~6 articles in DOM at once), so harvest
     via a JS snippet AFTER each small scroll, deduping by status URL into a
     `window.__scoutStore` Map. Big jumps skip posts before harvest sees them.
   - Per article pull: handle (`[data-testid="User-Name"]`), text
     (`[data-testid="tweetText"]`), status URL + `datetime` (the `time` element's
     anchor), and the `[role="group"][aria-label]` metrics string (replies/likes/
     views). Drop ads (`/·\s*Ad|Promoted/`).
   - When dumping results, strip URLs/tokens from text or the tool output gets
     flagged as cookie/query-string data.
4. Target **early, low-reply, on-lane** posts across ALL lanes (GEO/SEO,
   early-founder / startup, SaaS, indie / build-with-AI, plus anything going
   viral in tech), not GEO/SEO only. Fresh + few replies = our reply gets seen.
   Small accounts count. For the final high-reach candidates, open the post and
   inspect whether the comment section is active and whether top-reply views are
   visible. Do not do this expensive check for every harvested item.
5. Note grower-looking accounts (5-20x our size) -> verify followers via
   `/twitter/user` (~18 cr) -> add to watchlist Tier A/B per its update protocol.

## What this research does not authorize

- No likes, replies, follows, bookmarks, or feed-training actions during scouting.
- No copying top comments, quote tweets, captions, memes, screenshots, or GIFs.
- No rage-bait generation or manufactured controversy.
- No repeated replies under one viral post.
- No hard requirement for `1M views per hour`, Premium, a fresh account, or a
  specific daily reply volume.
- No claim that a high-view post will produce reply reach unless the comment
  section shows real demand.

**Queue write-back:** the scout hands ticked posts to x-reply-writer, which
writes the drafts into `reply-queue.json` (the extension reads that file fresh
per request). The scout never drafts or writes the queue itself. Never hit the
localhost server (7781) from the VM.

## Failure modes

| Symptom | Action |
|---|---|
| ngrok URL dead | Ask Bro: `./scripts/update-ngrok-url.sh auto` on the Mac |
| `429 credit_floor_reached` | Balance at floor (10K) - tell Bro to top up, stop |
| Empty 24h window across all chunks | Say so - do NOT lower the bar to stale posts |
| Handle returns nothing 2+ weeks | Mark `dormant` in watchlist |

## Cost reference (verified 2026-07-04, 900 credits of tests)

| Method | Cost | Verdict |
|---|---|---|
| Multi-handle OR search | ~300/page, covers ~10 handles | **Chosen** |
| Per-handle `/twitter/user/tweets` | ~300/handle (payload: `{handle, max_items}`) | Rejected - 10x cost, same data |

Daily run ~600-900 credits -> ~20-27K/month (~$0.25). Bro approved up to 100-200K/month, so limit bumps are fine when needed.
