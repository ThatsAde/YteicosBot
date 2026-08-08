#!/usr/bin/env bash
# Backup del database SQLite. Usa ".backup" di sqlite3: e' sicuro anche a bot
# acceso (copia consistente), a differenza di un semplice cp.
#
#   sudo bash /opt/yteicos-bot/deploy/scripts/backup-db.sh
#
# Cron giornaliero alle 4:00 (crontab -e COME ROOT: da un crontab utente il sudo
# qui sotto non avrebbe un terminale per chiedere la password):
#   0 4 * * * bash /opt/yteicos-bot/deploy/scripts/backup-db.sh >/dev/null 2>&1
#
# Rilancio automatico sotto bash (se invocato con `sh`) e sotto sudo (se non sei
# root). Prima di `set -o pipefail` e in sintassi POSIX: vedi install.sh.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
[ "$(id -u)" -eq 0 ] || exec sudo -- bash "$0" "$@"

set -euo pipefail

APP_DIR="/opt/yteicos-bot"
DB_FILE="$APP_DIR/prisma/dev.db"
BACKUP_DIR="/var/backups/yteicos-bot"
KEEP_DAYS=30

if [[ ! -f "$DB_FILE" ]]; then
  echo "Nessun database in $DB_FILE: backup saltato."
  exit 0
fi

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$BACKUP_DIR/yteicos-$STAMP.db"

sqlite3 "$DB_FILE" ".backup '$DEST'"
gzip -f "$DEST"

find "$BACKUP_DIR" -name 'yteicos-*.db.gz' -mtime "+$KEEP_DAYS" -delete

echo "Backup creato: ${DEST}.gz"
