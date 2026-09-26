# Research Findings: Why AI Text Sounds Like AI, and What Makes Writing Human

Date: 2026-07-08. Method: 5 parallel research angles, each with 6-11 web searches and 6+ full source fetches. Harsh filtration: claims rest on peer-reviewed papers, university studies, vendor primary docs (labeled), and primary-data journalism. SEO listicles and humanizer-vendor marketing were found and rejected (list in `05-sources.md`). Every claim carries a confidence score. Models covered are mostly GPT-3.5 through GPT-4.5 / Llama 3 era; signals move as models change.

---

## Angle 1: The measurable features that separate AI text from human text

### The strongest, corpus-proven signal: focal-word inflation

Kobak et al. (Science Advances 2025) analyzed 15M+ PubMed abstracts from 2010-2024 and found an abrupt post-ChatGPT frequency spike in a closed set of "excess" style words. They estimate at least 13.5% of 2024 abstracts were LLM-processed, up to ~40% in some subcorpora. Confidence: 95%.

Juzek & Ward (COLING 2025) quantified the shift per word, occurrences per million in PubMed abstracts, 2020 vs 2024:

| Word | 2020 opm | 2024 opm | Change |
|---|---|---|---|
| delves | 0.21 | 14.38 | +6,697% |
| delving | 0.12 | 2.38 | +1,817% |
| showcasing | 0.59 | 8.79 | +1,396% |
| boasts | 0.11 | 1.15 | +918% |
| underscores | 4.50 | 45.19 | +904% |
| intricate | 6.22 | 44.22 | +611% |
| surpassing, garnered, realm, groundbreaking, aligns | - | - | +250-670% |

