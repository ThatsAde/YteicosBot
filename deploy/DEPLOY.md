# Deploy di Yteicos Bot su VPS

Guida completa per spostare il bot dal PC a un VPS Linux (Debian 12 / Ubuntu 22.04+)
e farlo girare come servizio `systemd`, con riavvio automatico e avvio al boot.

## Cosa c'e' in questa cartella

| File | A cosa serve |
| --- | --- |
| `make-package.ps1` | Da lanciare **sul PC**: crea `yteicos-bot-deploy.tar.gz` con tutto il necessario, `.env` incluso |
| `scripts/bootstrap-vps.sh` | Da lanciare **sul VPS una sola volta**: Node 22, utente `yteicos`, `/opt/yteicos-bot` |
| `scripts/install.sh` | Primo avvio: dipendenze, Prisma, build, slash command, servizio systemd |
| `scripts/update.sh` | Aggiornamenti successivi: backup, build, restart |
| `scripts/backup-db.sh` | Backup del database SQLite (usabile anche da cron) |
| `yteicos-bot.service` | Unit systemd |

Convenzioni usate ovunque: cartella `/opt/yteicos-bot`, utente di servizio `yteicos`,
servizio `yteicos-bot`. Se le cambi, cambiale in tutti e cinque i file.

Gli script vanno tutti eseguiti come root, ma **non serve loggarsi come root**: se
li lanci da un utente sudoer si rilanciano da soli con `sudo` (ti chiedera' la
password una volta). Si rilanciano anche sotto `bash` se li invochi con `sh`, che
su Debian/Ubuntu e' `dash` e non capisce la sintassi bash che usano. In pratica
qualunque di queste forme funziona:

```bash
sudo bash /opt/yteicos-bot/deploy/scripts/install.sh   # la forma consigliata
bash /opt/yteicos-bot/deploy/scripts/install.sh        # chiede sudo da solo
sh   /opt/yteicos-bot/deploy/scripts/install.sh        # si riesegue sotto bash
```

`./install.sh` invece funziona solo dopo un `chmod +x`: il `.tar.gz` creato da
Windows non porta i permessi di esecuzione. Ci pensa `install.sh` a metterli su
tutti gli script della cartella, quindi vale dalla seconda volta in poi.

---

## 1. Sul PC — crea il package

```powershell
cd "E:\GitHub Clones\Yteicos"
powershell -ExecutionPolicy Bypass -File deploy\make-package.ps1
```

Lo script fa un `tsc --noEmit` prima di impacchettare (se il progetto non compila,
si ferma qui invece che sul VPS), poi produce `yteicos-bot-deploy.tar.gz` nella root.

**Cosa contiene:** `src/`, `prisma/schema.prisma`, `prisma/migrations/`,
`package.json`, `package-lock.json`, `tsconfig.json`, `deploy/`, `README.md`,
`.env.example` e il **`.env` vero con il token**.

**Cosa NON contiene, di proposito:**
- `node_modules/` — 362 MB e, soprattutto, il client Prisma e i binari sono
  compilati per Windows: sul VPS vanno rigenerati con `npm ci` + `prisma generate`.
- `dist/` — ricompilato sul VPS dallo stesso sorgente.
- `prisma/dev.db` — vedi sotto.

### Vuoi portarti dietro i dati gia' presenti in locale?

