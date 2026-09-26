# Detectors, Failure Modes, and What Actually Beats Them

Reference for building the app: what you are up against, and what the evidence says works. Sources in `05-sources.md`.

---

## How the four detector families work

1. Statistical / zero-shot. Score text with a language model's own probabilities. Low perplexity (text is unsurprising to the model) plus low burstiness (little variance) = likely AI. DetectGPT (Stanford, ICML 2023) uses probability curvature: AI text sits where perturbing it drops log-probability more than for human text. Raised AUROC from 0.81 to 0.95 on GPT-NeoX. No training data needed.
2. Trained classifiers. A network fine-tuned on paired human/AI text. OpenAI's (discontinued), Turnitin's, modern GPTZero (vendor says 7 components now), Pangram.
3. Watermarking. The generator biases token sampling to embed a signature. Kirchenbauer green-list (ICML 2023): hash prior tokens, split vocab into green/red, boost green, detect via a z-test. Google DeepMind SynthID-Text (Nature 2024): Tournament sampling, deployed in Gemini, 0.57% latency cost, no measurable quality loss over ~20M live responses.
4. Retrieval. Provider stores everything it generated and matches candidates against it (Krishna et al.).

## Documented failure rates (all primary-source)

| Detector | Number | Source |
|---|---|---|
| OpenAI classifier | 26% TPR, 9% FPR, withdrawn July 2023 for low accuracy | OpenAI (vendor primary) |
| 7 detectors on non-native English | ~61% average false-positive; 97.8% flagged by at least one | Liang et al., Patterns 2023 |
| Turnitin (self-reported) | <1% FPR claimed, but breaks down below 20% AI content; trades ~15% recall to keep FPR low | Turnitin blog + WaPo |
| RAID (12 detectors, adversarial) | "99%+ accuracy" claims collapse under attacks, sampling changes, unseen models | Dugan et al., ACL 2024 |
| DIPPER paraphrase vs DetectGPT | 70.3% to 4.6% TPR at 1% FPR, >94% semantic similarity kept | Krishna et al., NeurIPS 2023 |
| Recursive paraphrase vs watermark | 99.3% to 9.7% detection | Sadasivan et al., TMLR |

Theoretical ceiling (Sadasivan et al.): the best possible detector's AUROC is bounded by the total-variation distance between the human and AI text distributions. As models get closer to human text, the best detector tends toward a coin flip. Detection is not fundamentally winnable against a good enough generator.

Institutional response: Vanderbilt disabled Turnitin's detector (Aug 2023), citing false positives, ESL bias, and zero transparency into how it works.

## What actually beats detectors, evidence-ranked

1. Machine paraphrasing (strongest). DIPPER collapses detectors at >94% meaning retention; recursive kills watermarks. Cost: aggressive settings degrade quality.
2. Optimized prompting (SICO, TMLR 2024). 40 human examples build a reusable prompt that pushed six detectors to near-random with human readability. Naive "write like a human" prompts were WEAK baselines in the same paper.
3. Word-level adversarial substitution (HMGC 2024). Flips trained detectors in ~10 seconds via minimal synonym swaps.
4. Commercial humanizers (audited, DAMAGE / Pangram 2025). 19 tools DID drop GPTZero 99.7% to 60.0% TPR and Binoculars 94.2% to 28.2%, and removed statistical watermarks. BUT: they degrade fluency, low-tier tools inject nonsense, and an adversarially trained detector still caught 93.2% of a humanizer fine-tuned against it. Residual LLM signal survives paraphrase.

## The catch for the app's real goal

The app's goal is "read as human", not just "beat a detector". Those diverge:

- Beating a detector is measurable and beatable (paraphrase, optimize, substitute).
- Reading as human to the EXPERT reader (Russell et al.'s 93% detectors) is harder: humanizer tools did NOT strip all signatures from expert view. Experts key on vocabulary and formulaic structure, which cheap paraphrase leaves intact.
- Lay readers are already fooled at ~50%, so if the target is a general audience, the bar is low; if the target is surviving an expert or an adversarially trained detector, paraphrase alone fails and you need genuine restructuring + real voice.

## The trade-off law (build this into the product)

One clean paraphrase/rewrite pass is nearly free on meaning. Every additional aggressive pass trades meaning, fluency, and factual accuracy for evasion. Low-tier humanizers inject hallucinated specifics and nonsense. Design the pipeline to do the minimum passes that clear the target bar, and always run a meaning-and-fact check after. Never optimize evasion at the cost of truth, especially given the workspace's existing "AI writes, humans review" and no-hallucination rules.

## Ethics / arms-race note

This is an active arms race. General detectors are fragile (RAID), but adversarially trained detectors (DAMAGE) hold against known humanizers at the cost of constant retraining. Watermarking is production-real (SynthID in Gemini) but paraphrase-weak and only covers cooperating providers. A humanizer product should assume detectors will adapt, position on genuine voice quality (the durable moat) rather than pure evasion (the moat that erodes every model release), and stay clear of academic-integrity misuse.
