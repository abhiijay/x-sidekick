# Sources

Every source used, with filtration rationale. Tiers: PR = peer-reviewed (journal or top-tier conference: ACL, EMNLP, ICML, NeurIPS, TMLR, PNAS, Nature family, Science family). AX = arXiv preprint (widely cited, not yet or not confirmed peer-reviewed). V = vendor primary doc (labeled, used for the vendor's own claims/definitions only, never as independent evidence). UNI = university announcement. JR = primary-data journalism. PRAC = named-expert practitioner essay (secondary tier, framing only). COMM = community reference guide.

Filtration rule applied: claims rest on PR/UNI/JR/V-primary only. AX used where widely cited and corroborated. PRAC/COMM used only for qualitative framing, never as the sole basis of a claim. All SEO listicles and humanizer-vendor marketing were rejected (list at bottom).

---

## Linguistic features (AI vs human)

| # | URL | Author / Institution | Year | Tier | Why it passed |
|---|---|---|---|---|---|
| 1 | https://arxiv.org/abs/2406.07016 / doi.org/10.1126/sciadv.adt3813 | Kobak, Gonzalez-Marquez, Horvat, Lause / Tubingen, Northwestern | 2024-25 | PR (Science Advances) | 15M-abstract corpus, real frequency data |
| 2 | https://aclanthology.org/2025.coling-main.426/ , https://arxiv.org/abs/2412.11385 | Juzek & Ward / Florida State | 2024-25 | PR (COLING 2025) | Per-word opm table, causal experiment |
| 3 | https://arxiv.org/abs/2403.07183 , https://proceedings.mlr.press/v235/liang24b.html | Liang et al. / Stanford | 2024 | PR (ICML) | LLM-modification estimate from real conference reviews |
| 4 | https://arxiv.org/abs/2308.09067 (AI Review 57:265) | Munoz-Ortiz, Gomez-Rodriguez, Vilares / U. Coruna | 2023-24 | PR | Multi-LLM morphosyntactic corpus analysis; burstiness + emotion |
| 5 | https://www.pnas.org/doi/10.1073/pnas.2422455122 , https://arxiv.org/abs/2410.16107 | Reinhart et al. / Carnegie Mellon | 2025 | PR (PNAS) | HAP-E parallel corpus, Biber features, effect sizes |
| 6 | https://www.cmu.edu/dietrich/news/news-stories/2025/large-language-models-writing-text | Carnegie Mellon Dietrich | 2025 | UNI | Institution's numeric account of #5 |
| 7 | https://www.nature.com/articles/s41598-023-45644-9 , https://arxiv.org/abs/2304.14276 | Herbold et al. / TU Clausthal, U. Passau | 2023 | PR (Scientific Reports) | Large human vs ChatGPT essay comparison, expert raters |
| 8 | https://www.cell.com/cell-reports-physical-science/fulltext/S2666-3864(23)00200-X | Desaire et al. / U. Kansas | 2023 | PR (Cell Reports Phys Sci) | Feature-based classifier with named features (paragraph length, connectives) |
| 9 | https://arxiv.org/abs/2508.00086 (IJAL doi:10.1111/ijal.70115) | Kendro, Maloney, Jarvis | 2025 | PR (Int. J. Applied Linguistics) | Six-dimension lexical diversity, 240 humans vs 4 GPT models |
| 10 | https://www.frontiersin.org/journals/education/articles/10.3389/feduc.2025.1616935/full | Frontiers in Education authors | 2025 | PR | TTR/complexity corpus, ChatGPT vs L2 essays |
| 11 | https://arxiv.org/abs/2310.05030 | Counter Turing Test authors | 2023 | AX | Detectability-index limits of perplexity |
| 12 | https://arxiv.org/abs/2603.27006 | "The Last Fingerprint" authors | 2026 | AX | 12-model em-dash/markdown measurement |
| 13 | https://arxiv.org/abs/2603.18161 | "How LLMs Distort Our Written Language" | 2026 | AX | Pronoun/first-person quantification |
| 14 | https://arxiv.org/abs/2508.01930 | "Word Overuse and Alignment in LLMs" | 2025 | AX | RLHF-cause corroboration |
| 15 | https://arxiv.org/abs/2509.10179 | Milicka, Marklova, Cvrcek / Charles University | 2025 | AX | Multi-LLM Biber-dimension register benchmark |

## Detectors and their failure modes

| # | URL | Author / Institution | Year | Tier | Why it passed |
|---|---|---|---|---|---|
| 16 | https://arxiv.org/abs/2304.02819 (Patterns 4, 100779) | Liang, Yuksekgonul, Mao, Wu, Zou / Stanford | 2023 | PR (Cell Press Patterns) | Primary ESL-bias study |
| 17 | https://arxiv.org/abs/2301.11305 | Mitchell et al. / Stanford | 2023 | PR (ICML) | Primary DetectGPT paper |
| 18 | https://arxiv.org/abs/2303.11156 | Sadasivan et al. / U. Maryland | 2023 | PR (TMLR) | Impossibility bound + paraphrase attack |
| 19 | https://arxiv.org/abs/2303.13408 | Krishna et al. / UMass Amherst, Google | 2023 | PR (NeurIPS) | DIPPER + retrieval defense, exact numbers |
| 20 | https://arxiv.org/abs/2301.10226 | Kirchenbauer et al. / U. Maryland | 2023 | PR (ICML) | Canonical green-list watermark |
| 21 | https://www.nature.com/articles/s41586-024-08025-4 | Dathathri et al. / Google DeepMind | 2024 | PR (Nature) | SynthID-Text, production watermark, Limitations section |
| 22 | https://arxiv.org/abs/2405.07940 , https://aclanthology.org/2024.acl-long.674/ | Dugan et al. / UPenn, CMU | 2024 | PR (ACL) | RAID, largest shared detector benchmark |
| 23 | https://openai.com/index/new-ai-classifier-for-indicating-ai-written-text/ | OpenAI | 2023 | V (primary) | The 26%/9% numbers and withdrawal notice, first-party |
| 24 | https://gptzero.me/news/how-ai-detectors-work/ , /news/perplexity-and-burstiness-what-is-it/ | GPTZero / Edward Tian | 2023-26 | V | Canonical metric definitions + vendor's own accuracy claims |
| 25 | https://www.vanderbilt.edu/brightspace/2023/08/16/guidance-on-ai-detection-and-why-were-disabling-turnitins-ai-detector/ | Vanderbilt University | 2023 | UNI | Primary record of the disable decision + math |
| 26 | https://www.washingtonpost.com/technology/2023/04/01/chatgpt-cheating-detection-turnitin/ , .../2023/06/02/... | Geoffrey Fowler / Washington Post | 2023 | JR | Hands-on Turnitin test with real student essays |
| 27 | https://www.turnitin.com/blog/ai-writing-detection-update-from-turnitins-chief-product-officer | Chechitelli / Turnitin | 2023 | V | Turnitin's own FPR claim |
| 28 | https://link.springer.com/article/10.1007/s40979-023-00146-z | Weber-Wulff et al. / multi-university EU | 2023 | PR (Int. J. Educational Integrity) | 14-tool accuracy test |

## Can humans detect AI text

| # | URL | Author / Institution | Year | Tier | Why it passed |
|---|---|---|---|---|---|
| 29 | https://aclanthology.org/2021.acl-long.565/ | Clark et al. / UW, AI2 | 2021 | PR (ACL, Outstanding Paper) | Canonical lay-detection study (~50%) |
| 30 | https://arxiv.org/abs/2405.08007 , https://dl.acm.org/doi/10.1145/3715275.3732108 | Jones & Bergen / UC San Diego | 2024-25 | PR (ACM FAccT) | Pre-registered controlled Turing test |
| 31 | https://arxiv.org/abs/2503.23674 | Jones & Bergen / UC San Diego | 2025 | AX (pre-registered) | Three-party Turing test, persona result (73%) |
| 32 | https://aclanthology.org/2020.acl-main.164/ | Ippolito et al. / UPenn, Google | 2020 | PR (ACL) | Human vs automatic cue asymmetry |
| 33 | https://www.sciencedirect.com/science/article/pii/S2772766123000289 | Casal & Kessler / Iowa State, Penn State | 2023 | PR (Elsevier) | Expert reviewers 38.9% on AI abstracts |
| 34 | https://www.sciencedirect.com/science/article/pii/S2666920X24000109 | Fleckenstein et al. / IPN Kiel | 2024 | PR (Elsevier, gold OA) | Teachers fail to spot AI essays, overconfident |
| 35 | https://www.pnas.org/doi/10.1073/pnas.2208839120 , https://arxiv.org/abs/2206.07271 | Jakesch, Hancock, Naaman / Cornell, Stanford | 2023 | PR (PNAS) | Flawed-heuristics result, N=4,600 |
| 36 | https://aclanthology.org/2025.acl-long.267/ , https://arxiv.org/abs/2501.15654 | Russell, Karpinska, Iyyer / UMass Amherst | 2025 | PR (ACL) | Expert detectors at 92.7% TPR, the key counter-result |
| 37 | https://www.nature.com/articles/s41598-024-76900-1 | Porter & Machery / U. Pittsburgh | 2024 | PR (Scientific Reports) | AI poetry indistinguishability + inverted-preference mechanism |

## Human writing features (stylometry, psycholinguistics)

| # | URL | Author / Institution | Year | Tier | Why it passed |
|---|---|---|---|---|---|
| 38 | https://www.columbia.edu/~rmk7/HC/HC_Readings/Clark_Fox.pdf | Clark (Stanford), Fox Tree (UCSC) | 2002 | PR (Cognition) | Canonical filler psycholinguistics, idiolect spread |
| 39 | https://www.degruyterbrill.com/document/doi/10.1515/cllt-2022-0040/html | Jack Grieve / U. Birmingham | 2023 | PR (CLLT) | Why stylometry works: register theory of idiolect |
| 40 | https://www.refsmmat.com/notebooks/llm-style.html | Alex Reinhart / CMU | 2026 | PRAC (expert bibliography) | Curated quoted synthesis by the PNAS lead author; used to reach paywalled Jiang & Hyland, Mizumoto, Goulart |
| 41 | Mizumoto, Yasuda & Tamura, Applied Corpus Linguistics 4(3), doi:10.1016/j.acorp.2024.100106 | Mizumoto et al. | 2024 | PR | Modals/epistemic/discourse markers higher in human essays |
| 42 | Jiang & Hyland, English for Specific Purposes 79; Written Communication; Applied Linguistics 46(3) | Jiang & Hyland | 2025 | PR | Interactional metadiscourse gap; Hyland founded hedging research |
| 43 | Hyland 1998a (Text 18(3):349-382) via https://oiccpress.com/jelpp/article/download/8576/9600/21597 | Hyland; carried by Mallaki et al. | 1998 / 2023 | PR | Hedge:booster ratios in research articles |
| 44 | https://scispace.com/papers/...-4r7jsa6huf | Damerau / IBM | 1964 | PR (classic, 1,751 cites) | Origin of the 80% single-error typo finding |
| 45 | https://pmc.ncbi.nlm.nih.gov/articles/PMC2137159/ | NCBI / PubMed | 2007 | PR | Replication of edit-distance-1 dominance |
| 46 | https://arxiv.org/abs/2301.07597 | Guo et al. (HC3) | 2023 | AX | 40k-pair human/ChatGPT corpus; colloquial/emotional finding |
| 47 | https://www.sciencedirect.com/science/article/pii/S294988212500091X , https://arxiv.org/abs/2508.01491 | Homogenizing-effect authors | 2025 | PR | Preregistered idea-diversity comparison, 2,200 essays |
| 48 | Goulart et al., Journal of Second Language Writing 66:101160 | Goulart et al. | 2024 | PR | AI more informational, students more involved |

## Humanization / evasion techniques

| # | URL | Author / Institution | Year | Tier | Why it passed |
|---|---|---|---|---|---|
| 49 | https://arxiv.org/abs/2305.10847 | Lu, Liu, He, Ong, Wang, Tang / SUSTech, HKUST, A*STAR | 2023 | PR (TMLR 2024) | SICO; optimized vs naive prompt gap |
| 50 | https://arxiv.org/abs/2404.01907 | Zhou, He, Sun / UCAS | 2024 | AX | HMGC word-level adversarial, timing result |
| 51 | https://arxiv.org/abs/2501.03437 | Emi, Spero et al. / Pangram Labs | 2025 | AX (independent audit) | 19-humanizer audit with before/after detector numbers |
| 52 | https://arxiv.org/abs/2505.01800 | Opara / Teesside University | 2025 | PR (framework) | 31 stylometric features mapped to cognition |
| 53 | https://arxiv.org/abs/2304.11406 | Salemi, Mysore, Bendersky, Zamani / UMass, Google | 2024 | PR (ACL) | LaMP: RAG vs PEFT personalization gains |
| 54 | https://arxiv.org/abs/2406.15586 | Horvitz et al. / Columbia, UPenn | 2024 | PR | TinyStyler few-shot authorship transfer |
| 55 | https://arxiv.org/abs/2212.08986 | Patel et al. | 2022 | PR | Low-resource style transfer from ~16 samples |
| 56 | https://arxiv.org/abs/2506.09975 | Dawkins, Fraser, Kiritchenko / NRC Canada | 2025 | AX | Genre fine-tuning collapses the human-AI gap |

## Practitioner / community (framing only, never sole basis)

| # | URL | Author | Year | Tier | Use |
|---|---|---|---|---|---|
| 57 | https://www.deadlanguagesociety.com/p/rhetorical-analysis-ai | Colin Gorrie (linguist) | 2024 | PRAC | Antithesis / tricolon rhetorical analysis |
| 58 | https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing | Wikipedia editors | 2024-25 | COMM | Cross-checked editor tells, qualitative only |

## Added in the 2026-07-17 expansion (dictionary + phrase + long-form build)

| # | URL | Author / Institution | Year | Tier | Why it passed / how used |
|---|---|---|---|---|---|
| 59 | https://github.com/berenslab/llm-excess-vocab (results/excess_words.csv) | Kobak et al. / Tubingen (data repo for source #1) | 2025 | PR-data | The full 900-word excess-vocabulary list. The `style`-tagged rows are the master word set for `08`. Primary data behind the Science Advances paper (#1) |
| 60 | https://arxiv.org/abs/2509.22996 | AI-Brown / AI-Koditex corpus authors | 2025 | AX (corpus) | Measured n-gram frequencies: "a testament to the" ~163 opm AI vs ~0 human; "testament to" ~222 vs ~7. Basis of the phrase-tier in `02` and `08` Part 2 |
| 61 | https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing (via NPR 2025-09-04, TechCrunch 2025-11-20, Beutler Ink summary) | WikiProject AI Cleanup | 2024-25 | COMM | Negative parallelism, rule of three, false ranges, formatting overkill, compulsive summaries, Tier B word/phrase list in `08`. Community-cataloged, used as tier B only |
| 62 | https://arxiv.org/abs/2412.11385 (COLING 2025) + human-LLM coevolution work | Juzek & Ward / Florida State | 2024-25 | PR | The fading-signal caveat: classic words (delve, intricate, underscore) declining from ~April 2024. Used to time-stamp the dictionary |

Note on tiers for the expansion: the DETECTION claims trace to PR/AX-corpus/COMM sources above. The REPLACEMENT suggestions in `08` are editorial (practitioner, tier C) and are labeled as such in that file. The flag is evidence-graded; the fix is a suggestion.

## Rejected during research (did NOT pass the filter)

SEO / affiliate listicles and humanizer-vendor marketing, all excluded from evidence: hastewire.com, eduwriter.ai, essaydone.ai, humanizerai.com, tryleap.ai, gradpilot.com, undetectedgpt.ai, humanizemy.ai, aifreetextpro.com, StealthGPT.ai, Undetectable.ai, Ryne.ai, Phrasly, GPTinf, Humaniser.com, WriteHuman, HIX Bypass, SchoolAI, Brisk Teaching, FindSkill, and similar. Reason: self-published by tools selling the bypass or detection, unfalsifiable "100% undetectable" / "99% accurate" claims, no method disclosure, no independent data. The one independent read on commercial humanizers is #51 (DAMAGE), which contradicts the marketing.
