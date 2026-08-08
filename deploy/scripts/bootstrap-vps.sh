#!/usr/bin/env bash
# Preparazione iniziale del VPS. Da eseguire UNA SOLA VOLTA, come root.
#   sudo bash bootstrap-vps.sh
#
# Cosa fa: installa Node 22 LTS, crea l'utente di servizio "yteicos" e la
# cartella /opt/yteicos-bot. Non tocca il bot: quello arriva con il package.
#
# Rilancio automatico sotto bash (se invocato con `sh`) e sotto sudo (se non sei
# root). Prima di `set -o pipefail` e in sintassi POSIX: vedi install.sh.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
[ "$(id -u)" -eq 0 ] || exec sudo -- bash "$0" "$@"

set -euo pipefail

APP_USER="yteicos"
APP_DIR="/opt/yteicos-bot"
NODE_MAJOR="22"

echo "==> Aggiornamento pacchetti di base"
apt-get update -y
apt-get install -y curl ca-certificates gnupg openssl sqlite3 rsync

if ! command -v node >/dev/null 2>&1 || [[ "$(node -v)" != v${NODE_MAJOR}.* ]]; then
  echo "==> Installazione Node ${NODE_MAJOR} LTS (NodeSource)"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
else
  echo "==> Node gia' presente: $(node -v)"
fi

echo "==> Node $(node -v) / npm $(npm -v)"

if ! id -u "$APP_USER" >/dev/null 2>&1; then
  echo "==> Creazione utente di servizio '$APP_USER'"
  useradd --system --create-home --home-dir "/home/$APP_USER" --shell /usr/sbin/nologin "$APP_USER"
else
  echo "==> Utente '$APP_USER' gia' esistente"
fi

echo "==> Creazione $APP_DIR"
mkdir -p "$APP_DIR"
chown "$APP_USER:$APP_USER" "$APP_DIR"

echo
echo "Fatto. Ora carica il package dal PC:"
echo "  scp yteicos-bot-deploy.tar.gz <utente>@<IP-VPS>:/tmp/"
echo "  sudo tar -xzf /tmp/yteicos-bot-deploy.tar.gz -C /tmp"
echo "  sudo rsync -a /tmp/yteicos-bot/ $APP_DIR/"
echo "  sudo bash $APP_DIR/deploy/scripts/install.sh"
