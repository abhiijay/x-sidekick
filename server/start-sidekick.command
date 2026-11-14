#!/bin/sh
# Double-click (or add to Login Items) to bring the sidekick up and keep it up.
# Runs through Terminal, which can read ~/Documents where LaunchAgents cannot.
# Also starts every other sidekick on this computer (one .env.<code> settings
# file each, e.g. .env.a2 for a second LinkedIn account).
cd "$(dirname "$0")" || exit 1
nohup ./keepalive.sh >/dev/null 2>&1 &
for f in .env.*; do
    case "$f" in .env.\*|*.tmp|*.example) continue ;; esac
    nohup ./keepalive.sh "$f" >/dev/null 2>&1 &
    echo "Also keeping up the sidekick in $f"
done
sleep 1
echo "Sidekick keepalive is running. Log: $(pwd)/keepalive.log"
echo "You can close this window."
