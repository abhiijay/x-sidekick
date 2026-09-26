# The Long-Form Protocol (full blogs, not paragraphs)

Built 2026-07-17. The original pipeline (`06`, `07`) was validated on short passages. It works, but it silently fails at blog length (1,000-3,000+ words) for three reasons this file fixes. If the input is longer than about 400 words, or is a full article with headings, run this protocol on top of the five stages, do not run the five stages once over the whole wall of text.

## Why one pass over a whole blog fails

1. The model regresses to the AI register mid-document. When you ask for a single rewrite of 2,000 words, the first 300 words come out human and the rest drifts back into "Additionally... this underscores... a testament to", because the model's own default register reasserts itself over a long generation. Confidence: 80% (observed failure mode; consistent with register-flatness being the model's attractor state, `01` Angle 1).

2. Sentence-length variance gets measured too locally. Burstiness (`03`) is a whole-document property. If you humanize section by section without a global view, each section can look varied on its own while every section has the SAME average and the SAME shape, so the document as a whole is still uniform. The tell is at the document scale. Confidence: 75%.

3. Voice consistency breaks across sections. A persona applied fresh to each chunk drifts: the intro is chatty, the middle is formal, the FAQ is chatty again. Real authors are not identical across a piece, but they are RECOGNIZABLY one person. Chunk-by-chunk humanizing without a locked voice spec produces "three different people wrote this", which experts catch as easily as they catch AI vocabulary. Confidence: 80%.

## The protocol

### Step A: Segment, do not blend

Split the blog on its real structure: intro, each H2/H3 section, FAQ, conclusion. Keep headings and any code, quotes, tables, or data untouched (those are not prose and must not be "humanized" or you will corrupt facts). Work section by section. This keeps each pass small enough that the model does NOT regress to the AI register mid-generation. Confidence: 80%.

### Step B: Lock the voice spec ONCE, before any section

Before touching section one, write a short voice spec and reuse it verbatim on every section:
- If the user gave writing samples: extract the fingerprint once (sentence-length range, contraction rate, favorite openers, hedge rate, punctuation habits, formality, 3-5 stock transitions) per `07` Part 2, and pin it.
- If no samples: pick ONE default persona and pin it (per `03` dosage rule and the Turing-test persona result: a coherent person beats a quirk-bag, 36% -> 73%, Jones & Bergen).
Pass this same spec into the Stage 4 prompt for every section so the voice does not drift. Confidence: 80%.

### Step C: Run stages 1-3 per section, stage 4 with the locked spec

For each section: strip (Stage 1, now using the full `08` dictionary), rebuild rhythm (Stage 2), inject stance/specifics that fit THAT section (Stage 3), then apply the locked voice (Stage 4). Vary WHICH human moves you use by section so you do not repeat the same tic in every section (do not open every section with a rhetorical question; do not put a hedge in the same slot each time). Confidence: 75%.

### Step D: The document-level rhythm and repetition pass (the step short-form skips)

After all sections are individually done, read the WHOLE thing back and fix what is only visible at document scale:
- Global burstiness: check that section-average sentence lengths differ from each other, not just within-section. If every section averages ~18 words, break some. Confidence: 75%.
- Cross-section word repetition: LLMs reuse the same "signature" verb across a whole piece (everything "unlocks", "empowers", "leverages", "delves into"). Grep the finished draft for each `08` word; if the same replacement now appears 6 times, vary it. This is the single most common long-form residue. Confidence: 80%.
- Opener repetition: count how many sections/paragraphs open with the same word or shape (Additionally / "When it comes to" / a question). Cap repeats. Confidence: 80%.
- Structural symmetry: if every H2 section is the same length with the same intro-body-wrap shape, break the pattern. Real articles have uneven sections (Russell et al.: formulaic document skeleton is the #2 expert cue). Confidence: 85%.
- One temperature shift: let at least one section run warmer, sharper, or more personal than the rest. AI holds one temperature across a whole document; humans do not (`02` meta-tells). Confidence: 70%.

### Step E: Full-document test and fact pass

Run the Stage 5 critic prompt over the WHOLE document, not per section, so it can catch document-scale tells (symmetry, repetition, uniform temperature). Then a separate fact pass: the longer the piece, the more places aggressive humanizing can have introduced a hallucinated specific (Hard boundary 2, the trade-off law). Every `[SPECIFIC: ...]` placeholder must still be a placeholder or a source-backed fact, never a made-up one. Confidence: 85%.

## Drop-in prompt additions for long-form

Stage 1 (per section) add-on:
```
This is ONE SECTION of a longer article. Rewrite only the prose. Do NOT touch
headings, code blocks, quotes, tables, or any number, name, date, or statistic.
Apply the full strip dictionary (words, phrases, transitions). Keep meaning exact.
```

Document-level repetition pass (Step D):
```
Here is a full humanized article. Do NOT rewrite it. Instead, audit it at the
whole-document level and return a list:
1. Any word that now appears 5+ times across the article (give counts).
2. Any sentence-opener word or shape repeated across 3+ paragraphs.
3. Sections that are all the same length / same intro-body-wrap shape.
4. Whether the emotional temperature is uniform across all sections.
For each, name the fix. Do not change the text; just report.
```

Then apply the fixes surgically, minimum passes (trade-off law).

## When NOT to use this protocol

- Text under ~400 words: the original single-pass pipeline is enough; this adds cost for no gain.
- Anything that is mostly data, code, tables, or quotes: humanize only the connecting prose, leave the rest exactly as-is. Corrupting a number to sound human is the worst possible failure.

## Provenance

Failure modes are practitioner-observed (tier C) but each maps to a corpus-measured property: register-flatness as the model attractor (`01` Angle 1, tier A), burstiness as a document-scale property (Munoz-Ortiz, tier A), formulaic document skeleton as the #2 expert cue (Russell et al. ACL 2025, tier A/B), persona coherence as the biggest human-judge lever (Jones & Bergen, tier A). The protocol is the application; the underlying tells are evidence-graded in `01`-`03`.
