#!/bin/sh
# Double-click (or add to Login Items) to bring the sidekick up and keep it up.
# Runs through Terminal, which can read ~/Documents where LaunchAgents cannot.
cd "$(dirname "$0")" || exit 1
nohup ./keepalive.sh >/dev/null 2>&1 &
sleep 1
echo "Sidekick keepalive is running. Log: $(pwd)/keepalive.log"
echo "You can close this window."
