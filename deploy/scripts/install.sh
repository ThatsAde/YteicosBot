#!/usr/bin/env bash
# Primo avvio del bot sul VPS. Da eseguire DOPO aver estratto il package in
# /opt/yteicos-bot:
#   sudo bash /opt/yteicos-bot/deploy/scripts/install.sh
#
# Le due righe qui sotto rendono l'invocazione a prova di errore: se lo lanci
# con `sh` si riesegue sotto bash (dash non ha ne' pipefail ne' [[ ]]), e se non
# sei root si riesegue con sudo. Vanno prima di `set -o pipefail`, altrimenti
# dash muore prima di arrivarci. Devono restare sintassi POSIX.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
[ "$(id -u)" -eq 0 ] || exec sudo -- bash "$0" "$@"

set -euo pipefail

APP_USER="yteicos"
APP_DIR="/opt/yteicos-bot"
SERVICE="yteicos-bot"

cd "$APP_DIR"

if [[ ! -f .env ]]; then
  echo "ERRORE: $APP_DIR/.env mancante. Il package deve includerlo (make-package.ps1 lo copia)." >&2
  exit 1
fi

echo "==> Permessi"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
# Il tar creato su Windows non porta il bit di esecuzione: senza questo,
# ./update.sh e ./backup-db.sh danno "command not found".
chmod +x "$APP_DIR"/deploy/scripts/*.sh
# Il .env contiene il token del bot: leggibile solo dall'utente di servizio.
chmod 600 "$APP_DIR/.env"

run_as_app() { sudo -u "$APP_USER" env HOME="/home/$APP_USER" "$@"; }

echo "==> npm ci (installa anche le devDependencies: servono tsc e la CLI prisma)"
run_as_app npm ci

echo "==> prisma generate (client compilato per QUESTO sistema: non copiarlo dal PC)"
run_as_app npx prisma generate

echo "==> prisma migrate deploy (applica le migration senza mai resettare i dati)"
run_as_app npx prisma migrate deploy

echo "==> build TypeScript -> dist/"
run_as_app npm run build

echo "==> Registrazione slash command su Discord"
run_as_app npm run deploy-commands

echo "==> Installazione servizio systemd"
install -m 644 "$APP_DIR/deploy/yteicos-bot.service" "/etc/systemd/system/${SERVICE}.service"
systemctl daemon-reload
systemctl enable "$SERVICE"
systemctl restart "$SERVICE"

sleep 3
systemctl --no-pager --full status "$SERVICE" || true

echo
echo "Fatto. Log in tempo reale:  journalctl -u ${SERVICE} -f"