Il database SQLite contiene utenti, ticket e audit log. Se quelli locali sono solo
prove di sviluppo, lascia stare: sul VPS `prisma migrate deploy` crea un DB vuoto.
Se invece ti servono:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\make-package.ps1 -IncludeDatabase
```

Chiudi il bot locale prima di farlo, altrimenti rischi di copiare un file a meta'
scrittura.

---

## 2. Sul VPS — preparazione (una volta sola)

```bash
ssh <utente>@<IP-VPS>
# copia bootstrap-vps.sh a mano oppure estrai prima il package e usalo da li'
sudo bash bootstrap-vps.sh
```

Installa Node 22 LTS, crea l'utente di sistema `yteicos` (senza shell di login) e
la cartella `/opt/yteicos-bot`.

> Node 20 e' a fine vita: lo script installa la 22 LTS. Il progetto compila e gira
> identico (verificato in locale su Node 20.17 con lo stesso `package-lock.json`).

---

## 3. Carica ed estrai il package

Dal PC:

```powershell
scp yteicos-bot-deploy.tar.gz <utente>@<IP-VPS>:/tmp/
```

Sul VPS:

```bash
tar -xzf /tmp/yteicos-bot-deploy.tar.gz -C /tmp
sudo rsync -a /tmp/yteicos-bot/ /opt/yteicos-bot/
rm -rf /tmp/yteicos-bot /tmp/yteicos-bot-deploy.tar.gz
```

`rsync` invece di `mv` perche' agli aggiornamenti sovrascrive i file nuovi senza
cancellare `prisma/dev.db` e `node_modules/`.

---

## 4. Installa e avvia

```bash
sudo bash /opt/yteicos-bot/deploy/scripts/install.sh
```

In ordine: permessi (`.env` a `chmod 600`), `npm ci`, `prisma generate`,
`prisma migrate deploy`, `npm run build`, `npm run deploy-commands`, installazione
e avvio del servizio systemd.

Verifica:

```bash
systemctl status yteicos-bot
journalctl -u yteicos-bot -f
```

Se il bot parte, in `#staff-dashboard` compare il pannello di controllo e su Discord
il bot risulta online.

---

## 5. Uso quotidiano

```bash
systemctl status yteicos-bot        # stato (in lettura non serve sudo)
sudo systemctl restart yteicos-bot  # riavvio
sudo systemctl stop yteicos-bot     # stop
journalctl -u yteicos-bot -f        # log in tempo reale
journalctl -u yteicos-bot -n 200    # ultime 200 righe
journalctl -u yteicos-bot --since "1 hour ago"
```

Il servizio e' `enable`d: riparte da solo al reboot del VPS e dopo un crash
(`Restart=always`, 5 secondi di attesa).

### Aggiornare il bot dopo una modifica al codice

Sul PC ricrei il package e lo ricarichi (passi 1 e 3), poi sul VPS:

```bash
sudo bash /opt/yteicos-bot/deploy/scripts/update.sh
# se hai aggiunto o modificato slash command:
sudo bash /opt/yteicos-bot/deploy/scripts/update.sh --commands
```

Fa backup del DB, ferma il servizio, reinstalla, rigenera Prisma, applica le
migration, ricompila e riavvia.

### Backup del database

```bash
sudo bash /opt/yteicos-bot/deploy/scripts/backup-db.sh
```

Finisce in `/var/backups/yteicos-bot/`, compresso, con retention 30 giorni. Per
un backup giornaliero automatico, `sudo crontab -e` (il crontab **di root**: da
un crontab utente il rilancio con sudo non avrebbe un terminale su cui chiedere
la password e il backup fallirebbe in silenzio):

```
0 4 * * * bash /opt/yteicos-bot/deploy/scripts/backup-db.sh >/dev/null 2>&1
```

