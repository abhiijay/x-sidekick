#!/data/data/com.termux/files/usr/bin/bash
# One-time setup to run the sidekick server on an Android phone in Termux.
#   pkg install -y curl && curl -fsSL https://raw.githubusercontent.com/abhiijay/x-sidekick/main/server/termux-setup.sh -o setup.sh && bash setup.sh
# Safe to re-run: it updates the code and keeps your settings unless you choose otherwise.
# Secrets are typed here on the phone and saved only to server/.env (mode 600, gitignored).
set -e

REPO="$HOME/x-sidekick"
ENV_FILE="$REPO/server/.env"
DATA_DIR="$HOME/sidekick-data"

say() { printf '\n\033[1;36m%s\033[0m\n' "$*"; }
ask() { local v; read -r -p "$1: " v; printf '%s' "$v"; }
ask_secret() { local v; read -r -s -p "$1 (hidden): " v; echo >&2; printf '%s' "$v"; }

say "1/5 Installing packages (python, git, curl, proot)"
pkg install -y python git curl tar proot
pkg install -y resolv-conf 2>/dev/null || true

say "2/5 Getting the code"
if [ -d "$REPO/.git" ]; then
  git -C "$REPO" pull --ff-only
else
  git clone https://github.com/abhiijay/x-sidekick.git "$REPO"
fi
mkdir -p "$DATA_DIR"

say "3/5 Settings"
write_env=1
if [ -f "$ENV_FILE" ]; then
  keep=$(ask "Settings already exist. Keep them? [Y/n]")
  case "$keep" in n|N|no|NO) write_env=1 ;; *) write_env=0 ;; esac
fi
if [ "$write_env" = 1 ]; then
  echo "Have these ready: Armory URL/user/password (guides/armory-api-handoff.md in your kit),"
  echo "and the routine fire URL + token (claude.ai/code/routines -> x-sidekick -> Edit -> API trigger)."
  app_pw=$(ask_secret "App password (Enter = make a new one)")
  if [ -z "$app_pw" ]; then
    app_pw=$(python -c "import secrets; print(secrets.token_urlsafe(18))")
    echo "New app password: $app_pw   <- enter this in the Sidekick app Settings"
  fi
  armory_url=$(ask "Armory URL (https://...)")
  armory_user=$(ask "Armory user")
  armory_pass=$(ask_secret "Armory password")
  fire_url=$(ask "Routine fire URL (https://api.anthropic.com/v1/claude_code/routines/trig_.../fire)")
  fire_token=$(ask_secret "Routine token (sk-ant-oat01-...)")
  ngrok_domain=$(ask "Fixed ngrok domain, e.g. scariness-wistful-exclaim.ngrok-free.dev (Enter = random URL)")
  li_email=$(ask "LinkedIn accept-watch email (Enter = skip)")
  li_pw=""
  [ -n "$li_email" ] && li_pw=$(ask_secret "That email's app password")
  umask 077
  cat > "$ENV_FILE" <<EOF
SIDEKICK_APP_PASSWORD=$app_pw
SIDEKICK_PUBLIC_URL=
SIDEKICK_APP_PORT=7790
SIDEKICK_LEGACY_PORT=0
SIDEKICK_DATA_DIR=$DATA_DIR
ARMORY_URL=$armory_url
ARMORY_USER=$armory_user
ARMORY_PASS=$armory_pass
ROUTINE_FIRE_URL=$fire_url
ROUTINE_TOKEN=$fire_token
SIDEKICK_ALLOWED_ORIGINS=https://abhiijay.github.io
NGROK_DOMAIN=$ngrok_domain
LI_ACCEPT_EMAIL=$li_email
LI_ACCEPT_APP_PASSWORD=$li_pw
LI_ACCEPT_EVERY_MIN=10
LI_ACCEPT_WRITE_EVERY_MIN=120
EOF
  chmod 600 "$ENV_FILE"
  echo "Saved $ENV_FILE (only this phone can read it)."
fi

