import { Client, Collection, GatewayIntentBits } from "discord.js";
import type { Command } from "./types/index.js";

// "Guilds": comandi/interazioni. "GuildMessages": non privilegiato, serve solo
// per bumpare Ticket.lastActivityAt su ogni messaggio (src/events/messageCreate.ts) —
// non leggiamo mai .content, quindi MessageContent (privilegiato) resta disabilitato.
// La prova d'acquisto passa da /prova-acquisto (opzione Attachment), non da un
// listener sui messaggi, proprio per evitare quell'intent.
// "GuildMembers" (PRIVILEGIATO: va abilitato anche su Developer Portal ->
// Bot -> Privileged Gateway Intents) serve per guildMemberAdd (auto-role +
// invite log). "GuildInvites" (non privilegiato) serve per inviteCreate/
// inviteDelete, che tengono aggiornata la cache di InviteTracker.
export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites,
  ],
});

client.commands = new Collection<string, Command>();