Confidence: 95% (read from the paper's table).

Cause: Juzek & Ward tested training data, architecture, and algorithm and found no evidence for any of them; their experiments were consistent with RLHF (human preference tuning) being the driver. This is the leading hypothesis, NOT proven. Confidence: 55%.

Related: Liang et al. (ICML 2024) estimated 6.5-16.9% of ICLR/NeurIPS/EMNLP 2023-24 peer reviews were substantially LLM-modified, detected purely via inflated adjectives: commendable, innovative, meticulous, intricate, notable, versatile. Confidence: 90%.

Reinhart et al. (PNAS 2025, Carnegie Mellon) found specific words inflated 60-150x vs human baselines: "camaraderie", "tapestry" (~150x, ChatGPT), "palpable", "intricate". Confidence: 95%.

### The grammatical signature

Reinhart et al. (PNAS 2025) and the HAP-E parallel corpus (arXiv:2410.16107): instruction-tuned LLMs over-produce present participial clauses (2-5x human rate), nominalizations (1.5-2x), "that"-clauses as subjects, and phrasal coordination. A random forest separated 7 sources at 66% (chance 14%) with only 4.2% of AI texts misread as human. Confidence: 85-95%.

### Burstiness (sentence-length variance)

Munoz-Ortiz et al. (AI Review 2024): human news text shows scattered sentence-length distributions; LLM text is uniform. This is the real phenomenon behind GPTZero's "burstiness". Confidence: 80-90%. WARNING: the numeric thresholds floating around online ("human burstiness 0.65-0.85, AI below 0.30") are vendor folklore with no peer-reviewed basis.

Important nuance: it is VARIANCE, not mean length. "Humans write shorter sentences" is folklore; LLMs imitating literary authors actually write LONGER sentences (Kirilloff et al.).

### Stance, emotion, register

- Humans use more modals, epistemic markers, discourse markers (Herbold et al., Scientific Reports 2023; Mizumoto et al. 2024). Confidence: 90%.
- ChatGPT essays have significantly FEWER hedges, boosters, attitude markers, engagement markers, questions, personal asides (Jiang & Hyland 2025 series). Confidence: 85%.
- Human news text carries more fear/disgust, less joy; AI is emotionally flat and inoffensive (Munoz-Ortiz). Confidence: 70-90%.
- LLM-influenced essays show ~50% fewer first-person pronouns in argumentative genres (arXiv:2603.18161). Genre-dependent: in news, LLMs used MORE pronouns. Confidence: 65%.
- Humans are register-shifters, LLMs are register-flat: LLMs write in one informationally dense, noun-heavy style regardless of genre, even when prompted with fiction (Reinhart/CMU; Milicka et al.; Goulart et al. 2024). Confidence: 90%.

### Structure-level tells

- Rule-of-three / tricolon and "it's not X, it's Y" antithesis: strongly documented qualitatively (linguist Colin Gorrie; Wikipedia editors' "Signs of AI writing" guide), NOT yet quantified in a large-N corpus count. Confidence: 60%.
- Em-dash overuse: a real measured artifact of markdown-heavy training ("The Last Fingerprint", arXiv:2603.27006, 12 models), persistent even under prose instructions, but unreliable alone and fading as vendors patch it. Confidence: 70% real tendency, 85% unreliable alone.
- AI paragraphs are LONGER (Desaire et al., Cell Reports Physical Science 2023: >99% in-domain classification using paragraph length and connective frequency). "Uniform paragraph lengths" as a tell is unverified folklore. Confidence: 80% in-domain, 40% generalizes.

### Contested: lexical diversity

Direction flips by comparison set. Against student/L2 essays, AI shows HIGHER lexical diversity and complexity (Herbold; Frontiers in Education 2025). Against professional news prose, humans show more vocabulary variety (Munoz-Ortiz). Kendro, Maloney & Jarvis (IJAL 2025, 240 human writers vs 4 GPT models): model text differs from human text on all six lexical-diversity dimensions, and human diversity is stable across education level while models diverge; newer models are LESS human-like. The safe claim is "different from humans", never "lower than humans". Confidence: 90% for "different".

---

## Angle 2: How detectors work and how badly they fail

Four detector families:

1. Statistical/zero-shot: perplexity + burstiness (early GPTZero), log-probability curvature (DetectGPT, Stanford ICML 2023: AUROC 0.81 to 0.95 on GPT-NeoX fake news).
2. Trained classifiers: OpenAI's discontinued classifier, Turnitin, modern GPTZero (now a 7-component system per the vendor).
3. Watermarking: Kirchenbauer green-list scheme (ICML 2023); Google DeepMind SynthID-Text (Nature 2024), deployed in Gemini, 0.57% latency overhead, validated on ~20M live responses.
4. Retrieval: provider matches text against a database of everything it generated (Krishna et al.).

Documented failures, all primary-source:

- OpenAI's own classifier: 26% true positive rate, 9% false positives; withdrawn July 2023 "due to its low rate of accuracy". Confidence: 99%.
- Stanford ESL bias (Liang et al., Patterns 2023): 7 detectors misclassified non-native TOEFL essays as AI at an average of ~61%; 97.8% were flagged by at least one detector; US native essays flagged at low single digits. Low perplexity means "simple/predictable", not "machine". Same paper: prompting for "elevated" language flips the verdicts both ways. Confidence: 95%.
- Vanderbilt disabled Turnitin's AI detector (Aug 2023): even a 1% FPR means ~750 falsely accused papers/year at their volume; Turnitin discloses nothing about internals. Confidence: 99%.
- RAID benchmark (Dugan et al., ACL 2024; 6M generations, 12 detectors, 11 adversarial attacks): detectors claiming 99%+ are "easily fooled by adversarial attacks, variations in sampling strategies, repetition penalties, and unseen generative models". Even whitespace insertion and homoglyph swaps degrade them. Confidence: 92-97%.
- Paraphrase attacks: DIPPER dropped DetectGPT from 70.3% to 4.6% TPR at 1% FPR while keeping >94% semantic similarity (Krishna et al., NeurIPS 2023). Recursive paraphrasing drops watermark detection from 99.3% to 9.7% (Sadasivan et al., TMLR). Confidence: 95%.
- Theory: best-possible detector AUROC is bounded by the total variation distance between human and AI distributions; as models improve, best detection tends toward a coin flip (Sadasivan et al.). Confidence: 96%.
- SynthID's own Nature Limitations section concedes paraphrase weakening and no coverage of non-cooperating/open-source models. Confidence: 98%.

Vendor numbers (GPTZero "99% accuracy, 1% FPR") are self-benchmarked and contradicted by RAID's adversarial results. Treat all detector accuracy marketing as vendor claims.

---

## Angle 3: Can humans tell? (This defines the bar the app must clear)

- Lay readers: chance level. Clark et al. (ACL 2021, Outstanding Paper): ~50% on GPT-3 text, training raised it only to ~55%. Confidence: 95%.
- Expert reviewers from top linguistics journals: 38.9% accuracy on AI vs human abstracts, WORSE than coin flip (Casal & Kessler 2023). Confidence: 85%.
- Teachers (n=289 across two studies): could not identify ChatGPT essays, were overconfident, and rated AI essays MORE positively (Fleckenstein et al. 2024). Confidence: 85%.
- Turing tests (UCSD, Jones & Bergen): GPT-4 judged human 54% (2024); persona-prompted GPT-4.5 judged human 73%, MORE often than the actual humans (2025). The persona prompt (introverted 19-year-old, typos allowed, limited knowledge) mattered more than the model: same model without persona dropped to 36%. Confidence: 90-92%.
- The killer exception: Russell et al. (ACL 2025): 5 people who frequently use LLMs for writing hit 92.7% TPR at 4.0% FPR on 300 articles; majority vote misclassified 1 of 300, beating commercial detectors, robust to paraphrasing and humanizer tools. Nonexperts on the same task: chance. Confidence: 93%.
- What the experts key on, ranked: (1) AI vocabulary ("vibrant", "crucial", "delve" class), (2) formulaic sentence/document structure, (3) uniform formality, suspicious clarity, lack of originality. Confidence: 90%.
- Lay heuristics are inverted and exploitable (Jakesch et al., PNAS 2023, N=4,600): people read first-person pronouns, contractions, family topics, and typos as "human", so optimized AI text gets rated MORE human than real human text. Confidence: 95%.
- Confidence does not track accuracy anywhere: teachers overconfident, Turing interrogators showed reversed calibration on the best model.

Design implication: build for the expert reader (the 93% detector), because the lay reader is already fooled.

---

## Angle 4: What makes human writing human (the inject list basis)

- Stylometric fingerprints: individuals are identifiable from relative frequencies of function words alone (Mosteller & Wallace 1963 onward; Grieve 2023). Best current theory: individual style is a personal register, a bundle of situational choices. Confidence: 85-95%.
- Idiolect spread is enormous: in the London-Lund corpus, filler rates ranged 1.2 to 88.5 per 1,000 words across speakers (70x); speakers have characteristic preferences (uh vs um) like vocabulary preferences (Clark & Fox Tree, Cognition 2002). Fillers are planned words signaling delay, not noise. Confidence: 90-95%. (Speech data; the bridge to writing runs through discourse markers and stance, which ARE measured in writing.)
- Human error signature: ~80% of misspellings are single-error events (one insertion/deletion/substitution/transposition; Damerau 1964, replicated); unedited typing runs ~1-3% word error rate; edited prose far lower. ChatGPT essays show "substantially fewer errors" than human essays. Confidence: 85-90%.
- Hedging: in Hyland's research-article corpora, hedges outnumber boosters roughly 3-4 to 1; most frequent items: may, would, possible. Human academic prose is hedged; AI prose is confident and flat. Confidence: 80%.
- Personal involvement: first-person reference, self-disclosure, personal asides, engagement markers are human tells across student writing, social writing, and Q&A corpora (Goulart 2024; Jiang & Hyland 2025; Guo et al. HC3 2023). Confidence: 80%.
- Homogeneity gap: human writers are diverse from each other; LLM "authors" cluster together. Each additional human admissions essay adds more new ideas than each additional GPT-4 essay; co-writing with an LLM increases inter-author similarity (2,200-essay preregistered studies, 2025). Confidence: 75-90%.
- Human fiction occupies wider "narrative space": more moral ambiguity, temporal complexity; AI stories over-explain themes and favor tidy single-track plots (StoryScope, 2026 preprint). Confidence: 70%.
- The gap is instruction-tuning-dependent, not a law of nature: fine-tuning on a genre corpus (tweets) collapses many differences and defeats detection (Dawkins et al. 2025). Confidence: 80%.

---

## Angle 5: What actually humanizes (evidence-ranked)

Ranked by evidence strength:

1. Machine paraphrasing (strongest evidence, detector-focused): DIPPER 11B paraphraser collapses detectors while keeping >94% semantic similarity; recursive paraphrase kills watermarks too. Cost: aggressive settings degrade quality. Confidence: 95%.
2. Optimized prompting beats naive prompting by a wide margin: SICO (TMLR 2024) used 40 human examples to build a prompt that cut six detectors' AUC by ~0.5 (to near-random) while keeping human-level readability. The same paper's baselines show naive "write like a human" and plain "paraphrase this" prompts are WEAK. Confidence: 88% / 75%.
3. Persona prompting for human judges: the single biggest lever in the Turing-test data. Same GPT-4.5: 36% human-rate without persona, 73% with one (typos, limited knowledge, casual register). Confidence: 90%.
4. Few-shot voice exemplars + retrieval beat light fine-tuning: LaMP benchmark: retrieval personalization ~14.9% average gain vs ~1.1% for LoRA-style fine-tuning; few-shot authorship transfer works from as few as ~16 samples (TinyStyler; Patel et al.). Confidence: 80%.
5. Word-level adversarial substitution flips trained detectors in ~10 seconds (HMGC, 2024). Confidence: 80%.
6. Commercial humanizer tools: independently audited (DAMAGE, Pangram Labs 2025, 19 tools): they DO drop detectors (GPTZero 99.7% to 60.0% TPR; Binoculars 94.2% to 28.2%) but degrade fluency, inject nonsense at the low end, and an adversarially trained detector still caught 93.2% of the output of a humanizer fine-tuned against it. Residual signal survives paraphrase. Confidence: 85%.
7. "Add typos" alone: directionally plausible (RAID shows surface edits break detectors; the persona prompt used typos; lay readers read typos as human), but no clean isolated study, and expert readers are NOT fooled by typos. Confidence: 55%.

Trade-off law: one clean paraphrase pass is nearly free; aggressive multi-round humanizing costs meaning, fluency, and factual accuracy. Low-tier tools inject nonsense. Quality degradation is the price of evasion, minimize passes.

---

## Cross-angle contradictions worth remembering

1. "AI has low lexical diversity" is FALSE as stated; direction depends on the human baseline. Safe version: "AI diversity is un-human-like and homogeneous across outputs."
2. "Humans can't detect AI" and "humans detect AI at 93%" are both true, about different humans (lay vs frequent-LLM-users). Build for the expert.
3. "Errors prove human" is the exact inverted heuristic adversaries exploit; polish-blind lay readers get fooled, experts don't care about typos.
4. Attackers currently beat general detectors (RAID, DIPPER, theory), but adversarially trained detectors (DAMAGE) hold against known humanizers. Arms race, not a solved game.
5. Numeric burstiness thresholds and most viral "banned word lists" are folklore; only the corpus-confirmed word sets (Kobak, Juzek & Ward, Liang, Reinhart) are measured.

## Folklore explicitly NOT verified (do not build on these)

- "Human burstiness scores 0.65-0.85, AI below 0.30" (vendor marketing numbers).
- "Uniform paragraph lengths" as a measured tell (no large-N study found; AI paragraphs measured LONGER).
- Tricolon and "not X but Y" per-1000-word frequency counts (real pattern, no corpus count located).
- "Tapestry"/"testament" in the measured focal lists (tapestry IS confirmed by Reinhart at ~150x, "testament" is not in any verified list).
- "Humans use more profanity" (not supported in what was found).
- "Add a few typos and it passes" (directional only, fails against expert readers).
