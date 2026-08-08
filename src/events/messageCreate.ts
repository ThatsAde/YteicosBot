import { Events } from "discord.js";
import type { Event } from "../types/index.js";

/**
 * Bump di Ticket.lastActivityAt per l'auto-close da inattivita'.
 * Richiede solo l'intent GuildMessages (non privilegiato): non leggiamo mai
 * message.content, solo channelId — coerente con la scelta di non abilitare
 * MessageContent (vedi client.ts e /prova-acquisto).
 */
const messageCreate: Event<Events.MessageCreate> = {
  name: Events.MessageCreate,

  async execute(message) {
    if (message.author.bot) return;
    await message.client.services.ticket.bumpActivity(message.channelId);
  },
};

export default messageCreate;
