# The AI Tells Catalog (the REMOVE list)

Everything on this list is what expert readers and corpus studies identify as machine signal. Each entry: the tell, the evidence tier, confidence. Sources resolved in `05-sources.md`.

Evidence tiers: A = corpus-measured in peer-reviewed work. B = peer-reviewed qualitative / expert-coded. C = strongly observed by practitioners, not yet quantified. F = folklore, do not rely on it.

> EXPANSION (2026-07-17): the full REPLACE dictionary now lives in `08-conversion-dictionary.md`: ~150 single-word swaps (from the Kobak 900-word corpus, `style`-tagged), a measured phrase/n-gram kill-list, transition-word swaps, the human INJECT inventory, and worked sentence conversions. This file `02` stays the ranked evidence catalog; `08` is the working dictionary the pipeline greps. For full-blog inputs also run `09-long-form-protocol.md`. Live-signal caveat: the oldest famous words (delve, intricate, underscore) have been FADING since ~April 2024 as models and users react; phrase-level and register-flatness tells are now stronger than any single word (confidence 80%).

---

## 1. Word level

| Tell | Tier | Confidence |
|---|---|---|
| Focal words: delve/delves/delving, underscore(s), intricate, showcasing, boasts, crucial, pivotal, comprehensive, utilize, align(s), surpassing, garnered, realm, groundbreaking, meticulous, notable, commendable, innovative, versatile, vibrant, significantly | A (Kobak; Juzek & Ward; Liang ICML; Russell expert-coded) | 95% |
| Extreme-inflation words: camaraderie, tapestry (~150x human rate), palpable, unease | A (Reinhart PNAS) | 95% |
| Inflated evaluative adjectives in formal prose (praise-adjective clusters) | A (Liang ICML 2024, peer reviews) | 90% |
| Equivocal connectives at odd rates: however, although, but (frequency pattern separated AI at >99% in one narrow domain) | A (Desaire, in-domain only) | 80% in-domain |
| Missing: swearing, slang, regionalisms, dated references | B/C (HC3: human answers more colloquial) | 70% |

Word-level warning: viral "banned word" lists online are only partially measured. Confirmed sets are Kobak's (the full 900-word `style` set, now in `08`), Juzek & Ward's focal words, Liang's adjectives, and Reinhart's inflated words. NOTE: "testament to" IS now corpus-confirmed at the PHRASE level (see below), it just was not in the earlier single-word lists.

## 1b. Phrase level (n-grams) - now the stronger live signal

| Tell | Tier | Confidence |
|---|---|---|
| "a testament to the" measured at ~163 opm in AI text vs ~0 opm human; "testament to" ~222 vs ~7 opm | A (AI-Brown / AI-Koditex corpus, arXiv:2509.22996) | 90% |
| "plays a crucial/vital/pivotal/significant role in", "stands as a testament to" | A/B (corpus + WikiProject) | 80% |
| Framing openers: "In today's fast-paced world", "In the ever-evolving landscape of", "When it comes to", "Navigating the complexities of" | B (WikiProject AI Cleanup) | 70% |
| Filler-emphasis: "It's important to note that", "It's worth noting", "Needless to say", "At the end of the day" | B (WikiProject AI Cleanup) | 70% |

Why phrases beat single words now: they survive single-word swaps, and vendors have not patched them the way they patched "delve". The full kill-list with rewrites is in `08` Part 2.

## 2. Sentence level

| Tell | Tier | Confidence |
|---|---|---|
| Uniform sentence lengths (low burstiness/variance). It is the VARIANCE that tells, not the mean | A (Munoz-Ortiz) | 85% |
| Nominalization overload: 1.5-2x human rate (turning verbs into abstract nouns: "the implementation of", "the utilization of") | A (Reinhart PNAS; HAP-E) | 90% |
| Present participial clauses at 2-5x human rate ("..., highlighting the importance of...", "..., showcasing its ability to...") | A (Reinhart PNAS; HAP-E) | 90% |
| "That"-clauses as subjects, heavy phrasal coordination | A (HAP-E) | 85% |
| Noun-heavy informationally dense register regardless of genre (register-flatness) | A (Reinhart; Milicka; Goulart) | 90% |
| Em-dash overuse, often space-surrounded, in "punched-up" positions | A-weak (arXiv 2603.27006) but unreliable alone; vendors patching it | 70% |
| Agentless passives: model-dependent (GPT-4o used HALF the human rate; others more). Not a stable tell | A but unstable | 50% |

## 3. Structure level

| Tell | Tier | Confidence |
|---|---|---|
| Rule-of-three everywhere: triplet adjectives, triplet examples, triplet clauses | B/C (Gorrie; Wikipedia editors; no corpus count) | 60% |
| "It's not X, it's Y" / "not just X but Y" antithesis (negative parallelism) - WikiProject AI Cleanup ranks this the #1 recognizable structural tell | B (WikiProject AI Cleanup 2024-25; Gorrie) | 65% |
| False ranges: "From X to Y" / "Whether it's A, B, or C" implying a spectrum that is not real | B (WikiProject AI Cleanup) | 65% |
| Over-signposting: "In this article we will...", "In conclusion", section-recap sentences | B/C (Wikipedia editors; Russell expert-coded "formulaic structure" ranked #2) | 75% |
| Formatting overkill: reflexive bolding of key terms, "**Term:** definition" bullets, emojis in headers, numbered lists where prose fits | B (WikiProject AI Cleanup) | 70% |
| Longer paragraphs than human baseline | A (Desaire, in-domain) | 80% in-domain |
| Formulaic document skeleton: intro-3-points-conclusion symmetry, every section same shape | B (Russell et al.: #2 expert cue) | 85% |
| Tidy single-track narrative, over-explained themes (fiction) | B (StoryScope) | 70% |
| Uniform paragraph lengths | F (folklore, never measured) | - |

## 4. Content / stance level

| Tell | Tier | Confidence |
|---|---|---|
| No hedging: missing may/might/perhaps/I think; boosters and hedges both suppressed vs human 3-4:1 hedge-rich baseline | A (Jiang & Hyland; Hyland) | 85% |
| No first-person stance or personal asides in argumentative prose (~50% fewer pronouns) | A (genre-dependent) | 65% |
| Emotional flatness: less fear/disgust, more even-keeled joy; inoffensiveness as a style | A (Munoz-Ortiz) | 70% |
| No concrete lived specifics: no named places, prices, dates, sensory details from memory | B (Opara framework; Russell "vagueness" cue) | 75% |
| Zero mechanical errors (humans: ~1-3% word error rate unedited, 80% of typos are single-error events) | A (Damerau; Mizumoto comparative) | 85% |
| Uniform formality, "suspicious clarity", lack of originality | B (Russell expert cue #3) | 80% |
| Idea redundancy: outputs cluster; every essay makes the same points | A (homogenization studies) | 75% |
| Balanced both-sides-ism, refusal to take a position | B/C | 65% |

## 5. Meta-tells (document level)

- Every section is the same temperature. Humans run hot and cold within one piece.
- The piece could have been written by anyone about anything: no idiolect, no self-reference, no history with the topic.
- Perfect coherence: no digressions, no abandoned asides, no "anyway, back to the point".

## Priority order for removal (what expert detectors key on, ranked)

1. AI vocabulary (the #1 expert cue, Russell et al.)
2. Formulaic sentence and document structure (#2)
3. Uniform formality / suspicious clarity / vagueness (#3)
4. Missing stance (hedges, first person, opinion)
5. Missing burstiness
6. Punctuation artifacts (em-dashes) last; weakest signal, easily patched
