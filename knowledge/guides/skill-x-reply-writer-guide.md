---
type: guide
title: "X Reply Writer (Beamcite / k77builds) — Skill Guide"
kind: sop
related: ["[[projects/Beamcite/twitter-format-research/REPLY-PLAYBOOK]]", "[[projects/Beamcite/twitter-format-research/STAGE-PLAYBOOK]]", "[[guides/skill-x-post-writer-guide]]"]
created: 2026-07-02
updated: 2026-07-30
tags: [twitter, x, beamcite, k77builds, replies, skill, guide, adr-016]
---

# X Reply Writer — Skill Guide v1

Source-of-truth logic for the `x-reply-writer` skill (thin wrapper at
`skills/x-reply-writer/SKILL.md`, ADR-016). Edit behavior HERE or in the
playbook, never in the wrapper.

**What this skill does:** drafts paste-ready X replies for **@k77builds**, either
for tweets Bro pastes in chat or for the sidekick-extension queue. Bro reviews,
edits, posts manually. This skill OWNS reply drafting; x-post-writer owns posts.

**What it does NOT do:** post to X, invent Beamcite/SSB facts, reply to
everything blindly (skipping weak targets is a feature), or touch queue items
whose status is not `queued` (except an explicit redraft request from Bro).

---

## Step 0 — Account gate (run BEFORE drafting, every item) — added 2026-07-03 (RD-7)

X replies go out from ONE of two accounts and the k77 sidekick does NOT tell us
which at draft time. Bro's call (2026-07-03): draft BOTH, one draft per account,
same target post, same real anchor, two register/rule variants.

- **Draft 1 = @k77builds** (founder account, `guides/x-accounts/k77builds.md`).
  Product + Beamcite anchors allowed; directional business context ("sales
  dropped") allowed; still NO revenue FIGURES (anchor-bank never-claim).
- **Draft 2 = @kshetezVinayak** (DECOY, `guides/x-accounts/kshetezvinayak.md`).
  HARD bans: no product IDENTITY at all - not the name AND not identity-pinning
  descriptions ("SupaSidebar", "Beamcite", "arc alternative", "mac sidebar",
  "GEO service"). "my app" / "my SaaS" only. NO revenue of any kind including
  directional "sales" (say "it didnt land").

Tag each draft's angle with its account. If Bro names ONE account for an item,
draft both for that account with different R-moves instead. **Why this gate
exists (RD-7):** the reply-writer had no account-awareness and leaked the product
identity ("arc alternative / mac sidebar") onto the decoy account. Read both
account profiles at startup (added to Step 1 below).

### Named voice override

When Bro says `reply like Avery`, `Avery-style reply`, `reply like Alex`,
`Alex-style reply`, `reply like Arthur`, or `Arthur-style reply`, read
`projects/Beamcite/twitter-format-research/VOICE-ROUTING.md` and every required
reply voice file listed for that alias before drafting.

The named voice changes the reply register only. The resolved account still
supplies identity, facts, claims, permissions, and product boundaries. Never
transfer a reference creator's personal facts into the reply.

`reply like Avery` uses the warm lowercase one-thought register. `reply like
Alex` uses the safe direct-answer, correction, dry-joke, or compact-proof
register in `alexxgrowth-replies.md`. `reply like Arthur` uses the peer-energy,
normally capitalized reaction, real-question, or personal-parallel register in
`arthuryuzbashew-replies.md`.

---

## Step 0.5 — De-truncate the X post (fetch full text) — MANDATORY for `platform: x`, added 2026-07-03

The k77 sidekick captures only the **visible preview** of a tweet, so long or
threaded posts land in the queue TRUNCATED - they end mid-sentence, trail a
partial/broken URL, or stop with "…". Drafting off a truncated capture produced a
wrong reply: on the NexlowX item both drafts said "you cut off right before the
answer" when the real tweet fully answered itself (the truncation was ours, not
his).

**Rule:** before drafting any `platform: x` item, if `tweet_text` looks truncated
(ends mid-sentence, has a partial `https://` fragment, ends in "…", or the post is
clearly long/threaded), fetch the real full text first:

