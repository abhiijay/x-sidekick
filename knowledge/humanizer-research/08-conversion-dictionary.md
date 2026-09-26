# The Conversion Dictionary (the big REPLACE table)

Built 2026-07-17 to increase the potency of the Humanizer. This file is the expanded word, phrase, and transition dictionary the pipeline strips in Stage 1. It exists because the original `02-ai-tells-catalog.md` listed ~25 focal words, which is enough for a paragraph but misses most of the vocabulary in a full blog.

## How to read the tiers (provenance is not optional)

Two separate things carry confidence here, and they must not be blurred:

1. The DETECTION claim (this word/phrase is over-produced by LLMs). Evidence tiers, same as `02`:
   - A = corpus-measured in peer-reviewed or preprint corpus work.
   - B = expert-coded / community-cataloged (WikiProject AI Cleanup, named linguists).
   - C = practitioner-observed, not counted.
2. The REPLACEMENT itself (swap word X for word Y). The replacements in the right-hand columns are editorial judgment, tier C by nature. A corpus can prove "delve" is inflated; no corpus proves "look at" is the correct swap. The rule is: the flag is evidence-graded, the fix is a suggestion. Always keep meaning first (Hard boundary 2 in the skill).

The master word list this file draws from is the Kobak et al. 900-word "excess vocabulary" set (Science Advances 2025, `results/excess_words.csv` in berenslab/llm-excess-vocab), filtered to the rows tagged `style` (the `content` rows are biomedical topic words like "covid" and do not generalize). That filtering is the single biggest expansion over the old 25-word list. Detection confidence for the Kobak style set: 95% (corpus-measured). Confidence that a given style word is a tell OUTSIDE biomedical abstracts: 70% (the corpus is PubMed; the register transfers to formal prose but not perfectly).

Critical time-stamp caveat, stated up front: the most famous tells (delve, intricate, underscore) are FADING. arXiv work on arXiv itself found these words started dropping in frequency from about April 2024 as models and users reacted to the "bad reputation". So the earliest, most-quoted words are now the WEAKEST live signals, and newer register-flatness matters more than any single word. Do not treat this dictionary as permanent. Confidence: 80%.

---

## Part 1: Single-word replacements (tiered)

Format: AI word -> plain alternatives (pick by context; sometimes the right move is to DELETE the word, marked [cut]).

OVER-CORRECTION GUARD (read before mass-swapping): this is a flag list, not a ban list. Every one of these words is also used by real humans in the right spot. The failure mode of an aggressive humanizer is replacing a word that was fine and leaving a worse one, or flattening the writer's real vocabulary into baby-talk. Rule: swap only where the word is doing PUFFERY work (empty inflation), keep it where it carries real meaning, and never let a swap change the fact. If a section already reads human, leave it. A word appearing ONCE is usually fine; the tell is the same puffery word appearing repeatedly (see `09` Step D). Do not turn every "important" into "key" and every "use" was never the problem.

### Tier A-core: the original corpus-confirmed focal set (highest priority, but fading)

These are the words expert readers key on first (Russell et al. 2025) and the ones with the steepest measured post-ChatGPT spike (Juzek & Ward; Kobak; Reinhart). Detection tier A, confidence 95%.

| AI word | Plain alternatives |
|---|---|
| delve / delve into | look at, dig into, get into, cover, go through |
| underscore(s) / underscoring | show, point to, stress, [cut] |
| intricate | complex, detailed, fiddly, involved |
| showcase / showcasing | show, present, [cut] |
| boasts | has, comes with, includes |
| crucial | key, important, needed, [cut] |
| pivotal | key, central, major |
| comprehensive | full, complete, thorough, wide |
| utilize / utilise | use |
| align(s) / aligning | match, fit, line up, agree |
| meticulous / meticulously | careful, carefully, exact |
| commendable | good, solid, worth doing |
| notable / noteworthy | worth noting, [cut], or name the specific thing |
| tapestry | mix, range, [cut] (almost always empty) |
| camaraderie | teamwork, closeness, the group feel |
| palpable | clear, obvious, you could feel it |
| vibrant | lively, busy, bright, colorful |
| significantly | a lot, much, by far, [cut] |
| realm | area, field, world, space |
| groundbreaking | new, first-of-its-kind, [cut] |
| surpass(es) / surpassing | beat, do better than, go past |
| garner(ed) / garnering | get, earn, pick up, draw |
| innovative | new, fresh, [cut] |
| versatile | flexible, does a lot, works for many uses |

### Tier A-extended: style words from the Kobak 900-set (verb, adjective, adverb, noun)

Corpus-confirmed as excess vocabulary in the Kobak PubMed study (detection tier A within that corpus; 70% that each transfers to general prose). This is the bulk expansion. Grouped so the pipeline can grep them.

