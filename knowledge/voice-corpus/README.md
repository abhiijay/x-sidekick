# Voice corpus

Real replies, extracted from the X pulls and from every reply-queue archive.
These are examples, not prose rules: when a guide and a real reply disagree, the
real reply wins.

| File | What it is | n |
|---|---|---|
| `abhiijay-real-sends.json` | **Paired.** The post he replied to plus the reply he actually sent. | 160 |
| `avery-reply-register.json` | Avery's replies to other people, newest-value first by likes. Reply text only. | 443 |
| `arthur-reply-register.json` | Arthur's replies to other people, same shape. | 896 |

## Read this before using them

- **Only `abhiijay-real-sends.json` is paired with its parent post.** Avery's and
  Arthur's parent posts are not in the raw corpora, so their files teach *register*
  (shape, length, rhythm, how a reply opens and ends) and cannot teach *move
  selection* - they cannot tell you which reply a given post deserves.
- **Self-threads are excluded.** Replying to your own post is a different act from
  replying to a stranger. Avery drops from 1055 raw replies to 443 for this reason;
  she threads heavily.
- Measured medians are close across all three: Abhiijay 53 chars, Avery 47,
  Arthur 45. If a draft is much longer than that, it is probably explaining itself.
- Avery's and Arthur's files are **register only**. Never take a fact, product,
  number, or life detail out of them. See `VOICE-ROUTING.md`.

## How they are kept current

`abhiijay-real-sends.json` is the seed. The server copies it once into
`{SIDEKICK_DATA_DIR}/voice-sends.json`, then appends every reply he marks posted.
That durable file, not the queue, is what feeds `voice_examples` in a draft job -
the queue gets archived and trimmed, which had already silently dropped 92 of 102
real sends out of the drafting context.

Rejected drafts accumulate alongside it in `{SIDEKICK_DATA_DIR}/rejected-drafts.json`
with the reason given in the app.