```
POST {NGROK_URL}/twitter/tweet
Basic Auth:  -u "$(cat scripts/.ngrok-auth)"      # no X-Armory-Token needed (read route)
body:        { "tweets": ["<tweet_id>"] }          # tweet_id is already in the queue item
-> resp.tweets[0].text = the real post to draft against
```

Cost: ~15 credits per tweet; identical calls are cached and not re-billed; balance
is huge and floor-protected. Connection (ngrok URL, auth) + full billing model:
`guides/twitter-api-reference.md`. For a post whose OP continues in self-replies,
`POST /twitter/thread { "tweet": "<url>", "max_items": 10 }` gets the continuation
(also useful for the dedupe read in Step 6.1). Skip the fetch only for short
tweets that are visibly complete. LinkedIn/Reddit items are unaffected (different
capture path).

---

## Step 1 — Startup-read gate (MANDATORY every run, BEFORE drafting)

1. **`projects/Beamcite/twitter-format-research/REPLY-PLAYBOOK.md`** — THE craft
   source: R-moves R1-R8 with real examples, anti-bank, voice rules, drafting
   procedure (section 6), QC gate. Read in full. Draft by IMITATING its examples,
   not by filling templates.
2. **Voice:** the installed **kshetez-email-voice** skill (lowercase, "i", blunt,
   short forms). If the installed copy is unreachable, read
   `skills/kshetez-email-voice-old.md` (plain-text copy of the rules) plus
   `guides/k77builds-voice.md`; the `.skill` zip in `skills/` is the packaged backup.
3. **Anti-AI tells:** `guides/human-voice-writing-guide.md` Part 1 + Part 5 grep
   blacklist. The playbook's echo-agreement ban comes on top.
4. **Strategy context:** `STAGE-PLAYBOOK.md` reply section (targets 2-10x, volume,
   OP-reply-back is the metric).

5. **Anchor bank:** `learnings/LRN-anchor-bank.md` — the ONLY source for
   lived-experience/stake claims (playbook 4.6 points here too). Read every run.
6. **Rejection anti-bank:** `projects/Beamcite/twitter-format-research/REJECTED-DRAFTS.md`
   — Bro's vetoed lines with reasons. Added 2026-07-03 (RD-5): a reply line
   shipped breaking three already-logged rules because this file was
   post-writer-only. Replies read it too now.
7. **Kshetez corpus (positive few-shot):** `projects/Beamcite/twitter-format-research/KSHETEZ-CORPUS.md`
   — verbatim things Bro actually typed (tweets, emails, his rewrites). Draft
   by imitating the nearest corpus entries' SHAPE. This file is the concrete
   referent of the Kshetez test.

Read as needed: `projects/Beamcite/beamcite.md` fresh for any Beamcite fact
(price stays OUT — unresolved), `learnings/ssb-content-research-bank.md` for
verified numbers used in R3 expert drops.

If the playbook, voice skill, or human-voice guide is missing: STOP, tell Bro.

## Step 2 — Input modes

- **Inline mode:** Bro pastes 1-5 tweets or links (or says "reply to this").
  Draft per the playbook procedure, output in chat. "Read the room" (playbook
  6.1) here means: use whatever context Bro gave; a live pull of the comment
  section is optional (it costs credits - ask if it seems worth it). If the
  section wasn't read, say so in the output ("dedupe not checked") instead of
  pretending it was.
