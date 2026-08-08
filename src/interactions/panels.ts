import { ButtonStyle, ChannelType, type BaseMessageOptions, type Client } from "discord.js";
import { BRAND_NAME, Colors, EmbedService } from "../services/embed-service.js";

/**
 * Pannelli persistenti (pubblici) del bot: definiti una volta sola qui e
 * riusati da chi li pubblica — l'avvio (events/ready.ts), il comando
 * /pannello-ticket e il bottone "pubblica pannello" della dashboard.
 *
 * Ogni pannello porta un marker nel footer: e' cosi' che li ritroviamo al
 * riavvio per AGGIORNARLI invece di postarne una copia nuova ogni volta.
 */

export const TICKET_PANEL_MARKER = `${BRAND_NAME} - ticket panel`;
export const DASHBOARD_PANEL_MARKER = `${BRAND_NAME} - staff dashboard`;

export function buildTicketOpenPanel(): BaseMessageOptions {
  return EmbedService.buttons()
    .color(Colors.GlacialAccent)
    .title("Open a Ticket")
    .description(
      [
        "**Verify purchase** - unlocks private channels and quick FAQs.",
        "**Commission** - request a quote for custom work.",
        "**Support** - having an issue with a product?",
        "**Priority support** - verified customers only.",
        "**Report** - visible to staff only.",
        "",
        "_You will be asked to fill out a short form: the more detail you provide, the faster we can respond._",
      ].join("\n"),
    )
    .footer(TICKET_PANEL_MARKER)
    .button({ label: "Verify Purchase", style: ButtonStyle.Primary, customId: "ticket:open:verification" })
    .button({ label: "Commission", style: ButtonStyle.Secondary, customId: "ticket:open:commission" })
    .button({ label: "Support", style: ButtonStyle.Secondary, customId: "ticket:open:support" })
    .button({ label: "Priority", style: ButtonStyle.Secondary, customId: "ticket:open:priority-support" })
    .button({ label: "Report", style: ButtonStyle.Danger, customId: "ticket:open:report" })
    .build();
}

export function buildDashboardPanel(): BaseMessageOptions {
  return EmbedService.buttons()
    .color(Colors.Amber)
    .title("Control Center")
    .description(
      [
        `Everything ${BRAND_NAME} can do, from here. Every action responds only to you (ephemeral message).`,
        "",
        "**Manage Tickets** - choose an open ticket and act on it: claim, resolve,",
        "reopen, close with a reason, delete, rename, change priority. From a",
        "verification ticket's panel you can also approve it (choosing the tier) or reject it, and from",
        "**Participants** transfer it to another staff member or add/remove users.",
        "Actions that are not possible in the ticket's current state stay disabled.",
        "",
        "**Manage User** - select a member and see their status, tier, and recent tickets: verify,",
        "reject verification, suspend, revoke suspension, change tier.",
        "",
        "**Ticket List** - overview of all open tickets.",
        "**Statistics** - tickets by state and type, users by state and tier.",
        "**Publish Ticket Panel** - (re)publish the opening panel for users.",
        "**Inactivity Sweep** - force an immediate warning and auto-close pass.",
        "",
        "_The dropdown shows the 25 highest-priority tickets: for others, and for those already",
        'closed, use **Search by Number** inside "Manage Tickets"._',
      ].join("\n"),
    )
    .footer(DASHBOARD_PANEL_MARKER)
    .button({ label: "Manage Tickets", style: ButtonStyle.Primary, customId: "dashboard:tickets" })
    .button({ label: "Manage User", style: ButtonStyle.Primary, customId: "dashboard:user" })
    .button({ label: "Ticket List", style: ButtonStyle.Secondary, customId: "dashboard:list" })
    .button({ label: "Statistics", style: ButtonStyle.Secondary, customId: "dashboard:stats" })
    .button({ label: "Publish Panel", style: ButtonStyle.Secondary, customId: "dashboard:post-panel" })
    .button({ label: "Inactivity Sweep", style: ButtonStyle.Secondary, customId: "dashboard:sweep" })
    .build();
}

/**
 * Pubblica il pannello, oppure aggiorna quello gia' presente. L'operazione e'
 * idempotente per costruzione: girando a ogni avvio, senza il riconoscimento
 * via marker il canale si riempirebbe di copie del pannello.
 */
export async function ensurePanelMessage(
  client: Client,
  channelId: string,
  payload: BaseMessageOptions,
  marker: string,
): Promise<"created" | "updated"> {
  const channel = await client.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error(`Channel ${channelId} does not exist or is not a server text channel.`);
  }

  const recent = await channel.messages.fetch({ limit: 50 });
  const existing = recent.find(
    (message) => message.author.id === client.user?.id && message.embeds[0]?.footer?.text === marker,
  );

  if (existing) {
    await existing.edit(payload);
    return "updated";
  }

  await channel.send(payload);
  return "created";
}
