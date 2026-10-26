#!/bin/sh
# Keeps the server and its ngrok tunnel up, so the phone does not drop to
# "Server unreachable" while he is away from the Mac.
#
# Every 30s: if the server does not answer on localhost, start it again; if the
# public URL does not answer the way localhost does, restart ngrok on the same
# fixed domain (SIDEKICK_PUBLIC_URL in .env). caffeinate keeps the Mac from
# idle-sleeping while this runs. Closing the lid still sleeps it.
#
# Start from Terminal, not a LaunchAgent (LaunchAgents cannot read ~/Documents):
#   ./start-sidekick.command      or      nohup ./keepalive.sh >/dev/null 2>&1 &
# Log: keepalive.log next to this file.

cd "$(dirname "$0")" || exit 1
LOG=keepalive.log
PORT=$(grep -E '^SIDEKICK_APP_PORT=' .env 2>/dev/null | cut -d= -f2- | tr -d "\"' ")
PORT=${PORT:-7790}
URL=$(grep -E '^SIDEKICK_PUBLIC_URL=' .env 2>/dev/null | cut -d= -f2- | tr -d "\"' " | sed 's:/*$::')
PEER=$(grep -E '^SIDEKICK_PEER_URL=' .env 2>/dev/null | cut -d= -f2- | tr -d "\"' " | sed 's:/*$::')
# When the public URL is the phone's (the peer), the phone owns the tunnel.
# Starting ngrok here would take the domain from it, so only keep the server up.
[ -n "$PEER" ] && [ "$PEER" = "$URL" ] && URL=""
NGROK=$(command -v ngrok || echo /opt/homebrew/bin/ngrok)

say() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

# One copy only.
PIDFILE=keepalive.pid
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "keepalive already running (pid $(cat "$PIDFILE"))"
    exit 0
fi
echo $$ > "$PIDFILE"
trap 'rm -f "$PIDFILE"' EXIT
trap 'exit 0' INT TERM

caffeinate -i -w $$ &
say "keepalive started (port $PORT, url ${URL:-none})"

# Any HTTP answer (401 included) means it is up; 000 means nothing answered.
code() { curl -s -m 8 -o /dev/null -w '%{http_code}' -H 'ngrok-skip-browser-warning: 1' "$1" 2>/dev/null; }

start_ngrok() {
    [ -n "$URL" ] || return
    pkill -x ngrok 2>/dev/null
    sleep 2
    nohup "$NGROK" http --url="$URL" "$PORT" --log=stdout >> ngrok.log 2>&1 &
    say "ngrok started on $URL"
}

down_for=0
while true; do
    local_code=$(code "http://127.0.0.1:$PORT/api/health")
    if [ "$local_code" = "000" ]; then
        down_for=$((down_for + 1))
        # Two misses in a row, so a slow request is not mistaken for a crash.
        if [ "$down_for" -ge 2 ]; then
            say "server not answering, starting it"
            nohup ./start.sh >> sidekick.log 2>&1 &
            down_for=0
            sleep 10
        fi
    else
        down_for=0
        # Through a working tunnel the public URL answers exactly like localhost.
        # Anything else (000, ngrok's 404 "endpoint offline", 502) means the tunnel is gone.
        if [ -n "$URL" ] && [ "$(code "$URL/api/health")" != "$local_code" ]; then
            sleep 5
            c=$(code "$URL/api/health")
            if [ "$c" != "$(code "http://127.0.0.1:$PORT/api/health")" ]; then
                say "tunnel down (public $c, local $local_code)"
                start_ngrok
                sleep 10
            fi
        fi
    fi
    sleep 30
done
