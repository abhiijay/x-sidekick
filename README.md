# X reply sidekick - Android app

Phone version of the "X reply sidekick" Chrome extension, plus a Claude webhook
that drafts replies and scouts posts to reply to.

```
Android (installed web app)            your Mac                                   Claude
───────────────────────────            ────────                                   ──────
share a tweet from the X app  ──►  sidekick_server.py :7790 (via ngrok)
tap "Ask Claude to draft"     ──►    ├─ fetches full tweet text from Armory
tap "Run scout"               ──►    ├─ scout Stage 1: watchlist search on Armory
                                     └─ fires the Claude Code routine  ─────────►  reads routine/ROUTINE.md
see drafts, copy + open X     ◄──       queue JSON files  ◄──────── drafts / shortlist ────┘   + knowledge/*
you press Reply yourself            Chrome extension keeps using :7781 (local only)
```

**It never posts.** Claude writes drafts and shortlists. You paste the reply and press Reply.

## What's where

| Path | What it is |
|---|---|
| `server/sidekick_server.py` | The server. Python 3 standard library only, no installs. Replaces `queue-server.py` |
| `server/.env.example` | Settings template. Copy it to `server/.env` (gitignored) |
| `app/` | The Android app (installable web app with a share target) |
| `routine/ROUTINE.md` | What Claude does when the server calls it |
| `knowledge/` | Voice guides, reply playbook, anchor bank and watchlist, copied from the device kit with no credentials |

## Secrets

Secrets never go into git. The repo is public.

- `server/.env` holds the app password, Armory login and Claude routine token. It is gitignored.
- The app stores its password only on your phone.
- Every Claude run gets its own random token. It works for one job, stops working
  after 3 hours or when the job finishes, and only a hash of it is saved.
- Claude never sees the Armory password. It asks the server, which forwards
  read-only Twitter routes only.
- 10 wrong app passwords in 10 minutes locks that client out for a while.

## Setup (on the Mac that runs Armory)

1. **Get the code**: `git clone https://github.com/abhiijay/x-sidekick.git` (or `git pull`).
2. **Settings**: `cp server/.env.example server/.env`, then fill in:
   - `SIDEKICK_APP_PASSWORD`: a long random password (12+ characters).
   - `ARMORY_URL`, `ARMORY_USER`, `ARMORY_PASS`: the same values as in `guides/armory-api-handoff.md`.
     If Armory runs on this Mac, `ARMORY_URL` can be its local address.
   - `SIDEKICK_DATA_DIR`: point it at your existing `tools/x-reply-extension/data`
     folder to keep your current queue and the posted replies that Claude learns your voice from.
3. **Stop the old `queue-server.py`** (it uses the same port, 7781), then start the new server:
   `server/start.sh`
4. **Make port 7790 reachable from your phone** through ngrok. Pick one:
   - **A. A second ngrok endpoint for port 7790** (`ngrok http 7790`), if your ngrok plan allows
     more than one. I haven't confirmed the free-plan endpoint limit.
   - **B. One URL for both.** Point your existing ngrok tunnel at 7790 instead of Armory and set
     `ARMORY_PASSTHROUGH` to Armory's local address (for example `http://127.0.0.1:<armory port>`).
     Every path the sidekick doesn't use is forwarded to Armory unchanged, so the old Armory
     URL, Basic auth and routes keep working.
   - Put the resulting https URL in `SIDEKICK_PUBLIC_URL`, then restart the server.
5. **Create the Claude routine** at https://claude.ai/code/routines:
   - Repository: `abhiijay/x-sidekick` (main branch).
   - Prompt: `You were started by the sidekick server. Read routine/ROUTINE.md and
     follow it for the job described in this message. Never post to X.`
   - Add trigger, choose **API**, then **Generate token**. Copy the URL into `ROUTINE_FIRE_URL` and the
     token into `ROUTINE_TOKEN` (the token is shown only once). Restart the server.
   - In the routine's cloud environment, go to **Network access** and allow your ngrok host,
     otherwise Claude can't send the drafts back.
6. **Phone**: open `https://<your ngrok url>/app/` in Chrome on Android, open the menu, choose
   **Install app** (or **Add to Home screen**), then enter the password in Settings.
   After that, sharing a post from the X app lists **Sidekick** in the share sheet.

## Using it

- **Queue a post**: in the X app, tap Share on a post and pick Sidekick. The server fetches the
  full text from Armory (about 15 credits). "Add + draft now" also starts Claude.
- **Queue a profile for outreach**: share a profile the same way. It goes to the outreach list.
- **Drafts**: "copy + open" copies the draft and opens the post in X. Paste it and press Reply.
  Then put what you actually sent in "final reply you posted" and tap **mark posted**. That
  text is what Claude learns your voice from.
- **Scout**: "Run scout" searches every active watchlist account for posts from the last 24h,
  then Claude scores them. Tick the ones you want and tap "Queue ticked + draft".
  The watchlist has about 505 accounts, so each run is about 51 Armory searches. At the
  guide's ~300 credits per search that's roughly 15K credits per run. This is an estimate, not measured.

## Limits

- Claude Code routines accept at most **30 runs per hour per routine** and 100 per account
  ([docs](https://platform.claude.com/docs/en/api/claude-code/routines-fire)). Each run uses your
  Claude subscription. One "draft" tap handles everything queued, so batch your queue.
- A run takes minutes, not seconds: it starts a full Claude session.
- The Mac, Armory and ngrok must be running. If the Mac is asleep, the app can't reach the server.
- Chrome-based Stage 2 scouting (scrolling your Build in Public list) doesn't run on a phone.
- The X "reply link" button uses X's intent URL. There is a reported X bug where it opens a
  login page inside the Android X app, so "copy + open" is the main button.
- Not yet tested on a real phone through ngrok: whether ngrok's free-plan browser warning page
  gets in the way of installing the app. The app sends the skip-warning header on every API call,
  but the first page load can't. If installing fails, tell Claude.
