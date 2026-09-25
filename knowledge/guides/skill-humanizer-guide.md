# Skill guide: humanizer

Source of truth for the `humanizer` skill (thin wrapper at `_staging/_skills/humanizer/SKILL.md`). Rewrite AI-generated text so it reads as human. Grounded ENTIRELY in the evidence base at `humanizer-research/` (files `01`-`09`). If a rule is not in those files, it is not in this skill.

Evidence base map:
- `01-research-findings.md` - the full write-up, every claim + confidence.
- `02-ai-tells-catalog.md` - the ranked REMOVE catalog (words, phrases, structure).
- `03-human-features-catalog.md` - the INJECT catalog.
- `04-detectors-and-evasion.md` - detectors and what beats them.
- `05-sources.md` - every source.
- `06-flowchart.md` - the pipeline spine.
- `07-assembly.md` - the build spec + base prompts.
- `08-conversion-dictionary.md` - the BIG replace table: ~150 word swaps, the phrase kill-list, transition swaps, the human inject inventory, worked conversions. Stage 1 greps this.
- `09-long-form-protocol.md` - the full-blog protocol. Baked into the "Long-form handling" section below.

Plus one workspace evidence file, outside the research base:
- `guides/humanizer-caught-tells-ledger.md` - tells CAUGHT IN OUR REAL DRAFTS by operator critic passes. MANDATORY: read it before Stage 1, scan the draft against every entry, re-check at Stage 5, and append any NEW tell caught in the same session. This is production evidence, not folklore; it carries the same weight as the research catalog. Author-specific caps (e.g. the Charlie profile's 14-item hard-rule list for Trophy) stack on top of it.

## Hard boundaries (read first)

1. ONLY use the evidence in `humanizer-research/`. No generic "humanization tips", no viral banned-word lists, no burstiness threshold numbers. The research flags those as folklore (DO-NOT-USE list below).
2. Never invent facts. Aggressive humanizing introduces hallucinated specifics; that is the main failure mode. Where a concrete detail would help but you do not have it from the source, leave a `[SPECIFIC: ...]` placeholder. Confidence: 85%.
3. Minimum passes. One clean rewrite is nearly free on meaning; each extra aggressive pass costs meaning, fluency, accuracy (the trade-off law). Stop as soon as the target bar is cleared. Confidence: 82%.
4. Report confidence per claim, matching the operator's standing preference.
5. No em-dashes. Use hyphens or commas.

## Step 0: Set the target reader AND the length (both set the difficulty)

Target reader decides how many stages:
- General audience: lay readers cannot tell AI from human (~50%, coin flip). Stages 1-3 are enough. Confidence: 92%.
- Expert reader or adversarial detector: frequent-LLM-user experts catch AI at ~93% on vocabulary and formulaic structure that cheap paraphrase leaves intact. Run all 5 stages, looped. Confidence: 92%.
- Default to the expert bar if unsure; the lay reader is already fooled.

Length decides whether to chunk:
- Under ~400 words: run the five stages once. Skip the long-form protocol.
- Over ~400 words, or any full article with headings: run the five stages INSIDE the Long-form handling section below (segment, lock one voice, then a document-level pass). Do NOT run the five stages once over a whole blog; the model regresses to the AI register mid-document and the rhythm/voice tells reappear at section scale. Confidence: 80%.

## The pipeline (from 06-flowchart.md)

Order is evidence-based: strip words first (the #1 expert cue), rhythm second (a distribution property), stance third, voice fourth (on already-clean text), test last.

### Stage 1: Strip the AI tells (from 02 + the full 08 dictionary + the caught-tells ledger)

0. Caught-tells ledger first. Scan the draft against every entry in `guides/humanizer-caught-tells-ledger.md` (echo-stamp verdicts, body/FAQ paraphrase-twins, symmetric equations, colon labels, and the rest). These are the tells that have already survived earlier passes in this workspace, so they are the most likely residue.

1. AI vocabulary (the #1 cue). Grep and replace against the FULL dictionary in `08` Part 1 (~150 words), not just the old two dozen. Tier A-core is highest priority (delve, underscore, intricate, showcasing, boasts, crucial, pivotal, comprehensive, utilize, align, meticulous, commendable, notable, tapestry, camaraderie, palpable, vibrant, significantly, realm, groundbreaking, surpassing, garnered, innovative, versatile); Tier A-extended adds the Kobak style set (leverage, harness, foster, bolster, seamless, robust, transformative, landscape, testament, and ~120 more). Prefer the plain alternative in `08`, and DELETE the word where meaning survives. Obey the over-correction guard in `08`: flag list, not ban list. Confidence: 95% detection, replacements editorial.
2. AI phrases and structure (`08` Part 2 + `02` sections 1b/3). Kill the measured n-grams ("a testament to the", "plays a crucial role in", "in today's fast-paced world", "it's important to note that"), negative parallelism ("it's not X, it's Y"), false ranges ("from X to Y"), formatting overkill (reflexive bolding, emoji headers), over-signposting, compulsive summaries ("In conclusion"). Rewrite these from the point; do not word-swap them. Confidence: 60-90%.
3. Transitions (`08` Part 3). Do not delete all connectives; VARY them. Swap heavy uniform Additionally/Moreover/Furthermore/However/Thus stacking for a lighter mixed set (Also, And, But, So, or a bare start). Uniform connective stacking is itself the tell. Confidence: 85%.
4. Nominalizations (verb-to-noun: "the utilization of X" -> "using X") and present-participial tag clauses ("..., highlighting the importance of Y"). These run 1.5-5x human rate. Confidence: 90%.
5. Em-dash pile-ups last. Weakest signal, easily patched, unreliable alone. Confidence: 70%.

### Stage 2: Rebuild the rhythm (from 03)

- Force sentence-length VARIANCE (burstiness): mix very short sentences with long ones; no two adjacent sentences the same length. It is the variance that reads human, not a short average. No numeric target. Confidence: 85%.
- Prefer shorter constituents even inside long sentences. Confidence: 80%.
- Allow fragments and And/But/So openers where register fits. Confidence: 70%.

### Stage 3: Inject human signals (from 03 + 08 Part 4)

Pull the actual words to add from the human INJECT inventory in `08` Part 4. Removing AI words leaves flat clean text, which still reads as AI to an expert, so this stage is not optional.
- Hedging: may/might/probably/I think where the author would really be uncertain. Human reflective prose runs hedges over boosters ~3-4:1. Confidence: 80%.
- Take one clear position instead of both-sides-ing. Let emotional temperature vary (one part warmer or sharper). Confidence: 70%.
- First-person presence and one short aside where register allows. Confidence: 80%.
- One concrete anecdote or named specific (tool, price, date, place) IF supported by the source; otherwise a `[SPECIFIC: ...]` placeholder. Confidence: 75%.

### Stage 4: Apply a real voice (from 03 + 07)

Biggest lever for human judges. ONE coherent persona with a stable idiolect, not a scatter of quirks (experts catch "performed humanity").
- With writing samples: study sentence length and variance, favorite openers, contraction rate, hedging, punctuation habits, formality, common transitions. Copy the rhythm and word HABITS, not the content. Apply any consistent informal move consistently. Confidence: 80%.
- Batch voice-frequency guard: a favorite opener is not a persona. Before drafting sibling items, count distinctive opening words across the full batch and compare them with the source samples. Never promote one observed opener into a repeated prefix. Per caught-tells ledger entry 25, `wait` is prohibited in generated Avery-style replies unless the operator explicitly allows it again. Confidence: 100% for the operator rule; broader frequency matching is editorial.
- No samples: one coherent default persona, kept consistent (Turing-test: 36% -> 73% with a persona). Confidence: 85%.
- Keep imperfection CONSISTENT, not sprinkled. No typos in a formal/edited register. Confidence: 85%.

### Stage 5: Test it, then loop (from 04 + 07)

Run the critic prompt below. Also re-check the draft against `guides/humanizer-caught-tells-ledger.md`; the critic prompt alone has missed ledger tells before (the echo-stamp verdicts survived three passes). If it fails the target bar or flags invented facts, feed the findings back to Stage 1. If the pass caught a tell not yet in the ledger, append it in the same session. Loop until the bar is cleared AND the fact check is clean. Minimize passes.

## Long-form handling (full blogs, from 09) - run this whenever input is over ~400 words

Do NOT run the five stages once over a whole blog. Run them inside this wrapper.

Step A - Segment, do not blend. Split on real structure: intro, each H2/H3, FAQ, conclusion. Keep headings, code, quotes, tables, and any number/name/date/stat untouched (those are not prose; humanizing them corrupts facts). Work section by section so the model does not regress to the AI register mid-generation. Confidence: 80%.

Step B - Lock the voice spec ONCE, before section one. If samples: extract the fingerprint once (sentence-length range, contraction rate, favorite openers, hedge rate, punctuation, formality, 3-5 stock transitions) and pin it. If no samples: pick ONE default persona and pin it. Reuse the same spec verbatim on every section so voice does not drift. Confidence: 80%.

Step C - Run stages 1-3 per section, stage 4 with the locked spec. Vary WHICH human moves you use by section (do not open every section with a question; do not put a hedge in the same slot each time). Confidence: 75%.

Step D - Document-level pass (the step short-form skips). After all sections are done, read the WHOLE thing and fix what is only visible at document scale:
- Global burstiness: section-average sentence lengths should differ from each other, not just within-section.
- Cross-section word repetition: grep the finished draft for each `08` word; if one replacement now appears 5-6+ times, vary it. This is the most common long-form residue.
- Opener repetition: cap how many sections/paragraphs open with the same word or shape.
- Structural symmetry: if every H2 is the same length and shape, break it (formulaic skeleton is the #2 expert cue).
- One temperature shift: let at least one section run warmer or sharper than the rest.

Step E - Full-document test + fact pass. Run the Stage 5 critic over the WHOLE document (so it catches symmetry, repetition, uniform temperature), then a separate fact pass. The longer the piece, the more places a hallucinated specific can hide. Every `[SPECIFIC: ...]` must still be a placeholder or a source-backed fact. Confidence: 85%.

When NOT to chunk: under ~400 words, or anything that is mostly data/code/tables/quotes (humanize only the connecting prose).

## Drop-in prompts (from 07)

Structured and example-driven because naive "write like a human" prompts are weak on their own.

Stage 1-2 (strip and rhythm):
```
You are editing AI-generated text to remove machine-writing signals. Do NOT
change the meaning or invent facts. Rewrite the text below:
1. Delete or replace AI-vocabulary words using the plain alternatives in the
   conversion dictionary (delve, underscore, intricate, showcasing, boasts,
   crucial, pivotal, comprehensive, utilize, align, meticulous, commendable,
   notable, tapestry, camaraderie, palpable, vibrant, significantly, realm,
   groundbreaking, leverage, harness, foster, bolster, enhance, seamless,
   robust, transformative, landscape, testament, and the rest). Delete the word
   where the meaning survives.
2. Kill AI phrases and rewrite from the point, not by word-swap: "a testament
   to", "plays a crucial role in", "in today's fast-paced world", "it's
   important to note that", "it's not X, it's Y", "from X to Y", "In conclusion".
3. Vary transitions: replace uniform Additionally/Moreover/Furthermore/However/
   Thus stacking with Also/And/But/So or a bare sentence start.
4. Break nominalizations into verbs ("the utilization of X" -> "using X").
5. Remove present-participial tag clauses ("..., highlighting the importance
   of Y").
6. Force sentence-length variance: no two adjacent sentences the same length.
Return only the rewritten text.
```

Stage 3 (inject human signals):
```
Revise this text so a real person clearly wrote it. Keep all facts accurate.
Do not invent claims, statistics, or events not in the source. Where a concrete
detail would help and you have it from the source, use it; otherwise leave a
[SPECIFIC: ...] placeholder.
- Add hedging where the author would be uncertain (roughly 3 hedges per strong
  claim).
- Take one clear position instead of listing both sides evenly.
- Add first-person presence and one short aside if the register allows.
- Add one concrete anecdote or named specific IF supported by the source.
- Vary emotional temperature: let one part run warmer or sharper.
Return the revised text with any [SPECIFIC: ...] placeholders left for review.
```

Stage 4 (apply voice, with samples):
```
Here are writing samples from one person:
<<<SAMPLES>>>
Study their voice: sentence length and variance, favorite openers, contraction
rate, hedging, punctuation habits, formality, common transitions. Do NOT copy
their content. Rewrite the following in exactly this person's voice, keeping all
facts intact:
<<<TEXT>>>
Match their rhythm and word habits. Apply any consistent informal move
consistently, not randomly.
```

Document repetition pass (long-form Step D):
```
Here is a full humanized article. Do NOT rewrite it. Audit it at the whole-
document level and return a list:
1. Any word that now appears 5+ times across the article (give counts).
2. Any sentence-opener word or shape repeated across 3+ paragraphs.
3. Sections that are all the same length / same intro-body-wrap shape.
4. Whether the emotional temperature is uniform across all sections.
For each, name the fix. Do not change the text; just report.
```

Stage 5 (test):
```
You are a frequent LLM user who is very good at spotting AI writing. Read the
text below. List every remaining machine-writing signal: AI-vocabulary words,
formulaic structure, uniform sentence lengths, missing stance, over-clean prose,
or vagueness. Quote each phrase and say what a human would do instead. Give a
0-100 "reads as human" score. Separately: list any factual claim that looks
invented or unsupported.
```

## DO-NOT-USE list (folklore the research rejected)

- Numeric burstiness thresholds ("human 0.65-0.85, AI below 0.30"). Vendor folklore. Target variance qualitatively.
- Viral banned-word lists beyond the corpus-confirmed sets in `02`/`08`.
- "Uniform paragraph lengths" as a tell (never measured; AI paragraphs measured LONGER).
- "Humans use more profanity" (not supported).
- "Add a few typos and it passes" as a standalone tactic (directional only; experts are not fooled by typos).
- "AI has low lexical diversity" as a universal (direction flips by baseline; safe version: "AI diversity is homogeneous across outputs, not human-like").

## Output format

1. The humanized text (with any `[SPECIFIC: ...]` placeholders).
2. What was changed, by stage (and, for long-form, the document-level fixes from Step D).
3. A "reads as human" score from the Stage 5 critic and the target bar it aimed at.
4. A fact-check note (anything that looked invented).
5. Per-claim confidence, no em-dashes.

## Honest limitation to surface to the user

Detection is an arms race, not a solved problem. The word lists and syntax stats are time-stamped to the GPT-3.5 to GPT-4.5 / Llama 3 era and drift; the oldest famous words (delve, intricate, underscore) have been FADING since ~April 2024, so phrase-level tells and register-flatness now matter more than any single word. The pipeline STRUCTURE (strip, rhythm, stance, voice, test) is more durable than any specific list. "Reads as human to a person" and "beats a detector" are different targets. Position on genuine voice quality, and never trade factual accuracy for human-ness. Full evidence: `humanizer-research/01`-`09`.
