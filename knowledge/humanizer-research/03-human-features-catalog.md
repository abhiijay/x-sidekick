# The Human Features Catalog (the INJECT list)

What the linguistics, stylometry, and psycholinguistics literature says human writing actually has. Each with evidence tier (A = corpus-measured peer-reviewed, B = peer-reviewed qualitative, C = practitioner) and confidence. Sources in `05-sources.md`.

---

## 1. Rhythm and form

| Feature | Detail | Tier | Confidence |
|---|---|---|---|
| Burstiness | Scattered sentence-length distribution: 3-word sentence next to a 40-word one. Variance, not short mean length | A (Munoz-Ortiz) | 85% |
| Shorter constituents, optimized dependency distances | Humans chunk phrases smaller even in long sentences | A (Munoz-Ortiz) | 80% |
| Register shifting | Humans change style with situation, even within a piece (formal point, then a casual aside). LLMs hold one register | A (Reinhart; Goulart) | 90% |
| Imperfect structure | Digressions, asides, uneven sections, a point revisited later | B/C | 70% |

## 2. Stance and voice

| Feature | Detail | Tier | Confidence |
|---|---|---|---|
| Hedging | may, might, would, possible, "I think", "probably". Human academic prose: hedges outnumber boosters 3-4:1 | A (Hyland; Jiang & Hyland) | 85% |
| Epistemic and attitude markers | "surprisingly", "unfortunately", "to be honest", judgment words that commit the author | A (Herbold; Mizumoto) | 90% |
| First-person presence | I/we/my with real referents; personal asides ("this took me a weekend to figure out") | A/B (Goulart; Jiang & Hyland) | 80% |
| Actual opinion | Taking a side, disagreeing with someone, mild irritation. Humans show fear/disgust; AI shows flat pleasantness | A (Munoz-Ortiz) | 70% |
| Engagement moves | Direct questions to the reader, "you" address, imperatives | A (Jiang & Hyland: students significantly richer in engagement features) | 85% |

## 3. Content texture

| Feature | Detail | Tier | Confidence |
|---|---|---|---|
| Concrete lived specifics | Named tools, prices, dates, places, versions, sensory detail pulled from memory, not category words | B (Opara; Russell vagueness cue inverted) | 75% |
| Anecdote | A short real story with a non-generic detail. Best-supported as a human-perception move, weaker as detector evasion | B | 70% |
| Idea novelty | Each human adds ideas others didn't; avoid making only the consensus points an LLM makes every time | A (homogenization studies) | 75% |
| Moral ambiguity, loose ends (narrative) | Unresolved threads, mixed motives, timelines that jump | B (StoryScope) | 70% |
| References with history | "I've used X since 2019", callbacks to earlier points, dated cultural references | C | 60% |

## 4. Idiolect (the personal fingerprint)

| Feature | Detail | Tier | Confidence |
|---|---|---|---|
| Function-word profile | Individuals are identifiable from frequencies of common function words alone; a voice model must copy these, not just content words | A (Grieve; 100 years of stylometry) | 95% |
| Personal register | Individual style = a personal bundle of situational choices; one person's "casual" differs from another's | A (Grieve 2023) | 85% |
| Characteristic tics | Personal filler/discourse-marker preferences (one speaker: only "uh"; another: only "um"; spread 1.2-88.5 per 1,000 words). In writing: favorite transitions, favorite sentence openers, favorite punctuation habits | A (Clark & Fox Tree, speech; bridge to writing via discourse markers) | 75% |
| Consistent imperfection | Real typo patterns are 80% single-error events (one swap/drop/insert), at ~1-3% of words in UNEDITED registers only. Polished registers have near-zero; do not sprinkle typos into a formal report | A (Damerau) | 85% |

## 5. Informality markers (register-dependent, use only where the register licenses them)

- Contractions (don't, it's, can't). Lay readers read these as human (Jakesch), experts expect them where register fits.
- Discourse markers: well, anyway, look, honestly, I mean.
- Sentence fragments. Used deliberately. Like this.
- Starting sentences with And/But/So.
- Mild redundancy and self-correction ("or rather", "actually, scratch that").
- Lowercase/casual conventions in social registers (matches Bro's existing human-voice-for-social rule at ~80/20 dose).

## The dosage warning

Every feature above is a seasoning, not a sauce. The Turing-test winner persona worked because it was a coherent PERSON (introverted 19-year-old, consistent knowledge limits, consistent typo style), not a checklist of quirks. Random quirk-sprinkling produces a new detectable pattern: expert readers catch "performed humanity". The unit of humanization is a persona with a stable idiolect, applied consistently, not per-sentence tricks. Confidence: 85% (Jones & Bergen persona result + Russell expert robustness to humanizer tools).