say "4/5 ngrok"
if ! command -v ngrok >/dev/null 2>&1; then
  case "$(uname -m)" in
    aarch64|arm64) arch=arm64 ;;
    armv7l|armv8l|arm) arch=arm ;;
    *) echo "Unknown CPU $(uname -m); download ngrok for linux yourself."; exit 1 ;;
  esac
  curl -fL "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-$arch.tgz" -o "$TMPDIR/ngrok.tgz"
  tar -xzf "$TMPDIR/ngrok.tgz" -C "$PREFIX/bin"
  chmod +x "$PREFIX/bin/ngrok"
fi
# Android has no /etc/resolv.conf, which ngrok needs for DNS. proot supplies one.
[ -s "$PREFIX/etc/resolv.conf" ] || printf 'nameserver 8.8.8.8\nnameserver 1.1.1.1\n' > "$PREFIX/etc/resolv.conf"
if ! ls "$HOME"/.config/ngrok/ngrok.yml >/dev/null 2>&1; then
  tok=$(ask_secret "ngrok authtoken (dashboard.ngrok.com -> Your Authtoken)")
  ngrok config add-authtoken "$tok"
fi

say "5/5 Creating the 'sidekick' and 'sidekick-stop' commands"
cat > "$PREFIX/bin/sidekick" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
# Start (or restart) the sidekick server + ngrok tunnel in the background.
REPO="$HOME/x-sidekick"; ENV_FILE="$REPO/server/.env"
termux-wake-lock
pkill -f sidekick_server.py 2>/dev/null; pkill -f "ngrok http" 2>/dev/null; sleep 1
domain=$(grep -E '^NGROK_DOMAIN=' "$ENV_FILE" | cut -d= -f2-)
flag=""
if [ -n "$domain" ]; then
  if ngrok http --help 2>/dev/null | grep -q -- '--url'; then flag="--url=https://$domain"; else flag="--domain=$domain"; fi
fi
nohup proot -b "$PREFIX/etc/resolv.conf:/etc/resolv.conf" ngrok http 7790 $flag --log=stdout > "$HOME/sidekick-ngrok.log" 2>&1 &
url=""
for i in $(seq 1 30); do
  url=$(curl -s http://127.0.0.1:4040/api/tunnels | python -c "import sys,json
try:
  t=json.load(sys.stdin)['tunnels']; print(next(x['public_url'] for x in t if x['public_url'].startswith('https')))
except Exception: pass" 2>/dev/null)
  [ -n "$url" ] && break
  sleep 1
done
if [ -z "$url" ]; then
  echo "ngrok did not start. Last log lines:"; tail -n 15 "$HOME/sidekick-ngrok.log"; exit 1
fi
old=$(grep -E '^SIDEKICK_PUBLIC_URL=' "$ENV_FILE" | cut -d= -f2-)
sed -i "s#^SIDEKICK_PUBLIC_URL=.*#SIDEKICK_PUBLIC_URL=$url#" "$ENV_FILE"
cd "$REPO/server" && nohup python sidekick_server.py > "$HOME/sidekick.log" 2>&1 &
sleep 3
pw=$(grep -E '^SIDEKICK_APP_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
health=$(curl -s -H "X-Sidekick-Key: $pw" http://127.0.0.1:7790/api/health)
echo
echo "Server: $health"
echo "Public URL: $url"
if [ -n "$old" ] && [ "$old" != "$url" ]; then
  echo
  echo "!! The URL changed. Update it in: (1) Sidekick app -> Settings -> Server URL,"
  echo "   (2) claude.ai/code/routines -> x-sidekick -> environment -> Allowed domains."
fi
echo "Logs: ~/sidekick.log and ~/sidekick-ngrok.log   Stop: sidekick-stop"
EOF
cat > "$PREFIX/bin/sidekick-stop" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
pkill -f sidekick_server.py; pkill -f "ngrok http"; termux-wake-unlock; echo "Stopped."
EOF
chmod +x "$PREFIX/bin/sidekick" "$PREFIX/bin/sidekick-stop"

say "Done. Before starting:"
echo "- Stop the server and its 7790 tunnel on the Mac first (one server at a time)."
echo "- Android Settings -> Apps -> Termux -> Battery -> Unrestricted, and allow its notifications."
echo "Then type:  sidekick"
