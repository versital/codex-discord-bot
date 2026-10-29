#!/usr/bin/env bash
# Installs the Codex Discord bot as a systemd service on Rocky Linux 8/9.
# Usage: sudo ./install.sh
#   SKIP_FFMPEG=1   don't install ffmpeg (videos won't work)
#   REPLACE_APP=1   reinstall the bot code from this folder even if a
#                   (possibly newer, updated) version is already installed
# Re-running it is safe: settings, chats and the installed version are kept.
set -euo pipefail

APP_DIR=/opt/codex-discord-bot   # just the launcher
BOT_USER=codexbot
BOT_HOME=/var/lib/codexbot       # data: settings, chats, bot versions
APP_ROOT=$BOT_HOME/app
ENV_FILE=/etc/codex-discord-bot.env
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo ./install.sh" >&2
  exit 1
fi

# Node.js 20+
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if ! command -v node >/dev/null || (( $(node_major) < 20 )); then
  echo "==> Installing Node.js"
  dnf module reset -y nodejs || true
  dnf module install -y nodejs:22/common || dnf module install -y nodejs:20/common
fi
echo "==> Node $(node --version)"

echo "==> Installing PDF tools"
dnf install -y poppler-utils

# ffmpeg (for video and odd image formats) isn't in Rocky's own repos; it
# comes from EPEL + RPM Fusion. Set SKIP_FFMPEG=1 to leave it out.
if [[ ${SKIP_FFMPEG:-0} != 1 ]] && ! command -v ffmpeg >/dev/null; then
  echo "==> Installing ffmpeg (EPEL + RPM Fusion)"
  . /etc/os-release
  EL=${VERSION_ID%%.*}
  {
    dnf install -y epel-release dnf-plugins-core &&
    if [[ $EL == 8 ]]; then dnf config-manager --set-enabled powertools; else dnf config-manager --set-enabled crb; fi &&
    dnf install -y "https://mirrors.rpmfusion.org/free/el/rpmfusion-free-release-${EL}.noarch.rpm" &&
    dnf install -y ffmpeg
  } || echo "!! ffmpeg install failed; videos won't work (everything else will)" >&2
fi

# espeak-ng turns Codex's *.say.txt files into voice messages (from EPEL).
if ! command -v espeak-ng >/dev/null; then
  echo "==> Installing espeak-ng (voice messages)"
  { dnf install -y epel-release && dnf install -y espeak-ng; } \
    || echo "!! espeak-ng install failed; voice messages won't work (everything else will)" >&2
fi

# The bot runs the Codex bundled in its node_modules; this global copy is
# just for the `codex login` commands below.
echo "==> Installing Codex CLI"
npm install -g @openai/codex
command -v codex >/dev/null || { echo "codex not on PATH after install" >&2; exit 1; }

echo "==> Creating user $BOT_USER"
id "$BOT_USER" &>/dev/null || useradd --system --create-home --home-dir "$BOT_HOME" --shell /sbin/nologin "$BOT_USER"
install -d -o "$BOT_USER" -g "$BOT_USER" -m 700 "$BOT_HOME" "$BOT_HOME/workspace"

systemctl stop codex-discord-bot 2>/dev/null || true

echo "==> Installing the launcher to $APP_DIR"
install -d -m 755 "$APP_DIR"
# Older installs kept the bot itself here.
rm -rf "$APP_DIR/node_modules" "$APP_DIR/bot.js" "$APP_DIR/attachments.js" "$APP_DIR/package.json" "$APP_DIR/package-lock.json"
install -m 644 "$SRC_DIR/launcher.js" "$APP_DIR/"

if [[ ! -s $APP_ROOT/current || ${REPLACE_APP:-0} == 1 ]]; then
  NAME="local-$(date +%Y%m%d%H%M%S)"
  DEST="$APP_ROOT/versions/$NAME"
  echo "==> Installing the bot ($NAME)"
  install -d "$DEST"
  tar -C "$SRC_DIR" --exclude=node_modules --exclude=.git -cf - . | tar -C "$DEST" -xf -
  (cd "$DEST" && npm ci --omit=dev --no-audit --no-fund)
  SHA=$(git -C "$SRC_DIR" rev-parse HEAD 2>/dev/null || true)
  printf '{"name":"%s","source":"local","sha":"%s","installedAt":"%s"}\n' "$NAME" "$SHA" "$(date -u +%FT%TZ)" > "$DEST/version.json"
  [[ -s $APP_ROOT/current ]] && cp "$APP_ROOT/current" "$APP_ROOT/previous"
  echo "$NAME" > "$APP_ROOT/current"
  chown -R "$BOT_USER:$BOT_USER" "$APP_ROOT"
else
  echo "==> Keeping the installed bot version ($(cat "$APP_ROOT/current")). Update it with /admin update in Discord."
fi

if [[ ! -f $ENV_FILE ]]; then
  install -m 600 -o root -g root "$SRC_DIR/.env.example" "$ENV_FILE"
  echo "==> Created $ENV_FILE (fill in DISCORD_TOKEN)"
fi

install -m 644 "$SRC_DIR/codex-discord-bot.service" /etc/systemd/system/codex-discord-bot.service
systemctl daemon-reload

cat <<EOF

Done. If this is a first install:
  1. Log Codex in as the bot user (pick one):
       sudo -u $BOT_USER -H codex login --device-auth      # ChatGPT account, headless
       sudo -u $BOT_USER -H sh -c 'read -rsp "API key: " K; echo; printf %s "\$K" | codex login --with-api-key'
  2. Put your bot token in $ENV_FILE:   sudo nano $ENV_FILE
Then:
  Start:   sudo systemctl enable --now codex-discord-bot
  Logs:    journalctl -u codex-discord-bot -f
  Update:  /admin update in Discord
EOF
