---
type: guide
kind: voice
title: "Human Voice Writing Guide (project-agnostic)"
project: "[[projects/supasidebar]]"
related:
  - "[[guides/blog-writer-geo-guide]]"
  - "[[tools/supasidebar-content-team-plugin/shared/config/voice.json]]"
  - "[[tools/supasidebar-content-team-plugin/blog/config/writing-lessons.md]]"
tags: [voice, writing-style, anti-ai-writing, reusable, content]
created: 2026-06-09
updated: 2026-07-03
version: 2
---

# Human Voice Writing Guide

A portable, project-agnostic style guide for writing prose that reads like a person wrote it, not a language model. It captures the writing style already in use across SupaSidebar content (blogs, Reddit, newsletters) and strips out anything project-specific, so it can drop into any project: another app, a client, a personal blog, docs, emails.

**What this file is NOT:** it is not the SEO/GEO playbook, not the schema spec, not the founder-byline rule. Those live in project-specific files (for SupaSidebar: `guides/blog-writer-geo-guide.md`, `guides/blog-schema-structure-spec.md`). This file is only about *how the sentences sound*.

**How to use it:** read it before writing. After drafting, run the self-check at the bottom. Every rule below has a paired bad and good example so you can pattern-match instead of memorizing.

---

## The one-line philosophy

Write the way a sharp, opinionated person explains something to a colleague who is smart but busy: pick a side, use real numbers, vary your rhythm, and cut anything that is performance rather than communication.

Most "AI writing" fails not because it is wrong but because it is *evenly* wrong: every sentence the same length, every list perfectly parallel, every claim hedged, every paragraph relentlessly upbeat, every transition a connective cliche. Human writing is uneven on purpose.

---

## Part 1: The fastest tells that prose was AI-generated

These are the patterns a reader (or an AI-detection pass) clocks first. Fix these and you are 80% of the way there.

### Tell 1: Hedging instead of a verdict

A real writer who knows the topic commits. "It depends on your needs" is the sound of nobody home.

**Bad:**
> Choosing the right tool really depends on your specific needs and workflow. There are many great options, each with its own strengths and weaknesses.

**Good:**
> For most people, use Tool A. It is faster, cheaper, and the migration takes an afternoon. Switch to Tool B only if you need offline mode, which A still does not have.

Commit in the opening and the conclusion. Nuance belongs in the middle, where it informs without smothering the verdict.

### Tell 2: LLM vocabulary

Certain words are load-bearing for models and almost never used by people writing naturally. Replace them.

| AI word | Write instead |
|---|---|
| delve into, dive into, deep dive | look at, get into, go through |
| leverage | use |
| utilize | use |
| robust | solid, reliable, sturdy |
| seamless / seamlessly | (usually delete; or "with no setup", "without switching") |
| streamline | simplify, cut steps |
| navigate (figurative) | handle, deal with, work through |
| landscape (meaning "industry") | (name the actual thing: market, tools, options) |
| foster, empower, elevate, unlock | (rewrite the sentence; these are filler verbs) |
| game-changer, revolutionary, cutting-edge | (delete; or state the specific thing it changes) |
| in today's fast-paced world | (delete entirely) |
| it's no secret that | (delete entirely) |

**Bad:**
> In today's fast-paced digital landscape, this robust tool empowers users to seamlessly streamline their workflow.

**Good:**
> The tool does one thing well: it cuts a five-step save into one keystroke.

### Tell 3: Formulaic structure

Real paragraphs are uneven. AI defaults to suspicious regularity.

Watch for and break these:

- **Every paragraph 2-3 sentences.** Vary it: a one-sentence paragraph for emphasis, then a five-sentence one that does the work.
- **Every list item parallel and the same length.** Real lists have items of different weights.
- **"First... Second... Third..." or a gerund opening every bullet.** Mix the openings.
- **Pros section exactly mirrored by a cons section,** same number of items, same length. Reality is lopsided.
- **A neat "In conclusion" wrap that restates the intro.** Conclusions should add a verdict, not echo.

**Bad (every bullet a parallel gerund, all same length):**
> - Improving your focus by reducing distractions
> - Enhancing your productivity by organizing tasks
> - Streamlining your workflow by automating steps

**Good (varied openings, varied weight):**
> - Fewer tabs in your face, so you stop losing the one you need.
> - Tasks grouped by project. Not revolutionary, but it means you stop re-finding things.
> - Some of it automates, but honestly the manual sort is half the value.

### Tell 4: Relentless positivity

If everything is great, nothing is trusted. Name the limit. A real recommendation says where the thing falls short.

