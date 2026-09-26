# Humanizer Research

Research base for the app idea: take any AI-written text and make it read as human.
Built 2026-07-08 from a 5-angle deep research run (25+ primary sources, harsh filtration: peer-reviewed / university / primary-data only for claims; practitioner essays labeled as secondary).

Scope: WRITTEN text only. Spoken TTS voice is out of scope for this folder.

## Files

| File | What it holds |
|---|---|
| `01-research-findings.md` | The full research write-up: all five angles, every claim with evidence and confidence score |
| `02-ai-tells-catalog.md` | The concrete AI tells: word level, sentence level, structure level, content level. The "remove" list |
| `03-human-features-catalog.md` | What makes human writing human. The "inject" list |
| `04-detectors-and-evasion.md` | How detectors work, their failure rates, what actually beats them, the arms race |
| `05-sources.md` | Every source: URL, author, institution, year, type, why it passed the filter. Reference this forever |
| `06-flowchart.md` | The pipeline flowchart (mermaid + plain text version) |
| `07-assembly.md` | THE ASSEMBLY: the complete guideline + prompt system to build the humanizer app on |
| `08-conversion-dictionary.md` | POTENCY EXPANSION (2026-07-17): the big REPLACE table. ~150 word swaps (Kobak 900-word `style` corpus), the measured phrase/n-gram kill-list, transition swaps, the human INJECT inventory, worked sentence conversions. This is what makes it work on a full blog, not just a paragraph |
| `09-long-form-protocol.md` | POTENCY EXPANSION (2026-07-17): how to humanize a whole blog (1k-3k+ words) without the model regressing mid-document. Segment, lock one voice spec, then a document-level rhythm/repetition/temperature pass. Run on top of the five stages for anything over ~400 words |

## The one-paragraph takeaway

AI text is detectable because instruction tuning (RLHF) pushes every model into one flat register: inflated focal words (delve, underscore, intricate), noun-heavy syntax, uniform sentence lengths, rule-of-three padding, no first-person stance, no hedging, no errors, no register shifts. Humans are the opposite: bursty, opinionated, hedging, error-prone, register-shifting, and each one measurably different from the next. Naive "write like a human" prompts barely work; what works is a pipeline: strip the known tells, rebuild sentence rhythm, inject stance and concrete specifics, apply a specific persona/voice built from real writing samples, then verify. Lay readers cannot tell good AI text from human (about 50% = coin flip), but frequent LLM users catch it at about 93%, so the bar to clear is the expert reader, not the average one.