Verbs (over-produced "puffery" verbs):
| AI verb | Plain alternatives |
|---|---|
| leverage / leveraging | use, tap, draw on |
| harness / harnessing | use, put to work, tap |
| foster / fostering | build, grow, encourage, help |
| bolster / bolstering | back up, strengthen, boost, add to |
| enhance / enhancing | improve, boost, add to, sharpen |
| streamline / streamlining | simplify, tidy up, speed up |
| facilitate / facilitating | help, make easier, run, [cut] |
| enable / enabling | let, allow, make possible |
| empower / empowers | let, give people the ability to, help |
| elucidate / elucidating | explain, make clear, show |
| illuminate / illuminating | show, explain, shed light on |
| unveil / unveiling | show, reveal, launch, announce |
| unlock / unlocking | open up, make possible, get to |
| navigate / navigating | handle, deal with, work through, get around |
| encompass / encompassing | cover, include, take in |
| emphasize / emphasizing | stress, point out, put weight on |
| highlight / highlighting | point out, show, call out |
| demonstrate / demonstrating | show, prove, make clear |
| underpin / underpinning | support, sit under, drive |
| revolutionize / revolutionizing | change, remake, shake up |
| optimize / optimizing | tune, improve, get the most out of |
| cultivate / cultivating | build, grow, develop |
| spearhead / spearheading | lead, head up, drive |
| pioneer / pioneering | start, be first at, lead |
| exemplify / exemplifies | show, be a clear case of |
| necessitate / necessitates | need, call for, force, mean |
| yield / yielding | give, produce, lead to |
| pinpoint / pinpointing | find, locate, name exactly |
| scrutinize / scrutinizing | check, look hard at, go over |
| grapple / grappling | struggle, wrestle, deal with |

Adjectives (over-produced evaluative/inflation adjectives):
| AI adjective | Plain alternatives |
|---|---|
| seamless / seamlessly | smooth, clean, with no gaps |
| robust | strong, solid, holds up |
| transformative | big, game-changing, [cut] |
| unparalleled | unmatched, the best, [cut] |
| unprecedented | new, never seen before, first |
| invaluable | very useful, worth a lot, key |
| formidable | strong, tough, serious |
| remarkable / remarkably | notable, striking, [cut] |
| exceptional / exceptionally | very good, rare, [cut] |
| profound / profoundly | deep, big, [cut] |
| nuanced | subtle, has shades, not black-and-white |
| holistic | whole, all-round, full-picture |
| multifaceted | many-sided, complex, layered |
| foundational | basic, core, ground-level |
| paramount | top, most important, key |
| imperative | needed, must-do, [cut] |
| inherent | built-in, natural, part of |
| myriad | many, countless, a lot of |
| diverse | varied, mixed, a range of |
| dynamic | changing, lively, active |
| cutting-edge | new, latest, advanced |
| state-of-the-art | latest, top, best available |
| pressing | urgent, immediate |
| compelling | strong, convincing, hard to ignore |
| rich (as in "rich history/tapestry") | long, full, deep, or [cut] |
| vital | key, needed, central |
| daunting | hard, scary, tough |

Adverbs and connective adverbs (over-produced):
| AI adverb | Plain alternatives |
|---|---|
| notably | [cut], or name the thing |
| particularly | especially, [cut] |
| significantly | a lot, [cut] |
| substantially | a lot, by a wide margin |
| effectively | in practice, well, [cut] |
| ultimately | in the end, [cut] |
| consequently | so, that meant |
| subsequently | then, later, after that |
| additionally | also, and, plus |
| moreover | also, on top of that, and |
| furthermore | also, and, plus |
| thereby | so, which |
| thus | so |
| hence | so, that is why |
| increasingly | more and more |
| arguably | maybe, you could say, [cut] |

Nouns (abstract "puffery" nouns, often the head of a nominalization to break):
| AI noun | Plain alternatives / fix |
|---|---|
| landscape (the X landscape) | the X world, X today, [cut "landscape"] |
| realm | area, field, world |
| insights | findings, what we learned, points, tips |
| framework | plan, method, system, approach |
| paradigm | model, way of thinking, approach |
| synergy / synergies | working together, fit, combined effect |
| trajectory | path, direction, where it is heading |
| endeavor / endeavors | effort, project, work, try |
| avenue / avenues | option, route, way, path |
| testament (a testament to) | shows, proves, is proof of |
| cornerstone | base, foundation, key part |
| backbone | base, core, support |
| plethora | lots of, plenty of, many |
| array (a wide array of) | range, set, lots of |
| spectrum (a broad spectrum of) | range, mix (only if a real range exists; see false-range phrases) |
| interplay | how they affect each other, the back-and-forth |
| nuance | subtlety, small difference |
| prowess | skill, ability, strength |