**Bad:**
> This is the perfect solution for everyone. It handles every use case beautifully and you will love it.

**Good:**
> It is the right call for most people. The exception: if you live in offline mode, the sync gap will annoy you, and there is no fix for that yet.

### Tell 5: Sourceless specifics

A number with no source reads as invented, because half the time, in AI text, it was. Either source it or cut it.

**Bad:**
> Studies show this approach is 47% more effective for most users.

**Good:**
> In [Birchtree's 36-hour test](https://example.com), Chrome used 9% less battery than Safari. One test, one device, so treat it as a data point, not a law.

If you cannot source a specific, hedge it openly ("anecdotally", "in my own use") or delete it. Never state an unsourced number as fact.

### Tell 6: The negation flip (the single biggest tell)

This is the one detectors and readers clock fastest in 2026: two opposed ideas set in matching grammar. "X doesn't do A, it does B." "It's not X, it's Y." "Not just X, but Y." "The question isn't X, it's Y." The pattern promises a sharp contrast and then usually delivers nothing new. Rewrite every one as a plain statement that adds information.

**Bad:**
> ChatGPT doesn't rank your page, it quotes it.
> The goal isn't more traffic, it's more citations.
> This isn't just a sidebar, it's a workflow.

**Good:**
> ChatGPT pulls a few pages and quotes the clearest one.
> Citations matter more than raw traffic here, because the buyer acts on the name the assistant gives.
> The sidebar groups tabs by project, so switching contexts stops being a tab hunt.

The fix: search your draft for " not " and "isn't" and "n't just". If the sentence sets two things against each other in parallel, flatten it into one direct claim. Antithesis is a real rhetorical move (JFK used it), so once in a long piece is fine. More than that and it reads as machine-balanced.

### Tell 7: Stacked connective transitions

"Moreover," "Furthermore," "Consequently," "Additionally" opening consecutive sentences is a model habit. People rarely stack them. Cut most; let the logic carry itself.

**Bad:**
> The tool saves time. Moreover, it reduces errors. Furthermore, it is easy to learn.

**Good:**
> The tool saves time and cuts errors, and you pick it up in an afternoon.

### Tell 8: Curly quotes and curly apostrophes

Models default to typographic curly quotes and apostrophes. Fast casual human typing (and most editors people actually use) produces straight ones. Use straight quotes and apostrophes. This pairs with the no-em-dash rule: smart punctuation is an AI fingerprint.

---

## Part 2: Sentence craft (the texture of human prose)

### Rule 1: Vary sentence length deliberately

The single biggest lever for human-sounding prose. Follow a long, complex sentence with a short, blunt one. The short one lands.

**Bad (all medium-length, even rhythm):**
> The tool helps you manage your tabs. It works across different browsers. You can organize them into groups. This saves you time during the day.

**Good (varied, with a short punch):**
> The tool gathers tabs from every browser into one sidebar, groups them by project, and keeps them there across restarts. No more hunting. By the third day it is muscle memory.

### Rule 2: Use contractions and plain words

People say "don't", "won't", "it's". Formal writing that refuses contractions reads stiff and robotic.

**Bad:**
> It is not necessary to configure anything. You will find that the defaults are sufficient.

**Good:**
> You don't have to configure anything. The defaults are fine.

### Rule 3: Lead with the concrete, not the abstract

Open on the thing the reader can see, not a category statement.

**Bad:**
> Tab management is an important aspect of modern browsing productivity.

**Good:**
> Open 20 tabs and the titles shrink to favicons you can't tell apart. That is the problem.

### Rule 4: Cut throat-clearing openers

Sentences that announce what you are about to say, instead of saying it.

Delete these on sight: "It's worth noting that", "It's important to understand that", "When it comes to X", "One thing to keep in mind is", "At its core".

**Bad:**
> It's worth noting that, when it comes to battery life, Safari tends to perform well.

**Good:**
> Safari wins on battery. Up to 24 hours of video on an M4 per Apple's specs.

### Rule 5: One idea per sentence, but let sentences breathe

Do not chop everything into staccato fragments either (that is its own AI tell). The goal is rhythm, not uniformity. A sentence can carry a clause if the clause earns its place.

**Too choppy:**
> The tool is fast. It is light. It uses little RAM. You will like it.

**Better:**
> The tool is fast and light, and on a 16GB Mac that actually shows up as RAM you get back. You'll feel it most past 20 tabs.

### Rule 6: Prefer specific nouns and strong verbs over adverbs

**Bad:**
> It significantly and dramatically improves your browsing experience.

**Good:**
> It cuts a 30-second tab hunt to a one-keystroke jump.

---

## Part 3: Structure and argument

### Rule 7: Open with the answer

Whether it is a blog, an email, or a doc, the first block should contain the verdict or the ask. Do not make the reader scroll for the point.

**Bad opening:**
> There are many factors to consider when choosing a browser. Let's explore them together in this comprehensive guide.

**Good opening:**
> Safari is the better default on a Mac for battery and memory. Chrome wins on extensions and cross-platform sync. If you use both, the real problem isn't choosing, it's keeping your tabs straight across them. Here's the full breakdown.

### Rule 8: Fence the scope explicitly

Telling the reader what you are NOT covering builds trust and reads like a person who knows the boundaries of their claim. This is a signature move of good explanatory writing.

**Good:**
> This covers the desktop tradeoffs on macOS. It does NOT cover iOS or iPadOS, where both browsers use the same engine and the differences mostly disappear.

### Rule 9: Teach one non-obvious thing

A page that just lists "best of" picks is forgettable. A page that explains *why* something is true (the history, the mechanism, the catch) gets remembered and re-shared.

**Bad (lists, doesn't teach):**
> Top browsers: 1. Safari 2. Chrome 3. Firefox 4. Brave.

**Good (teaches the mechanism):**
> The memory gap between the two is real but it is not the engine. Both run Blink. The difference is that one blocks trackers before they load, which shrinks what each tab has to hold. On a clean page the gap nearly vanishes.

### Rule 10: Acknowledge the counter-evidence

When sources disagree, say so and cite both. Hiding the inconvenient data gets caught and costs more credibility than the disagreement ever would.

**Good:**
> The vendor publishes 24-hour battery numbers. Independent testing complicates that: one 36-hour test found a rival used 9% less power. The honest read is that the gap is smaller than the marketing implies.

### Rule 11: Conclusions deliver a verdict, not a recap

End by telling different readers what to actually do. No "in conclusion", no "to sum up", no restating the intro.

**Bad:**
> In conclusion, we explored several options. Each has pros and cons. Choose what fits your needs best. Thanks for reading!

**Good:**
> Battery-first and all-Apple: Safari, no contest. Tied to Microsoft 365: the other one, and eat the heavier memory. Running both anyway: stop treating it as a choice and fix the tab sprawl instead.

---

## Part 4: Tone

### Rule 12: Opinionated but self-aware

Have a take. Own that it is a take. Confidence without arrogance.

**Bad (no stance):**
> Both options are viable depending on your preferences.

**Bad (overclaiming):**
> This is objectively the only correct choice and anyone who disagrees is wrong.

**Good:**
> Tool A is the right default for most people. Reasonable people pick B for the offline mode, and that's a fair trade if you need it.

### Rule 13: Honest about limits and small numbers

Especially in build-in-public or founder writing: real numbers, even unflattering ones, build more trust than vague greatness.

**Bad:**
> Our user base is growing rapidly and engagement is through the roof.

**Good:**
> 58 weekly actives at the peak, down to 30 after a slow month. Small, but the retention curve finally bent the right way.

### Rule 14: Don't lecture

Drop the preachy second-person imperatives stacked one after another. Explain; let the reader conclude.

**Bad:**
> You need to optimize your workflow. You should organize your tabs. You must adopt these habits to succeed.

**Good:**
> Most of the time-loss isn't the number of tabs, it's not being able to find the one you want. Group them by project and that mostly goes away.

---

## Part 5: A blacklist you can grep

Words and phrases to search-and-destroy after drafting. Not every one is always wrong, but each is a high-probability AI tell, so default to cutting.

```
delve            dive into          deep dive
leverage         utilize            seamless / seamlessly
robust           streamline         supercharge
game-changer     revolutionize      cutting-edge
unlock           empower            elevate your
foster           navigate (figurative)   landscape (= industry)
in today's fast-paced     in this digital age     it's no secret that
at the end of the day     without further ado     buckle up
stay tuned       the bottom line is (as an opener)
needless to say  it goes without saying   when it comes to
that being said  rest assured       a testament to
in conclusion    to sum up          to wrap up
moreover         furthermore        consequently (as an opener)
```

**Sentence patterns to grep and kill (not single words):**

```
"not X, it's Y"        "doesn't X, it Y"      "isn't just X, it's Y"
"not only X but Y"     "the question isn't"   "it's not about X, it's about Y"
```

Search " not ", "isn't", "n't just" after drafting. Any sentence balancing two opposed ideas in parallel grammar gets flattened to one direct claim (Tell 6).

---

## Part 6: Self-check (run after every draft)

Read the draft once out loud in your head, then check:

1. **Verdict present?** Does the opening commit to an answer, not hedge? Does the conclusion tell different readers what to do?
2. **Rhythm varied?** Are there back-to-back sentences of near-identical length? Break one. Is there at least one short, blunt sentence doing emphasis work?
3. **Blacklist clean?** Grep the Part 5 list. Cut or replace every hit.
3a. **Negation flip killed?** Search " not ", "isn't", "n't just". Any "X not Y" / "isn't X, it's Y" sentence gets flattened to one direct claim (Tell 6). This is the highest-priority single check.
4. **Specifics sourced?** Every number, percentage, date, version: is it sourced or honestly hedged? Delete orphans.
5. **Limits named?** Did you say anywhere the thing falls short, or is it all upside? Add the honest caveat.
6. **Structure uneven?** Are all lists perfectly parallel, all paragraphs the same size? Make them lopsided where reality is lopsided.
7. **Throat-clearing cut?** Search for "It's worth noting", "It's important to", "When it comes to", "At its core". Delete and say the thing directly.
8. **Contractions present?** If the prose refuses every contraction, it reads stiff. Loosen it.

If a draft passes all eight, it will read like a person wrote it.

---

## Appendix: the recurring "moves" in this voice (optional, for consistency across a team)

These are the specific structural habits that make the SupaSidebar content recognizable. Reuse them in any project to keep a consistent hand; ignore them if a project wants a different feel. They are illustrative, not mandatory.

- **The "three measurable reasons" verdict.** "X is the better pick for three reasons: A, B, and C" - then each gets a sourced sentence. Concrete, scannable, citable.
- **The "It does NOT cover" scope fence.** A sentence early on naming what is out of scope. Builds trust, prevents "but what about" complaints.
- **The "the honest answer/caveat" turn.** A paragraph that opens with "The honest caveat:" or "The honest read is" and admits where the simple story breaks down. This is the single most credibility-building habit in the set.
- **The "most people don't actually pick one" reframe.** Reframing a binary "A vs B" into "you'll use both, here's how to not drown" - turns a comparison into a workflow.
- **Verdict + source + specific number, all three.** Never "X is fastest." Always "X is fastest (per [source]'s test, Y% faster)."
- **Short punch after a long build.** A multi-clause sentence doing the explaining, then a three-word sentence landing the point.

---

## Part 7: Founder-voice social addendum (2026-07-03, from the X-writer RD log)

Rules extracted from real Bro rejections of social drafts (X/LinkedIn). They
apply to any FOUNDER-VOICE channel (X, LinkedIn, Reddit founder posts), on top
of Parts 1-6. Blog prose keeps its own register.

1. **Register beats rules.** A draft can pass every checklist and still be AI
   slop if the register is "good content" instead of the person's actual
   typing. Final gate: put the draft next to 3 real samples of the person's
   writing; kill any sentence they would not type.
2. **Zero rhetorical devices in founder voice.** No coined metaphors ("the new
   homepage", "the entire shelf"), no parallel constructions, no audience
   callouts ("founders,"), no screenshotable lines. Literal beats metaphor,
   always - the plain description costs nothing.
3. **Delete-the-last-line test.** After drafting, delete the final line. If
   the piece got better or lost nothing, it stays deleted. Slop concentrates
   at the close, where writers perform (aphorism punches, guru imperatives,
   "most people" foils).
4. **One stat per post.** A comparison counts as one stat (8% with vs 15%
   without = one finding). Two unrelated stats read as a newsletter.
5. **Source-name jargon test.** Name a source only if the median reader
   recognizes it without googling (princeton, chatgpt, gsc: yes; pew, bain:
   no). Otherwise describe it plainly ("a study that tracked real browsing")
   and give the name in a reply when asked.
6. **First-person verbs are event claims.** "i asked", "i see", "i almost
   quit" - each must be true or Bro-confirmed. Invented EVENTS are
   fabrication (hard fail); invented feelings are merely editable.
7. **Studies get retold like telling a friend** ("some princeton folks ran
   10k queries"), never in abstract register ("the study demonstrated a 40%
   improvement in visibility").

Source log: projects/Beamcite/twitter-format-research/REJECTED-DRAFTS.md
(RD-1 bolt-on receipt, RD-2 "most people" foil, RD-3 register failure).

---

*This guide captures a writing style, not a rulebook to follow mechanically. The point of every rule above is the same: sound like a specific person who knows the topic and respects the reader's time. When a rule and that goal conflict, the goal wins.*