Per scaricarne uno sul PC: `scp <utente>@<IP-VPS>:/var/backups/yteicos-bot/yteicos-*.db.gz .`
(il file e' di root: se non riesci a leggerlo, prima `sudo chown $USER /var/backups/yteicos-bot/yteicos-*.db.gz`)

---

## Sicurezza del `.env`

Il package viaggia con il token del bot in chiaro. Quindi:

- trasferiscilo **solo** via `scp`/`ssh` (cifrati), mai su Git, Discord o email;
- cancella il `.tar.gz` da `/tmp` dopo l'estrazione (lo fa il comando al passo 3);
- `install.sh` mette il `.env` a `chmod 600` di proprieta' di `yteicos`: solo quell'utente e root lo leggono;
- se sospetti che il token sia finito in giro, rigeneralo (Developer Portal → Bot →
  Reset Token), aggiornalo nel `.env` sul VPS e `systemctl restart yteicos-bot`.

Il `.gitignore` del progetto esclude gia' `.env`, `*.db` e `dist/`: il package non
cambia questa situazione.

---

## Note sulla configurazione in produzione

- **`LOG_LEVEL`** — in locale e' `DEBUG`. `make-package.ps1` lo porta a `info` nel
  package (con `-KeepLogLevel` lo lasci com'e'). Per alzarlo temporaneamente sul VPS:
  modifica `/opt/yteicos-bot/.env` e riavvia il servizio.
- **`GUILD_ID`** — e' valorizzato, quindi `deploy-commands` registra gli slash command
  **solo su quel server**, in modo istantaneo. E' il comportamento giusto se il bot
  serve un solo server. Se un giorno lo userai su piu' server, svuota `GUILD_ID` e
  rilancia `npm run deploy-commands`: registrazione globale, fino a 1 ora di propagazione.
- **`DATABASE_URL`** — resta `file:./dev.db`, cioe' `/opt/yteicos-bot/prisma/dev.db`
  (il path SQLite e' relativo alla cartella dello schema, non alla root). E' l'unica
  cartella in cui il servizio ha permesso di scrivere: `ProtectSystem=strict` +
  `ReadWritePaths=/opt/yteicos-bot/prisma` nell'unit systemd.
- **Intent privilegiati** — il bot usa `Server Members Intent` (ruolo automatico al
  join, invite logger). Deve restare abilitato su Developer Portal → Bot →
  Privileged Gateway Intents, indipendentemente da dove gira il bot.
- **Firewall** — il bot apre solo connessioni in uscita verso Discord: non serve
  aprire nessuna porta in entrata oltre a SSH.

---

## Se qualcosa non parte

| Sintomo (in `journalctl -u yteicos-bot`) | Causa e rimedio |
| --- | --- |
| `Environment variable missing: X` | `.env` assente o incompleto in `/opt/yteicos-bot`. La WorkingDirectory del servizio deve essere quella cartella: `dotenv` legge il `.env` da li'. |
| `Cannot find module '@prisma/client'` o errori sui binari Prisma | Manca `prisma generate` sul VPS, oppure hai copiato `node_modules` da Windows. `cd /opt/yteicos-bot && sudo -u yteicos npx prisma generate` e riavvia. |
| `Cannot find module '/opt/yteicos-bot/dist/index.js'` | Build non eseguita: `sudo -u yteicos npm run build`. |
| `SQLITE_READONLY` / `unable to open database file` | Permessi: `chown -R yteicos:yteicos /opt/yteicos-bot/prisma`. Verifica anche `ReadWritePaths` nell'unit se hai cambiato cartella. |
| `Used disallowed intents` | `Server Members Intent` disabilitato sul Developer Portal. |
| `401 Unauthorized` al login | Token errato o rigenerato: aggiorna `DISCORD_TOKEN` nel `.env`. |
| Gli slash command non compaiono | `npm run deploy-commands` non eseguito dopo l'ultima modifica, o `GUILD_ID` diverso dal server in cui stai guardando. |
| Il servizio riparte in loop | `journalctl -u yteicos-bot -n 100` mostra l'errore vero; `systemctl stop yteicos-bot` per fermare il ciclo mentre indaghi. |

---

## Nota sul `package.json`

Tra le dipendenze c'e' `"all": "^0.0.0"`, un pacchetto vuoto finito li' quasi
certamente per un `npm install all` di troppo: non e' importato da nessun file del
progetto. Non rompe niente, ma se vuoi ripulire, prima di creare il package:

```powershell
npm uninstall all
```

e ricontrolla che `npm run build` funzioni ancora.
