#!/usr/bin/env bash
# Aggiornamento del bot gia' installato (dopo aver ricaricato i sorgenti sul VPS).
#   sudo bash /opt/yteicos-bot/deploy/scripts/update.sh              # build + restart
#   sudo bash /opt/yteicos-bot/deploy/scripts/update.sh --commands   # anche re-deploy slash command
#
# Rilancio automatico sotto bash (se invocato con `sh`) e sotto sudo (se non sei
# root). Prima di `set -o pipefail` e in sintassi POSIX: vedi install.sh.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
[ "$(id -u)" -eq 0 ] || exec sudo -- bash "$0" "$@"

set -euo pipefail

APP_USER="yteicos"
APP_DIR="/opt/yteicos-bot"
SERVICE="yteicos-bot"
DEPLOY_COMMANDS=false

for arg in "$@"; do
  case "$arg" in
    --commands) DEPLOY_COMMANDS=true ;;
    *) echo "Opzione sconosciuta: $arg" >&2; exit 1 ;;
  esac
done

cd "$APP_DIR"
run_as_app() { sudo -u "$APP_USER" env HOME="/home/$APP_USER" "$@"; }

echo "==> Backup del database prima di toccare qualsiasi cosa"
bash "$APP_DIR/deploy/scripts/backup-db.sh"

echo "==> Stop $SERVICE"
systemctl stop "$SERVICE"

chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 600 "$APP_DIR/.env"

echo "==> npm ci"
run_as_app npm ci

echo "==> prisma generate + migrate deploy"
run_as_app npx prisma generate
run_as_app npx prisma migrate deploy

echo "==> build"
run_as_app npm run build

if [[ "$DEPLOY_COMMANDS" == true ]]; then
  echo "==> Re-deploy slash command"
  run_as_app npm run deploy-commands
fi

echo "==> Start $SERVICE"
systemctl start "$SERVICE"
sleep 3
systemctl --no-pager --full status "$SERVICE" || true
