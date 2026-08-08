# Yteicos Bot

Bot Discord in TypeScript con [discord.js](https://discord.js.org) v14 e persistenza
su SQLite via [Prisma](https://www.prisma.io). Gestisce verifica degli utenti,
ticketing con auto-chiusura per inattività, tracciamento degli inviti e audit log.

## Cosa fa

- **Autorizzazione basata sui ruoli Discord** — stato utente e tier vivono nei ruoli, non in un database (vedi sotto).
- **Ticketing** — pannello con bottoni, un canale per ticket, limiti per tipo, cooldown, avviso e chiusura automatica dopo inattività, archiviazione.
- **Dashboard staff** — pannello di controllo pubblicato all'avvio in un canale visibile solo allo staff, aggiornato invece che duplicato.
- **Invite tracker** — a ogni join il bot registra chi ha invitato il nuovo membro e lo scrive su un canale dedicato.
- **Audit log** — ogni azione rilevante finisce sia sulla tabella `AuditLog` sia su canali Discord separati per categoria (auth, ticket, moderazione, acquisti, sistema).

## Struttura

```
src/
├── commands/<categoria>/<nome>.ts   # un file = un comando slash
├── events/<evento>.ts               # un file = un handler di evento
├── handlers/                        # caricamento dinamico di comandi/eventi
├── interactions/
│   ├── router.ts                    # dispatch di bottoni, select e modal
│   ├── panels.ts                    # costruzione dei pannelli
│   ├── ticket-handlers.ts
│   └── dashboard-handlers.ts
├── services/
│   ├── auth-state.ts                # enum AuthState e Tier + ordinamento
│   ├── auth-service.ts              # stato utente basato sui ruoli Discord
│   ├── ticket-service.ts            # ciclo di vita dei ticket
│   ├── invite-tracker.ts            # cache degli inviti per il logger
│   ├── logger-service.ts            # audit log su DB + canali Discord
│   └── embed-service.ts             # embed con stile coerente
├── domain/
│   ├── ticket-state.ts              # transizioni valide di un ticket
│   └── errors.ts
├── config/index.ts                  # lettura e validazione di .env
├── types/                           # tipi condivisi (Command, Event)
├── utils/logger.ts                  # logger con livelli, colori e scope
├── client.ts                        # istanza discord.js Client
├── deploy-commands.ts               # registrazione slash command su Discord
└── index.ts                         # entry point: compone i service e avvia

prisma/
├── schema.prisma                    # User, Ticket, VerificationRequest, AuditLog, ...
└── migrations/                      # versionate: si applicano con `prisma migrate deploy`

deploy/                              # package e script per il VPS (vedi DEPLOY.md)
```

Le dipendenze non sono singleton importati in giro: `src/index.ts` costruisce i
service e li passa via costruttore, quindi il grafo delle dipendenze si legge in
un punto solo.

## Autorizzazione

Lo stato degli utenti vive nei **ruoli Discord**, non in un database: sopravvive ai
restart ed è ispezionabile dagli admin. Due assi indipendenti:

- `AuthState`: `guest` → `pending` → `verified`, più `suspended` (stato bloccante, nega sempre l'accesso).
- `Tier`: `none` → `customer` → `premium`.

`guest` e `none` corrispondono all'**assenza** dei rispettivi ruoli.

Perché il bot possa assegnare i ruoli servono il permesso **Manage Roles** e il ruolo
del bot **sopra** quelli gestiti nella gerarchia del server. Il ruolo automatico al
join e l'invite tracker richiedono inoltre l'intent privilegiato **Server Members
Intent**, da abilitare su Developer Portal → la tua app → Bot.

Per proteggere un comando basta dichiararlo — il controllo è applicato una volta
sola in `src/events/interactionCreate.ts`:

```ts
const comando: Command = {
  data: /* ... */,
  requiredState: AuthState.Verified,
  requiredTier: Tier.Premium,   // opzionale
  async execute(interaction) { /* ... */ },
};
```

## Setup

1. Crea un'applicazione su [Discord Developer Portal](https://discord.com/developers/applications), aggiungi un Bot e copia **Token** e **Application ID**. Abilita **Server Members Intent**.
2. Invita il bot sul server con lo scope `bot applications.commands` e il permesso **Manage Roles**.
3. Installa le dipendenze:
   ```
   npm install
   ```
4. Copia `.env.example` in `.env` e compilalo. Oltre a `DISCORD_TOKEN` e `CLIENT_ID`, **tutti** gli ID di ruoli, categorie e canali sono obbligatori: `src/config/index.ts` li valida all'avvio e il bot esce con un errore esplicito se ne manca uno. `GUILD_ID` e le impostazioni `TICKET_*` sono invece opzionali.
5. Crea il database locale:
   ```
   npx prisma migrate dev
   ```
6. Registra gli slash command e avvia:
   ```
   npm run deploy-commands
   npm run dev
   ```

## Comandi npm

- `npm run dev` — avvia il bot in sviluppo con reload automatico.
- `npm run build` — compila TypeScript in `dist/`.
- `npm run start` — avvia il bot compilato (dopo `npm run build`).
- `npm run deploy-commands` — registra gli slash command su Discord. Da rilanciare ogni volta che aggiungi o modifichi un comando. Se `GUILD_ID` è impostato registra solo su quel server (istantaneo); altrimenti registra globalmente, con propagazione fino a un'ora.

## Aggiungere un comando

Crea un file in `src/commands/<categoria>/<nome>.ts` che esporta un default con
`data` (`SlashCommandBuilder`) e `execute(interaction)`, seguendo l'esempio in
`src/commands/utility/ping.ts`. Rilancia `npm run deploy-commands` dopo averlo aggiunto.

## Aggiungere un evento

Crea un file in `src/events/<nome>.ts` che esporta un default con `name` (un valore
di `Events`), `execute(...)` ed eventualmente `once: true`, seguendo l'esempio in
`src/events/ready.ts`.

## Deploy

Per far girare il bot su un VPS Linux come servizio `systemd`, con riavvio automatico
e avvio al boot: [`deploy/DEPLOY.md`](deploy/DEPLOY.md).

## Licenza

[MIT](LICENSE).