- **Queue mode:** trigger phrases like "run the reply queue" / "draft the reply
  queue" / "process the queue". Protocol:
  1. Read `tools/x-reply-extension/data/reply-queue.json`. Work every item with
     `status: "queued"` AND `platform` of `"x"`, `"linkedin"`, or missing; skip
     others (redraft `drafted` items only if Bro asks). The queue is
     multi-platform since 2026-07-02: `reddit` items belong to
     reddit-comment-writer (guides/reddit-comment-playbook.md) - never draft
     those here. LinkedIn moved INTO this skill 2026-07-03 (Bro's call: same
     voice, same anchor bank, one queue run) - see the LinkedIn register
     section below.
  2. Per item: 2-3 drafts, DIFFERENT R-moves where possible. Use the item `note`
     (Bro's context) when present; never invent facts to fill an angle.
     For @abhiijayVinayak, also add one item-level `avery_reference` object:
     `{example, pattern, template, source_url}`. The example must be a real,
     short Avery reply from the saved corpus. The pattern explains what she did
     conversationally. The template preserves the shape while leaving Abhijay's
     personal facts for him to fill.
  3. Write back into the SAME file per item: `drafts: [{"text", "angle"}]` (angle
     = R-move tag + why), `status: "drafted"`, `drafted_ts`. Valid JSON, preserve
     all other fields/items, never drop items. Shared state with the extension.
  4. Report: drafted count, skipped items + why (engagement-bait target, author
     too big/small, post too old, no payload available), weak-target flags.
- **Scout hand-off mode (from x-reply-scout):** the scout passes a list of ticked
  posts (url + full text + author) that are NOT yet in the extension queue. Draft
  them with the full flow (account gate -> both variants, QC, AI judge), then
  WRITE them into `tools/x-reply-extension/data/reply-queue.json` yourself:
  1. `cp` a timestamped `.bak` first.
  2. Load JSON; **dedupe by `tweet_id`** - update an existing item, else append a
     new one with schema `{id (uuid4 hex[:8]), ts, platform:"x", tweet_url,
     tweet_id, tweet_text, author, author_followers:null, note:"source:
     x-reply-scout", status:"drafted", drafts:[{text, angle}],
     avery_reference:{example,pattern,template,source_url}, drafted_ts}`.
  3. Bump top-level `updated`, `indent=1`, preserve ALL other items, then tell Bro
     to reload the sidekick popup. The queue server re-reads the file per request.
  The scout must NOT do this write itself - drafting + queue write is THIS skill's job.
- No input and nothing queued? Say so and stop. Never invent targets.

## Step 3 — Draft + QC

Follow REPLY-PLAYBOOK.md section 6 exactly (classify post -> dedupe against the
live section -> pick R-move -> find payload FIRST -> draft -> QC gate) and the
batch rule (>=3 different moves, <=40% questions, <=1 R4 pushback per batch).

### Reply payload menu - added 2026-07-25

The scout may pass a `reply-section signal` based on post velocity, low
crowding, and visible top-reply views. That signal only says the placement may
be valuable. It never supplies the reply's substance.

Choose the strongest original payload the target honestly supports:

1. **Specific text observation:** a concrete detail, natural opinion, or useful
   disagreement that depends on this post.
2. **Question with context:** a question the author can answer, supported by a
   detail from the post rather than empty interviewing.
3. **Screenshot observation:** point to a real detail in the target's media.
   Use a new screenshot only when its provenance and permission are clear.
4. **Researched context:** verify a fact, then add the missing context plainly.
   Include a verify note and never improvise the fact from memory.
5. **Live test:** actually test the claim, save the result, and reply with the
   proof. If the test was not run, write it as a proposed angle, not a claim.
6. **Relevant visual reaction:** use an owned, licensed, or clearly reusable
   image, GIF, or meme whose context matches the post. The caption must add a
   new thought.

This menu comes from a reviewed creator field report and is treated as
anecdotal strategy, not X policy. Source: [Sahil Panhotra's reply-growth field report](https://x.com/SahilPanhotra/status/2080315390941700360).

Do not copy a top comment, quote tweet, caption, meme, screenshot, or successful
reply. Do not generate rage bait, manufacture controversy, or post multiple
replies under one viral post. Being early and seeing high reply views do not
rescue a generic reply.

**R2/R7 anchor rule (the workhorse-move tension):** lived-experience and stake
claims must come from a REAL anchor - Bro's actual history in the fact files
(beamcite.md, research bank, TASKS/weekly reports) or something Bro said this
session. No anchor found = don't fake one: use a general honest version, another
move, or attach a verify-note naming exactly what Bro must confirm before posting.

**AI JUDGE PASS (MANDATORY since RD-5, 2026-07-03) — same architecture as the
post-writer's Step A; run on every draft BEFORE writing back to the queue:**

A separate judging pass (fresh subagent or content-qc), never the drafting
flow grading itself. The judge loads REJECTED-DRAFTS.md (negative few-shot),
KSHETEZ-CORPUS.md (positive few-shot), and answers one question per draft:
"would Kshetez type this?" — quoting every failing line and naming the RD tell
it resembles (punchline close, coined metaphor, "most people" foil, cinematic
adverb, feature triad, parallel pair, invented event, grade-3 violation).
Below 7/10 register fidelity = rewrite before the queue sees it.
`scripts/voice_lint.py` is an optional mechanical pre-filter, not the gate
(retired as gate by Bro 2026-07-03; RD-5's line would have been caught by
either — the failure was that replies ran NEITHER).

Output per reply: text + R-move tag + one-line why + verify-note when a fact is
used. Remind Bro (once per session) to log posted replies via x-data-manager
with the R-move tag + whether the OP replied back.

## Output style — clean readable Avery replies (APPROVED by Bro 2026-07-11)

This is the house style for @abhiijayVinayak replies. Bro reviewed a batch in
this exact style and said "they were good, keep writing them like this." Use it
as the default for every reply draft unless Bro explicitly names another voice
through the named voice override above.

**Voice = Avery reply register** (`websites/beamcite/learnings/x-post-writer/voice-corpus/averycode.md`,
"Her reply register" section): lowercase, warm, one thought, name the person when
you know it, ~one emoji only on the feeling line, honest micro-confessions,
curious follow-up questions. Peer never mentor (playbook 4.65.2). No pitch — the
profile sells, not the reply (name Beamcite only as honest peer context, never as
a sell).

**Hard style rules (the ones that made the batch land):**
1. **Keep clean apostrophes AND punctuation.** Write `what's`, `i'd`, `you've`,
   `couldn't`, and end every question with `?`. Do NOT strip them to fake
   casualness — that is the RETIRED lowercase-typo-teen voice, not Avery, and it
   made replies unreadable (Bro rejected a "hard humanize" pass that did this on
   2026-07-11). Clarity beats faux-roughness every time.
2. **No fake typos.** A typo on a ~35-char reply reads careless, and experts
   aren't fooled by typos anyway. Leave in typos of speed only if genuinely natural.
3. **One thought, ~one line.** Match Avery's ~35-char median. At most ~10% of a
   batch may run to two beats / a longer line; the rest are a single clean line.
4. **No em-dash.** Commas or hyphens.
5. **3 angles per post, different R-moves** (e.g. R2 confession, R7 question, R5
   joke). Across a batch: >=3 distinct moves, <=~40% questions, <=1 R4 pushback.
6. **Every stake/experience traces to `learnings/LRN-anchor-bank.md`** or this
   session. On this account you may reference Beamcite work Abhijay actually does
   (AI-visibility / citation tracking); never claim Bro's SSB receipts as Abhijay's.

**Output shape:** one clean line per draft, tagged with its R-move. When Bro asks
to push, write straight into the queue (scout hand-off write below / Step 2 queue
mode) with `status: "drafted"`. Worked reference batches:
`abhijay-x-identity/x-reply-drafts-2026-07-11.md` and `...-batch2.md`.

### Conversation-first correction - 2026-07-21

The success test is not "does this sound supportive?" It is "did this open a
specific conversation that could make the author remember Abhijay?"

- No generic congratulations or praise-only replies. Acknowledgment is allowed
  only when it leads directly into a specific question or adjacent topic.
- Draft from Abhijay's real stage: 17, building, learning distribution, doing
  outreach, and working around SEO/AI visibility. Do not age him into a
  consultant voice.
- Use work context mostly indirectly. Ask the mechanism he genuinely wants to
  understand, mention a shared builder constraint, or point at a pattern he has
  actually seen. Direct Beamcite mentions are occasional, not the default.
- Avery is a personality and conversation reference, not a library of life facts
  to transfer. Every extension item shows one real example, what she did, and a
  fill-in starting shape so Abhijay can add his own personality.
- Emoji are optional. `😭` is never a default humanizer and must not recur across
  a batch as filler.

### Reading what Bro ACTUALLY sent (voice ground truth) — added 2026-07-12

The sidekick extension now asks Bro which reply he sent and records it in
`tools/x-reply-extension/data/reply-queue.json` per item:
- **`posted_text`** = the exact reply he posted, captured from the panel
  (queue-server.py `/queue/update`, field documented "the reply Bro actually
  posted, for voice learning"). It INCLUDES any edits he made in the box, and can
  be saved mid-edit. **This is the ground truth — always read it first.**
- **`chosen_index`** = which of the 3 drafts he selected (secondary signal; use
  only when `posted_text` is absent, resolving to `drafts[chosen_index].text`).
- `status: "posted"` + `posted_ts` mark that he shipped it.

**Standing behavior:** whenever learning voice, running the feedback loop, or when
Bro says "save what I sent", read `posted_text` for every `status: "posted"` item
(fall back to `chosen_index`); those are his real sends. Give them a MILD extra
preference when drafting, never a heavy one — they are context-specific to their
posts (Bro's rule, 2026-07-11). If he edited a draft, `posted_text` shows exactly
how, so diff it against the draft to learn what he changed. Items posted before
this feature have neither field — do not guess which draft he used.

## LinkedIn items (draft-as-X, keep lowercase — updated 2026-07-04)

Queue items with `platform: "linkedin"` use the FULL X flow. Same example bank
(REPLY-PLAYBOOK.md), same R-moves, same imitation-not-templates rule, same
batch variety rule (LinkedIn items COUNT toward the batch's length variance and
move spread — at least one LinkedIn draft per batch under 20 words when 2+
LinkedIn items exist). There is no separate LinkedIn craft layer.

**Why (2026-07-03 postmortem):** the old "professional-casual register" swap
made drafting happen in formal mode, which regressed every draft to the median
LinkedIn comment: identical 2-3 sentence height, "The [stat] is the [noun] that
gets me" openers, "Been + verb-ing" reflective closers, echo-agreement. Bro's
call: one bank, one flow; register is a surface conversion, not a craft layer.

**No convert pass — LinkedIn drafts stay lowercase (Bro's call, 2026-07-04).**
The old mandatory "capitalize sentence starts and I" convert pass is RETIRED.
Bro types LinkedIn replies lowercase, same as X (verified: his real reply on the
Andrew Powers item — "claude fable is kind of unbeatable for now. for me codex
5.5 is even worse that claude 4.8..." — kept lowercase, KC-T3-2). Draft LinkedIn
replies EXACTLY as X replies: lowercase, "i", fragments allowed, hard stops, no
closers, length variance, natural typos of speed left in. Only mechanical touch
allowed: drop an emoji unless one genuinely carries the reaction. Do NOT
sentence-case, do NOT "polish" — that's the slop reflex the postmortem warned
about, now confirmed against his real typing.

**LinkedIn-specific banned tells (on top of playbook anti-bank):**
- Opener skeleton "The [number/stat] is the [noun] that [gets/lands/strikes] me"
- Reflective closers: "Been sitting with that one", "Been stuck on...", any
  "Been + verb-ing" landing beat
- Restating the author's thesis back at them in different words (echo-agreement
  — endemic on LinkedIn, the #1 tell)
- Uniform paragraph height: if two LinkedIn drafts in one batch have the same
  sentence count and ±10 words length, redraft one

**Unchanged rules:**
- Stakes from `learnings/LRN-anchor-bank.md` only; Beamcite receipts preferred.
  Never-claim list applies in full (no MRR, no exits, no pricing).
- **No pitching Beamcite in comments** - the profile and the connect flow
  (linkedin-connect-handoff pipeline) do the selling. Name it only if
  directly asked.
- Item fields differ from X: `{url, item_key, title, text, author, meta,
  note}` - `meta` carries post age + comment count for freshness judgment.
  Write drafts back in the same shape as X items (`drafts: [{text, angle}]`,
  `status: "drafted"`, `drafted_ts`).

## Maintenance

- Behavior changes: this guide or the playbook. Wrapper only for trigger/description
  changes (repackage via skill-creator).
- New proven replies of OURS (>=5L or an OP response from a 5x account): promote
  into GOOD-EXAMPLES.md GOOD-REPLIES section with metrics. Our flops: playbook anti-bank.
- Weekly move-tag review per playbook section 7; EXP-X-001 covers replies
  (review ~2026-07-30).
