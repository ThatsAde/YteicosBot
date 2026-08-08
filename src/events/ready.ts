import { Events, type Client } from "discord.js";
import type { Event } from "../types/index.js";
import { logger } from "../utils/logger.js";
import { config } from "../config/index.js";
import {
  DASHBOARD_PANEL_MARKER,
  TICKET_PANEL_MARKER,
  buildDashboardPanel,
  buildTicketOpenPanel,
  ensurePanelMessage,
} from "../interactions/panels.js";

const ready: Event<Events.ClientReady> = {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    logger.info(`Bot online come ${client.user.tag}. Comandi caricati: ${client.commands.size}.`);
    await publishPanels(client);
    await primeInviteTracker(client);
  },
};

/**
 * I pannelli vengono (ri)pubblicati a ogni avvio: cosi' modificarne testo o
 * bottoni nel codice basta a vederli aggiornati sul server, senza comandi
 * manuali. ensurePanelMessage riconosce il pannello gia' presente dal marker
 * nel footer e lo modifica invece di duplicarlo.
 *
 * Un fallimento qui non deve impedire al bot di funzionare (canale non ancora
 * creato, permessi mancanti): si logga e si prosegue.
 */
async function publishPanels(client: Client<true>): Promise<void> {
  const scoped = logger.scope("panels");

  const targets = [
    { name: "pannello ticket", channelId: config.channels.ticketPanel, payload: buildTicketOpenPanel(), marker: TICKET_PANEL_MARKER },
    {
      name: "dashboard staff",
      channelId: config.channels.staffDashboard,
      payload: buildDashboardPanel(),
      marker: DASHBOARD_PANEL_MARKER,
    },
  ] as const;

  for (const target of targets) {
    try {
      const outcome = await ensurePanelMessage(client, target.channelId, target.payload, target.marker);
      scoped.info(`${target.name}: ${outcome === "created" ? "pubblicato" : "aggiornato"} in ${target.channelId}.`);
    } catch (error) {
      scoped.error(`Impossibile pubblicare "${target.name}" in ${target.channelId}`, error);
    }
  }
}

/**
 * Snapshot iniziale degli usi di ogni invito, guild per guild: senza questo
 * il primo join dopo ogni restart non avrebbe nessun "prima" con cui
 * confrontare gli usi, e InviteTracker.resolveUsedInvite non troverebbe mai
 * un invito salito.
 */
async function primeInviteTracker(client: Client<true>): Promise<void> {
  const scoped = logger.scope("invites");

  for (const guild of client.guilds.cache.values()) {
    try {
      await client.services.inviteTracker.primeGuild(guild);
    } catch (error) {
      scoped.error(`Impossibile caricare gli inviti di "${guild.name}"`, error);
    }
  }
}

export default ready;
