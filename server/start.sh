#!/bin/sh
# Start the sidekick server (replaces tools/x-reply-extension/queue-server.py).
cd "$(dirname "$0")" && exec python3 sidekick_server.py