### Tier B: community-cataloged words (WikiProject AI Cleanup)

Named in the Wikipedia "Signs of AI writing" guide as recurring AI vocabulary but not separately corpus-counted. Detection tier B, confidence 60-75%. Treat as secondary flags, not proof.

stark / starkly, boasting, rich cultural heritage, enduring legacy, breathtaking, must-see, must-visit, nestled (as in "nestled in the heart of"), stunning, treasure, gem, in the heart of, rich history, boasts a, stands as, continues to captivate, leave a lasting impression, ever-evolving, fast-paced, deep understanding, sense of.

---

## Part 2: The phrase / n-gram kill-list

Multi-word AI patterns are a STRONGER live signal than single words now, because they survive single-word swaps and vendors have not patched them. The AI-Brown / AI-Koditex corpus (arXiv:2509.22996, 2025) measured "a testament to the" at ~163 occurrences per million in AI text versus ~0 in the human reference corpus, and "testament to" at ~222 opm versus ~7 opm human. That is a cleaner separation than most single words. Detection tier A for the measured phrases, B for the cataloged ones.

Kill or rewrite these. Left = the AI phrase. Right = what a human does instead.

Opening / framing phrases (cut or replace with a real first sentence):
- "In today's fast-paced world" / "In today's digital age" / "In an era of" -> [cut, start with the actual point]
- "In the ever-evolving landscape of" / "In the ever-changing world of" -> [cut]
- "When it comes to X" -> "For X" or just start with X
- "Whether you're a X or a Y" -> name one real reader, or cut
- "Navigating the complexities of" -> "Dealing with" / "Working out"
- "Unlocking the potential of" / "Unlocking the power of" -> "Getting more out of" / "Using"

Filler-emphasis phrases (almost always deletable):
- "It's important to note that" / "It is worth noting that" / "It's worth mentioning" -> [cut, state the fact directly]
- "It's important to remember that" -> [cut]
- "Needless to say" -> [cut]
- "At the end of the day" -> [cut, or "in the end"]
- "It goes without saying" -> [cut]
- "One might argue that" -> "Some argue" / "You could argue"
- "It is crucial to understand" -> [cut, just explain it]

The "testament / role / play" family (corpus-confirmed heavy):
- "stands as a testament to" / "is a testament to" -> "shows" / "proves"
- "plays a crucial role in" / "plays a vital role in" / "plays a pivotal role" -> "matters for" / "helps" / "drives" / "is part of"
- "plays a significant role in" -> "affects" / "shapes"

False ranges (the "from X to Y" spectrum that is not a real spectrum; WikiProject AI Cleanup):
- "From X to Y" when X and Y are just two loosely related things -> name the two things plainly, drop the fake spectrum
- "Whether it's A, B, or C" padding -> cut to the one that matters

