# ASSEMBLY: How to Make AI Text Sound Human

This is the capstone. It turns the research (`01`-`06`) into a build spec: the guidelines, the data you need to collect, and the prompts you can hand to a model. Read the findings files for evidence; this file is the "what to actually build" layer. Confidence scores are per statement.

---

## Part 0: The three facts that reframe the whole problem

1. The problem is not that we lack data on how humans write. We have huge corpora. The problem is that RLHF (human-preference tuning) actively pushes every model into ONE flat, agreeable, noun-heavy register, and that register is the "AI voice". Removing it is the job. Confidence: 85% (RLHF-as-cause is the field's leading hypothesis, explicitly unproven by its own authors, so treat the mechanism as directional even though the flat-register OUTCOME is well measured at 95%).

2. There is no single "AI voice" to delete cleanly. It is a bundle of ~15 measurable tendencies (see `02`). You reduce each; you never flip a switch. Confidence: 90%.

3. Your target reader sets the difficulty. Lay readers already can't tell (~50%, coin flip). Frequent-LLM-user experts catch AI at ~93%. Build for the expert, because the lay reader is already fooled and the expert is the real test. Confidence: 92%.

---

## Part 1: The guideline system (what "human" means, operationally)

Humanize along four axes. This is the checklist the app enforces.

### Axis A: Word choice (highest-priority, #1 expert cue)
- Remove/replace the corpus-confirmed focal words: delve, underscore, intricate, showcasing, boasts, crucial, pivotal, comprehensive, utilize, align, meticulous, commendable, notable, tapestry, camaraderie, palpable, vibrant, significantly, realm, groundbreaking. Confidence: 95%.
- Only trust the measured lists (`02`). Do NOT hard-code viral banned-word lists; many entries are unverified. Confidence: 90%.
- Add register-appropriate real vocabulary: slang, contractions, dated references where the register licenses them. Confidence: 70%.

### Axis B: Sentence rhythm
- Force sentence-length variance. Target a mix: some 3-6 word sentences, some 30+. It is the variance that reads human, not a short average. Confidence: 85%.
- Cut nominalizations (verb-to-noun: "the utilization of" to "using") and present participial clauses ("..., highlighting X"). These run 1.5-5x human rate. Confidence: 90%.
- Allow fragments and And/But/So openers where register fits. Confidence: 70%.

### Axis C: Stance and content
- Add hedging (may, probably, I think) at roughly a 3-4:1 hedge-to-booster feel in reflective prose. Confidence: 80%.
- Take an actual position. Let mild irritation, preference, or doubt show. Confidence: 70%.
- Inject ONE concrete anecdote and named specifics (a real tool, price, date, place). Best-supported as a human-perception move. Confidence: 75%.
- Add first-person presence and direct reader address where register fits. Confidence: 80%.

### Axis D: Voice (the biggest lever for human judges)
- Apply ONE coherent persona with a stable idiolect, not a scatter of random quirks. The Turing-test win came from a consistent PERSON, not a quirk checklist. Confidence: 85%.
- Build the idiolect from real writing samples: copy the function-word profile (the/of/and/I frequencies), favorite openers, punctuation habits, typical sentence length. Confidence: 90% that function-word profile is the fingerprint; 80% that few-shot samples transfer it.
- Keep imperfection consistent, not sprinkled. If the persona makes a certain kind of typo, it makes that kind throughout. Do NOT add typos to formal/edited registers. Confidence: 85%.

---

## Part 2: What data you need to collect (for the app)

To humanize into a SPECIFIC person's voice (the durable version of the product):

1. A corpus of that person's real writing. Even ~16 samples enable authorship style transfer; more helps, and retrieval beats light fine-tuning. Collect emails, messages, docs, posts. Confidence: 80%.
2. Their function-word profile computed from that corpus (relative frequencies of the top ~100-300 function words). This is the stylometric fingerprint. Confidence: 95%.
3. Their idiolect tics: favorite transitions, sentence openers, punctuation habits, contraction rate, average and variance of sentence length, hedge rate, emoji/filler dose. Confidence: 85%.
4. Their register map: how they write in different contexts (formal email vs quick Slack), because humans shift and the model must too. Confidence: 90%.

To humanize generically (no target person):

1. A stripping dictionary: the measured focal-word and adjective lists (`02`) plus replacements.
2. A rhythm target: a human sentence-length distribution to match (from any clean human corpus in the target genre).
3. A persona template library: a few coherent default personas (not quirk-bags).

Store all of it as reusable files so you can reference it again, exactly like this research folder does.

---

## Part 3: The prompts

These are drop-in. They implement the pipeline in `06`. Naive "write like a human" is proven weak on its own (SICO baselines), so these are structured and example-driven. Confidence in prompt EFFECTIVENESS: 75% (structured/few-shot prompting works better than naive; exact strength is model- and detector-dependent).

### Prompt 1: Strip and diagnose (stage 1-2)
```
You are editing AI-generated text to remove machine-writing signals. Do NOT
change the meaning or invent facts.

Rewrite the text below. Apply every rule:
1. Delete or replace these words wherever they appear: delve, underscore,
   intricate, showcasing, boasts, crucial, pivotal, comprehensive, utilize,
   align, meticulous, commendable, notable, tapestry, camaraderie, palpable,
   vibrant, significantly, realm, groundbreaking. Use plain alternatives.
2. Break nominalizations into verbs ("the utilization of X" -> "using X").
3. Remove present-participial tag clauses ("..., highlighting the importance
   of Y"). Make them separate plain sentences or cut them.
4. Kill rule-of-three padding and "it's not X, it's Y" constructions.
5. Remove signposting ("In this article", "In conclusion", section recaps).
6. Force sentence-length variance: deliberately mix very short sentences with
   long ones. No two adjacent sentences should be the same length.

Return only the rewritten text.
```

### Prompt 2: Inject human signals (stage 3)
```
Revise this text so a real person clearly wrote it. Keep all facts accurate.
Do not invent specific claims, statistics, or events that were not in the
source. Where a concrete detail would help and you genuinely have it from the
source, use it; otherwise leave a [SPECIFIC: ...] placeholder for the human.

Do this:
- Add hedging where the author would actually be uncertain (maybe, I think,
  probably, it seems). Roughly 3 hedges for every strong claim.
- Take one clear position instead of listing both sides evenly.
- Add first-person presence and one short aside if the register allows it.
- Add one concrete anecdote or named specific IF supported by the source;
  otherwise mark a placeholder.
- Vary emotional temperature: let one part run warmer or sharper.

Return the revised text, with any [SPECIFIC: ...] placeholders left for review.
```

### Prompt 3: Apply the voice (stage 4, with samples)
```
Here are 5-15 writing samples from one person:
<<<SAMPLES>>>

Study their voice: sentence length and variance, favorite sentence openers,
contraction rate, hedging habits, punctuation habits, how formal or casual they
are, and their common transition words. Do NOT copy the samples' content.

Now rewrite the following text in exactly this person's voice, keeping all
facts intact:
<<<TEXT>>>

Match their rhythm and word habits, not just their topics. If they make a
consistent kind of informal move (fragments, lowercase, a stock phrase), use it
consistently, not randomly.
```

### Prompt 4: Test (stage 5)
```
You are a frequent LLM user who is very good at spotting AI writing. Read the
text below. List every remaining machine-writing signal you can find:
AI-vocabulary words, formulaic structure, uniform sentence lengths, missing
stance, over-clean prose, or vagueness. For each, quote the phrase and say what
a human would do instead. Then give a 0-100 "reads as human" score.

Separately: list any factual claim that looks invented or unsupported.
```

Loop: feed Prompt 4's findings back into Prompts 1-3 until the score clears your target and the fact check is clean. Minimize passes (trade-off law).

---

## Part 4: Hard constraints (build these into the product)

1. Never trade truth for human-ness. Aggressive humanizing introduces hallucinated specifics; low-tier tools inject nonsense. Always run the fact check. Confidence: 85%. This matches the workspace's own "AI writes, humans review" and no-hallucination rules.
2. Minimum passes. One clean rewrite is nearly free on meaning; each extra aggressive pass costs meaning and fluency. Stop as soon as the bar is cleared. Confidence: 82%.
3. Persona over quirks. A coherent person beats a quirk-bag; expert readers catch "performed humanity". Confidence: 85%.
4. Position on voice quality, not pure detector evasion. Detectors adapt every model release (arms race); genuine voice is the durable moat, and evasion-only products erode. Confidence: 88%. Also the ethical line: steer away from academic-integrity misuse.
5. Set the target reader explicitly per job. Lay audience needs stages 1-3; expert/detector needs all 5, looped. Confidence: 90%.

---

## Part 5: The honest limitations (say these out loud in the product)

- Detection is not fundamentally winnable against a strong enough generator (proven bound, Sadasivan et al.), and it is not fundamentally losable against a specifically adversarially trained detector (DAMAGE). You are in an arms race, not solving it once. Confidence: 90%.
- All the measured signals are time-stamped to GPT-3.5 through GPT-4.5 / Llama 3 era. Word lists and syntax stats will drift; the pipeline structure (strip, rhythm, stance, voice, test) is more durable than any specific word list. Confidence: 85%.
- "Reads as human to a person" and "beats a detector" are different targets that need different effort. Most published numbers measure detector evasion, not blind human judgment. Confidence: 90%.
- Lay readers reward the wrong things (polish, first person, typos), so a product tuned to fool lay readers can still fail an expert. Build and test against the expert. Confidence: 90%.

---

## One-line build summary

Collect a person's real writing, extract their stylometric fingerprint, then run any AI draft through a five-stage loop (strip AI vocabulary and syntax, rebuild sentence-length variance, inject stance and concrete specifics, apply the person's coherent voice, then test against an expert-style critic and a fact check), doing the fewest passes that clear your target reader and never trading accuracy for human-ness.