Negative parallelism / antithesis (the #1 recognizable structure tell per WikiProject):
- "It's not just X, it's Y" / "It's not X. It's Y." -> say Y directly
- "This isn't about X; it's about Y" -> say the point once

Closing / summary phrases (compulsive summaries):
- "In conclusion" / "In summary" / "Overall" / "To sum up" -> [cut in anything under ~1500 words; in long pieces, end on a real last point, not a recap]
- "Ultimately, the key takeaway is" -> [cut]
- "By following these steps, you can" -> [cut or make concrete]

Hedge-less booster clichés:
- "a game-changer" -> say what changed
- "the possibilities are endless" -> [cut]
- "take your X to the next level" -> [cut, name the specific gain]
- "in the world of X" -> "in X"

---

## Part 3: Transition-word swaps (the connective inventory)

AI over-uses a small set of heavy Latinate connectives at the start of sentences (Additionally, Moreover, Furthermore, Consequently, Thus, Therefore, However). Humans use a WIDER, lighter, and less uniform set, and often use none (they just start the sentence). The fix is not to delete all transitions, it is to vary them and lighten them.

AI-heavy transition -> human-lighter options (and often just cut it):
- Additionally / Moreover / Furthermore -> "Also", "And", "Plus", "On top of that", or [cut]
- However -> "But", "Still", "Though", "That said", or [cut]
- Therefore / Thus / Hence / Consequently -> "So", "Which means", "That is why"
- Nevertheless / Nonetheless -> "Even so", "Still"
- In addition -> "Also", "And"
- For instance / For example -> keep, but sometimes "Like" or "Say"
- Subsequently -> "Then", "Later", "After that"
- In order to -> "To"
- Due to the fact that -> "Because"
- With regard to / In terms of -> "For", "About", "On"

The deeper rule (from `03`, register-flatness): a human paragraph does not open every sentence with a connective. It mixes bare sentence starts, And/But/So openers, and the occasional heavier connective. Uniform "Additionally... Moreover... Furthermore..." stacking is itself the tell, even if each word were fine alone. Confidence: 85%.

---

## Part 4: The human INJECT inventory (what to add, not just remove)

Removing AI words leaves flat, clean text. Flat clean text still reads as AI to an expert. You have to add real human connective tissue. This is the counterpart dictionary. Grounded in `03-human-features-catalog.md`.

Hedges to add where the author would really be unsure (human prose runs hedges over boosters ~3-4:1; Hyland):
- maybe, probably, I think, I'd guess, seems like, as far as I can tell, roughly, more or less, from what I've seen, in my experience, my hunch is, could be, might, tends to, usually, often, not always.

Stance / attitude markers (commit the author, which AI avoids):
- honestly, to be fair, weirdly, annoyingly, surprisingly, thankfully, unfortunately, the frustrating part is, what I like is, the catch is, here's the thing, worth flagging.

First-person and reader-address moves (AI suppresses these in argument):
- "I ran into this when...", "we tried...", "you'll notice...", "if you've ever...", "let me show you", direct questions to the reader.

Light discourse markers / sentence openers (use sparingly, register-dependent):
- Anyway, Look, So, Right, Ok so, Here's the thing, The short version is, Bottom line.

Concrete-specific slots (the biggest human-perception lever; only fill from the source or mark a placeholder):
- a real number, a date, a price, a named tool, a version, a place, a small remembered detail. If not in the source: leave `[SPECIFIC: ...]`. Never invent (Hard boundary 2).

Dosage warning (carried from `03`): every item above is a seasoning. A coherent single persona applying a few of these consistently beats a scatter of all of them. Random sprinkling makes a NEW detectable pattern ("performed humanity", Russell et al.). Confidence: 85%.

---

## Part 5: How to actually convert a sentence (worked method)

The user asked for "exactly how to convert those sentences cleanly." The order per sentence:

1. Find the flagged word/phrase (Parts 1-2).
2. Ask: does the sentence need this word at all? If the meaning survives deletion, DELETE it (the cleanest fix, no new word to detect). Roughly half of "crucial / significantly / it's important to note" cases are pure deletions.
3. If it carries real meaning, swap for the plain alternative that fits the register (Parts 1-3).
4. If the whole sentence is a template (negative parallelism, false range, testament-to), rewrite the sentence from its actual point, do not word-swap it.
5. Re-read the sentence next to its neighbors. If three sentences in a row now have the same length or shape, break one (Stage 2, rhythm).

Worked examples (meaning held, no invented facts):

- AI: "In today's fast-paced world, leveraging AI can significantly enhance your team's productivity."
  Human: "AI can make your team faster. [SPECIFIC: by how much / at what task]"

- AI: "This feature stands as a testament to our commitment to a seamless user experience."
  Human: "We built this feature because the old flow kept breaking. [SPECIFIC: what broke]"

- AI: "It's important to note that comprehensive testing plays a crucial role in robust software."
  Human: "Testing is what keeps software from falling over. Skip it and you find the bugs in production."

- AI: "Moreover, the platform boasts an intricate array of customizable options."
  Human: "It also has a lot of options you can change. [SPECIFIC: name two people actually use]"

Notice what each rewrite does: cuts the opener, kills the puffery verb/adjective, breaks the nominalization, varies the sentence length, and marks a placeholder where a real detail is missing instead of inventing one.

---

## Provenance summary

- Single-word Tier A-core and A-extended: Kobak et al., Science Advances 2025 (`berenslab/llm-excess-vocab`, `results/excess_words.csv`, `style`-tagged rows); Juzek & Ward COLING 2025; Reinhart et al. PNAS 2025; Liang et al. ICML 2024. Detection 95% in-corpus, ~70% general-prose transfer.
- Phrase Part 2 measured items: AI-Brown / AI-Koditex corpus, arXiv:2509.22996 (2025). Detection tier A for measured phrases.
- Tier B words/phrases and structure tells (negative parallelism, rule of three, false ranges, formatting overkill, compulsive summaries): WikiProject AI Cleanup, "Wikipedia:Signs of AI writing" (2024-25), reported by NPR and TechCrunch 2025. Detection tier B, 60-75%.
- Fading-signal caveat: arXiv:2412.11385 (Juzek & Ward) and human-LLM coevolution work show the classic words declining from ~April 2024. Confidence 80%.
- All replacement columns: editorial (tier C). The flag is evidence-graded; the fix is a suggestion. Meaning first, never invent (Hard boundary 2).
