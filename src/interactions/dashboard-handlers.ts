import {
  ButtonStyle,
  GuildMember,
  MessageFlags,
  ModalBuilder,
  TextInputStyle,
  type BaseMessageOptions,
  type ButtonInteraction,
  type Guild,
  type InteractionReplyOptions,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
} from "discord.js";
import {
  TicketState as PrismaTicketState,
  TicketType as PrismaTicketType,
  AuthState as PrismaAuthState,
  Tier as PrismaTier,
  type PrismaClient,
} from "@prisma/client";
import { VerificationOutcome } from "@prisma/client";
import type { AppConfig } from "../config/index.js";
import { DiscordUserNotFoundError, DomainError, NotInGuildError, UnauthorizedTicketActionError } from "../domain/errors.js";
import { TicketState, TicketType, canTransition } from "../domain/ticket-state.js";
import { AuthState, Tier, parseTier } from "../services/auth-state.js";
import { Colors, EmbedService, Limits } from "../services/embed-service.js";
import { PRISMA_TO_TICKET_STATE, PRISMA_TO_TICKET_TYPE, toStringArray } from "../services/ticket-service.js";
import { InteractionRouter } from "./router.js";
import { TICKET_PANEL_MARKER, buildDashboardPanel, buildTicketOpenPanel, ensurePanelMessage } from "./panels.js";

/**
 * Dashboard staff — un solo pannello pubblico nel canale riservato, da cui
 * parte ogni flusso. Tutte le risposte sono effimere: la dashboard non si
 * sporca con la cronologia delle azioni (quella vive nei canali di log).
 *
 * Nessun handler qui replica logica di dominio: sono tutti thin wrapper su
 * TicketService/AuthService, che restano l'unico posto dove ruoli e stati
 * vengono davvero modificati.
 */

type ComponentInteraction = ButtonInteraction | StringSelectMenuInteraction | UserSelectMenuInteraction;
type AnyDashboardInteraction = ComponentInteraction | ModalSubmitInteraction;

/** Quanti ticket entrano in un menu a tendina: e' un limite di Discord, non una scelta. */
const MAX_SELECT_OPTIONS = Limits.SelectOptions;

const NON_TERMINAL_STATES: PrismaTicketState[] = [
  PrismaTicketState.OPEN,
  PrismaTicketState.CLAIMED,
  PrismaTicketState.AWAITING_USER,
  PrismaTicketState.AWAITING_STAFF,
  PrismaTicketState.RESOLVED,
];

const STATE_LABEL: Record<PrismaTicketState, string> = {
  [PrismaTicketState.OPEN]: "Open",
  [PrismaTicketState.CLAIMED]: "Claimed",
  [PrismaTicketState.AWAITING_USER]: "Awaiting User",
  [PrismaTicketState.AWAITING_STAFF]: "Awaiting Staff",
  [PrismaTicketState.RESOLVED]: "Resolved",
  [PrismaTicketState.CLOSED]: "Closed",
  [PrismaTicketState.ARCHIVED]: "Archived",
  [PrismaTicketState.REJECTED]: "Rejected",
};

const TYPE_LABEL: Record<PrismaTicketType, string> = {
  [PrismaTicketType.VERIFICATION]: "Verification",
  [PrismaTicketType.COMMISSION]: "Commission",
  [PrismaTicketType.SUPPORT]: "Support",
  [PrismaTicketType.PRIORITY_SUPPORT]: "Priority Support",
  [PrismaTicketType.REPORT]: "Report",
};

const AUTH_STATE_LABEL: Record<AuthState, string> = {
  [AuthState.Guest]: "Guest (unverified)",
  [AuthState.Pending]: "Verification pending",
  [AuthState.Verified]: "Verified",
  [AuthState.Suspended]: "Suspended",
};

const TIER_LABEL: Record<Tier, string> = {
  [Tier.None]: "None",
  [Tier.Customer]: "Customer",
  [Tier.Premium]: "Premium",
};

const PRISMA_AUTH_STATE_LABEL: Record<PrismaAuthState, string> = {
  [PrismaAuthState.GUEST]: "Guest",
  [PrismaAuthState.PENDING]: "Pending verification",
  [PrismaAuthState.VERIFIED]: "Verified",
  [PrismaAuthState.SUSPENDED]: "Suspended",
};

const VERIFICATION_OUTCOME_LABEL: Record<VerificationOutcome, string> = {
  [VerificationOutcome.PENDING]: "pending review",
  [VerificationOutcome.APPROVED]: "approved",
  [VerificationOutcome.REJECTED]: "rejected",
};

const PRISMA_TIER_LABEL: Record<PrismaTier, string> = {
  [PrismaTier.NONE]: "No tier",
  [PrismaTier.CUSTOMER]: "Customer",
  [PrismaTier.PREMIUM]: "Premium",
};

// ---------------------------------------------------------------------------
// Helper condivisi
// ---------------------------------------------------------------------------

function requireGuildMember(member: AnyDashboardInteraction["member"]): GuildMember {
  if (!(member instanceof GuildMember)) throw new NotInGuildError();
  return member;
}

/**
 * AuthService non conosce il concetto di "staff" (agisce su chi gli viene
 * passato); TicketService lo verifica da solo. La dashboard e' quindi il punto
 * dove il gate va messo esplicitamente, anche se il canale e' gia' privato:
 * i customId sono indovinabili e un'interazione puo' arrivare da chiunque.
 */
function requireStaff(member: GuildMember, config: AppConfig): GuildMember {
  if (!member.roles.cache.has(config.roles.staff)) {
    throw new UnauthorizedTicketActionError(member.id, TicketType.Support);
  }
  return member;
}

async function fetchTargetMember(guild: Guild, userId: string): Promise<GuildMember> {
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) throw new DiscordUserNotFoundError(userId);
  return member;
}

async function replyWithError(interaction: AnyDashboardInteraction, error: unknown): Promise<void> {
  const description = error instanceof DomainError ? error.message : "An unexpected error occurred.";
  const payload: InteractionReplyOptions = EmbedService.error(description).buildEphemeral();

  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(payload).catch(() => undefined);
  } else {
    await interaction.reply(payload).catch(() => undefined);
  }
}

/**
 * Un flusso della dashboard puo' partire dal pannello pubblico (serve una
 * nuova risposta effimera) o da un pannello effimero gia' aperto (va
 * aggiornato sul posto, altrimenti si accumulano messaggi). La differenza si
 * legge dai flag del messaggio sorgente, quindi ogni handler la ignora.
 */
async function renderPanel(
  interaction: ComponentInteraction,
  build: () => Promise<BaseMessageOptions>,
): Promise<void> {
  const fromEphemeral = interaction.message.flags.has(MessageFlags.Ephemeral);

  if (fromEphemeral) {
    await interaction.deferUpdate();
  } else {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  await interaction.editReply(await build());
}

function backButton(label = "Back to Dashboard", customId = "dashboard:home") {
  return { label, style: ButtonStyle.Secondary as const, customId };
}

function searchButton(label = "Search by Number") {
  return { label, style: ButtonStyle.Primary as const, customId: "dashboard:t-search" };
}

function reasonModal(customId: string, title: string, label: string): ModalBuilder {
  return EmbedService.modal(customId, title)
    .input({ customId: "reason", label, style: TextInputStyle.Paragraph })
    .build();
}

// ---------------------------------------------------------------------------
// Costruttori di pannello
// ---------------------------------------------------------------------------

/** Opzione del menu "scegli un ticket": stessa forma ovunque (lista aperti, risultati ricerca). */
function ticketOption(ticket: { id: string; number: number; type: PrismaTicketType; state: PrismaTicketState; subject: string | null }) {
  return {
    label: `#${ticket.number} - ${TYPE_LABEL[ticket.type]}`,
    value: ticket.id,
    description: ticket.subject ?? STATE_LABEL[ticket.state],
  };
}

async function buildTicketChooser(prisma: PrismaClient): Promise<BaseMessageOptions> {
  const [tickets, total] = await Promise.all([
    prisma.ticket.findMany({
      where: { state: { in: NON_TERMINAL_STATES } },
      orderBy: [{ priority: "desc" }, { openedAt: "asc" }],
      take: MAX_SELECT_OPTIONS,
    }),
    prisma.ticket.count({ where: { state: { in: NON_TERMINAL_STATES } } }),
  ]);

  if (tickets.length === 0) {
    return EmbedService.buttons()
      .color(Colors.Pending)
      .title("No Open Tickets")
      .description("There is nothing to manage right now.\nFor an already closed ticket, use search by number.")
      .button(searchButton())
      .button(backButton())
      .build();
  }

  // Il menu regge 25 opzioni: oltre quelle il resto e' raggiungibile solo per
  // numero, quindi il bottone di ricerca non e' un extra ma la via d'uscita.
  const overflow = total - tickets.length;

  return EmbedService.buttons()
    .color(Colors.GlacialAccent)
    .title("Manage Tickets")
    .description(
      `${total} open tickets. Select one to see all available actions.` +
        (overflow > 0 ? `\n_Showing ${tickets.length} (highest priority): the other ${overflow} can be found by searching by number._` : ""),
    )
    .button(searchButton())
    .button(backButton())
    .select({
      customId: "dashboard:t-select",
      placeholder: "Choose the ticket to manage",
      options: tickets.map(ticketOption),
    })
    .build();
}

async function buildTicketPanel(prisma: PrismaClient, guildId: string, ticketId: string): Promise<BaseMessageOptions> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: {
      author: { select: { discordId: true } },
      claimedBy: { select: { discordId: true } },
      verificationRequest: true,
      _count: { select: { participants: true } },
    },
  });

  if (!ticket) return ticketGonePanel();

  const state = PRISMA_TO_TICKET_STATE[ticket.state];
  const type = PRISMA_TO_TICKET_TYPE[ticket.type];
  /** La state machine di dominio decide cosa e' possibile: qui si traduce in bottoni spenti. */
  const allows = (to: TicketState) => canTransition(state, to, type);

  const panel = EmbedService.buttons()
    .color(ticket.state === PrismaTicketState.RESOLVED ? Colors.Success : Colors.GlacialAccent)
    .title(`Ticket #${ticket.number} - ${TYPE_LABEL[ticket.type]}`)
    .description(
      [
        `**Status:** ${STATE_LABEL[ticket.state]}`,
        `**Author:** <@${ticket.author.discordId}>`,
        `**Assigned to:** ${ticket.claimedBy ? `<@${ticket.claimedBy.discordId}>` : "none"}`,
        `**Subject:** ${ticket.subject ?? "-"}`,
        `**Priority:** ${ticket.priority}`,
        `**Channel:** <#${ticket.channelId}>`,
        `**Added participants:** ${ticket._count.participants}`,
        `**Opened:** <t:${Math.floor(ticket.openedAt.getTime() / 1000)}:R>`,
        `**Last activity:** <t:${Math.floor(ticket.lastActivityAt.getTime() / 1000)}:R>`,
        ...(ticket.transcriptUrl ? [`**Transcript:** [open](${ticket.transcriptUrl})`] : []),
      ].join("\n"),
    );

  const request = ticket.verificationRequest;
  if (request) {
    const proofs = toStringArray(request.proofUrls);
    panel.field(
      "Verification Request",
      [
        `**Platform:** ${request.platform}`,
        `**Username:** ${request.platformUsername}`,
        `**Product:** ${request.product}`,
        `**Purchase date:** ${request.purchaseDate ? request.purchaseDate.toLocaleDateString("en-US") : "not provided"}`,
        `**Attached proof:** ${proofs.length === 0 ? "none" : proofs.map((url, index) => `[#${index + 1}](${url})`).join(" ")}`,
        `**Outcome:** ${VERIFICATION_OUTCOME_LABEL[request.outcome]}`,
      ].join("\n"),
    );

    // Approva/rifiuta solo finche' c'e' davvero qualcosa da decidere: dopo la
    // review il ticket e' chiuso e i bottoni ripeterebbero un'azione conclusa.
    if (request.outcome === VerificationOutcome.PENDING) {
      panel
        .button({
          label: "Approve Verification",
          style: ButtonStyle.Success,
          customId: `dashboard:t-approve:${ticket.id}`,
          disabled: !allows(TicketState.Resolved),
        })
        .button({
          label: "Reject Verification",
          style: ButtonStyle.Danger,
          customId: `dashboard:t-reject:${ticket.id}`,
          disabled: !allows(TicketState.Rejected),
        })
        .newRow();
    }
  }

  return panel
    .button({
      label: "Claim",
      style: ButtonStyle.Primary,
      customId: `dashboard:t-claim:${ticket.id}`,
      disabled: !allows(TicketState.Claimed),
    })
    .button({
      label: "Resolve",
      style: ButtonStyle.Success,
      customId: `dashboard:t-resolve:${ticket.id}`,
      disabled: !allows(TicketState.Resolved),
    })
    .button({
      label: "Reopen",
      style: ButtonStyle.Secondary,
      customId: `dashboard:t-reopen:${ticket.id}`,
      disabled: !allows(TicketState.AwaitingStaff),
    })
    .button({
      label: "Close",
      style: ButtonStyle.Danger,
      customId: `dashboard:t-close:${ticket.id}`,
      disabled: !allows(TicketState.Closed),
    })
    .button({ label: "Delete", style: ButtonStyle.Danger, customId: `dashboard:t-delete:${ticket.id}` })
    .newRow()
    .button({ label: "Rename", style: ButtonStyle.Secondary, customId: `dashboard:t-rename:${ticket.id}` })
    .button({ label: "Priority", style: ButtonStyle.Secondary, customId: `dashboard:t-priority:${ticket.id}` })
    .button({ label: "Participants", style: ButtonStyle.Secondary, customId: `dashboard:t-people:${ticket.id}` })
    .button({ label: "Go to Channel", url: `https://discord.com/channels/${guildId}/${ticket.channelId}` })
    .newRow()
    .button({ label: "Refresh", style: ButtonStyle.Secondary, customId: `dashboard:t-open:${ticket.id}` })
    .button(backButton("Other Ticket", "dashboard:tickets"))
    .button(backButton())
    .build();
}

/**
 * Le tre select di persone stanno in un sotto-pannello, non sul pannello del
 * ticket: un'action row a testa, e sul pannello principale ne restano libere
 * troppo poche per le azioni di verifica (il limite Discord e' 5 righe).
 */
async function buildParticipantsPanel(prisma: PrismaClient, ticketId: string): Promise<BaseMessageOptions> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: {
      claimedBy: { select: { discordId: true } },
      participants: { include: { user: { select: { discordId: true } } } },
    },
  });

  if (!ticket) return ticketGonePanel();

  const participants = ticket.participants.map((entry) => `<@${entry.user.discordId}>`);

  return EmbedService.buttons()
    .color(Colors.GlacialAccent)
    .title(`People on Ticket #${ticket.number}`)
    .description(
      [
        `**Assigned to:** ${ticket.claimedBy ? `<@${ticket.claimedBy.discordId}>` : "none"}`,
        `**Manually added:** ${participants.length > 0 ? participants.join(", ") : "none"}`,
        "",
        "_Transfer only accepts staff members; adding a user opens the channel for them._",
      ].join("\n"),
    )
    .button({ label: "Back to Ticket", style: ButtonStyle.Secondary, customId: `dashboard:t-open:${ticket.id}` })
    .button(backButton())
    .userSelect({ customId: `dashboard:t-assign:${ticket.id}`, placeholder: "Transfer to a staff member" })
    .userSelect({ customId: `dashboard:t-add:${ticket.id}`, placeholder: "Add a user to the ticket" })
    .userSelect({ customId: `dashboard:t-remove:${ticket.id}`, placeholder: "Remove a user from the ticket" })
    .build();
}

/**
 * Ricerca per numero. Il numero e' unico per TIPO (@@unique([type, number]) in
 * schema.prisma), quindi "#12" puo' identificare fino a cinque ticket diversi:
 * si mostra sempre l'elenco dei match invece di indovinare.
 */
async function buildSearchResults(prisma: PrismaClient, number: number): Promise<BaseMessageOptions> {
  const matches = await prisma.ticket.findMany({ where: { number }, orderBy: { openedAt: "desc" }, take: MAX_SELECT_OPTIONS });

  if (matches.length === 0) {
    return EmbedService.buttons()
      .color(Colors.Pending)
      .title(`No Ticket #${number}`)
      .description("No ticket with this number, in any state.")
      .button(searchButton("Search Again"))
      .button(backButton())
      .build();
  }

  return EmbedService.buttons()
    .color(Colors.GlacialAccent)
    .title(`Ticket #${number}`)
    .description(
      matches.length === 1
        ? "A single ticket with this number."
        : `${matches.length} tickets share the number #${number} (numbering restarts at 1 for each type).`,
    )
    .button(searchButton("Search Again"))
    .button(backButton())
    .select({ customId: "dashboard:t-select", placeholder: "Open the ticket", options: matches.map(ticketOption) })
    .build();
}

function ticketGonePanel(): BaseMessageOptions {
  return EmbedService.buttons()
    .color(Colors.Error)
    .title("Ticket Not Found")
    .description("The ticket was deleted in the meantime.")
    .button(backButton("Back to List", "dashboard:tickets"))
    .button(backButton())
    .build();
}

function buildUserChooser(): BaseMessageOptions {
  return EmbedService.buttons()
    .color(Colors.GlacialAccent)
    .title("Manage User")
    .description("Select the member to manage: you will see their status, tier, and recent tickets before acting.")
    .userSelect({ customId: "dashboard:u-select", placeholder: "Search for a server member" })
    .button(backButton())
    .build();
}

const RECENT_TICKETS_SHOWN = 5;

async function buildUserPanel(
  prisma: PrismaClient,
  target: GuildMember,
  state: AuthState,
  tier: Tier,
): Promise<BaseMessageOptions> {
  // Prima di agire su un utente serve sapere se ha gia' una pratica aperta:
  // senza questo si rischia di verificare a mano qualcuno il cui ticket di
  // verifica e' ancora da revisionare (e resterebbe li', aperto).
  const record = await prisma.user.findUnique({
    where: { discordId: target.id },
    include: {
      authoredTickets: { orderBy: { openedAt: "desc" }, take: RECENT_TICKETS_SHOWN },
      _count: { select: { authoredTickets: true } },
    },
  });

  const recent = record?.authoredTickets ?? [];
  const openCount = recent.filter((ticket) => NON_TERMINAL_STATES.includes(ticket.state)).length;

  const panel = EmbedService.buttons()
    .color(state === AuthState.Suspended ? Colors.Error : Colors.GlacialAccent)
    .title(target.user.tag)
    .description(
      [
        `**Status:** ${AUTH_STATE_LABEL[state]}`,
        `**Tier:** ${TIER_LABEL[tier]}`,
        `**Joined server:** ${target.joinedAt ? `<t:${Math.floor(target.joinedAt.getTime() / 1000)}:R>` : "unknown"}`,
        `**Total tickets opened:** ${record?._count.authoredTickets ?? 0}${openCount > 0 ? ` (${openCount} not closed among the most recent)` : ""}`,
        "",
        "_Verification assigns status **and** tier; changing the tier leaves the status unchanged._",
      ].join("\n"),
    )
    .field(
      `Recent Tickets (max ${RECENT_TICKETS_SHOWN})`,
      recent.length === 0
        ? "_no tickets opened by this user_"
        : recent
            .map(
              (ticket) =>
                `**#${ticket.number}** - ${STATE_LABEL[ticket.state]} - <t:${Math.floor(ticket.openedAt.getTime() / 1000)}:R>`,
            )
            .join("\n"),
    )
    .button({ label: "Verify", style: ButtonStyle.Success, customId: `dashboard:u-verify:${target.id}` })
    .button({ label: "Reject Verification", style: ButtonStyle.Secondary, customId: `dashboard:u-reject:${target.id}` });

  if (state === AuthState.Suspended) {
    panel.button({ label: "Revoke Suspension", style: ButtonStyle.Primary, customId: `dashboard:u-unsuspend:${target.id}` });
  } else {
    panel.button({ label: "Suspend", style: ButtonStyle.Danger, customId: `dashboard:u-suspend:${target.id}` });
  }

  return panel
    .button({ label: "Refresh", style: ButtonStyle.Secondary, customId: `dashboard:u-open:${target.id}` })
    .button(backButton())
    .select({
      customId: `dashboard:u-tier:${target.id}`,
      placeholder: "Change tier",
      options: [
        { label: TIER_LABEL[Tier.None], value: Tier.None, description: "Removes tier roles", default: tier === Tier.None },
        { label: TIER_LABEL[Tier.Customer], value: Tier.Customer, default: tier === Tier.Customer },
        { label: TIER_LABEL[Tier.Premium], value: Tier.Premium, default: tier === Tier.Premium },
      ],
    })
    .build();
}

async function buildTicketList(prisma: PrismaClient): Promise<BaseMessageOptions> {
  const tickets = await prisma.ticket.findMany({
    where: { state: { in: NON_TERMINAL_STATES } },
    orderBy: [{ priority: "desc" }, { openedAt: "asc" }],
    include: { author: { select: { discordId: true } } },
  });

  if (tickets.length === 0) {
    return EmbedService.buttons()
      .color(Colors.Pending)
      .title("No Open Tickets")
      .description("All clear.")
      .button({ label: "Refresh", style: ButtonStyle.Secondary, customId: "dashboard:list" })
      .button(backButton())
      .build();
  }

  // Il troncamento sul limite di 4096 caratteri e' responsabilita' di
  // descriptionLines (embed-service): qui si producono solo le righe.
  return EmbedService.buttons()
    .color(Colors.GlacialAccent)
    .title(`Open Tickets (${tickets.length})`)
    .descriptionLines(
      tickets.map(
        (ticket) =>
          `**#${ticket.number}** - ${STATE_LABEL[ticket.state]} - <@${ticket.author.discordId}> - ` +
          `<#${ticket.channelId}> - <t:${Math.floor(ticket.lastActivityAt.getTime() / 1000)}:R>`,
      ),
      (hidden) => `_…and ${hidden} more tickets._`,
    )
    .button({ label: "Refresh", style: ButtonStyle.Secondary, customId: "dashboard:list" })
    .button(backButton())
    .build();
}

async function buildStats(prisma: PrismaClient): Promise<BaseMessageOptions> {
  const [byState, byType, usersByState, usersByTier, total] = await Promise.all([
    prisma.ticket.groupBy({ by: ["state"], _count: { _all: true } }),
    prisma.ticket.groupBy({ by: ["type"], _count: { _all: true } }),
    prisma.user.groupBy({ by: ["authState"], _count: { _all: true } }),
    prisma.user.groupBy({ by: ["tier"], _count: { _all: true } }),
    prisma.ticket.count(),
  ]);

  const format = (rows: readonly { label: string; count: number }[]): string =>
    rows.length === 0 ? "_no data_" : rows.map((row) => `${row.label}: **${row.count}**`).join("\n");

  return EmbedService.buttons()
    .color(Colors.Amber)
    .title("Statistics")
    .description(`Total tickets recorded: **${total}**`)
    .field(
      "Tickets by State",
      format(byState.map((row) => ({ label: STATE_LABEL[row.state], count: row._count._all }))),
      true,
    )
    .field(
      "Tickets by Type",
      format(byType.map((row) => ({ label: TYPE_LABEL[row.type], count: row._count._all }))),
      true,
    )
    .field(
      "Users by Status",
      format(usersByState.map((row) => ({ label: PRISMA_AUTH_STATE_LABEL[row.authState], count: row._count._all }))),
      true,
    )
    .field(
      "Users by Tier",
      format(usersByTier.map((row) => ({ label: PRISMA_TIER_LABEL[row.tier], count: row._count._all }))),
      true,
    )
    .timestamp()
    .button({ label: "Refresh", style: ButtonStyle.Secondary, customId: "dashboard:stats" })
    .button(backButton())
    .build();
}

// ---------------------------------------------------------------------------
// Registrazione route
// ---------------------------------------------------------------------------

export function registerDashboardHandlers(router: InteractionRouter, config: AppConfig): void {
  /** Ogni route parte da qui: staff verificato, poi il corpo vero e proprio. */
  async function guarded(
    interaction: AnyDashboardInteraction,
    body: (staff: GuildMember) => Promise<void>,
  ): Promise<void> {
    try {
      const staff = requireStaff(requireGuildMember(interaction.member), config);
      await body(staff);
    } catch (error) {
      await replyWithError(interaction, error);
    }
  }

  /** Dove atterra l'utente dopo un'azione: il pannello del ticket, il sotto-pannello persone, o la lista (quando il ticket non c'e' piu'). */
  type TicketLanding = "panel" | "people" | "chooser";

  function landOn(landing: TicketLanding, prisma: PrismaClient, guildId: string, ticketId: string) {
    if (landing === "chooser") return buildTicketChooser(prisma);
    if (landing === "people") return buildParticipantsPanel(prisma, ticketId);
    return buildTicketPanel(prisma, guildId, ticketId);
  }

  /** Azione su ticket lanciata da un pannello effimero: esegui e ridisegna. */
  async function ticketAction(
    interaction: ComponentInteraction,
    ticketId: string | undefined,
    action: (staff: GuildMember, id: string) => Promise<void>,
    landing: TicketLanding = "panel",
  ): Promise<void> {
    if (!ticketId) return;
    await guarded(interaction, async (staff) => {
      await interaction.deferUpdate();
      await action(staff, ticketId);
      await interaction.editReply(await landOn(landing, interaction.client.services.prisma, staff.guild.id, ticketId));
    });
  }

  /**
   * Un modal aperto da un componente puo' aggiornare il messaggio di partenza
   * (isFromMessage): senza questo il pannello effimero da cui e' partita
   * l'azione resta sullo stato vecchio, e lo staff rilegge dati gia' superati.
   */
  async function modalAction(
    interaction: ModalSubmitInteraction,
    ticketId: string | undefined,
    action: (staff: GuildMember, id: string) => Promise<void>,
    landing: TicketLanding = "panel",
  ): Promise<void> {
    if (!ticketId) return;
    await guarded(interaction, async (staff) => {
      if (interaction.isFromMessage()) await interaction.deferUpdate();
      else await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      await action(staff, ticketId);
      await interaction.editReply(await landOn(landing, interaction.client.services.prisma, staff.guild.id, ticketId));
    });
  }

  // --- Navigazione -------------------------------------------------------
  router.registerButton("dashboard:home", async (interaction) => {
    await guarded(interaction, async () => {
      await renderPanel(interaction, async () => buildDashboardPanel());
    });
  });

  router.registerButton("dashboard:tickets", async (interaction) => {
    await guarded(interaction, async () => {
      await renderPanel(interaction, async () => buildTicketChooser(interaction.client.services.prisma));
    });
  });

  router.registerButton("dashboard:user", async (interaction) => {
    await guarded(interaction, async () => {
      await renderPanel(interaction, async () => buildUserChooser());
    });
  });

  router.registerButton("dashboard:list", async (interaction) => {
    await guarded(interaction, async () => {
      await renderPanel(interaction, async () => buildTicketList(interaction.client.services.prisma));
    });
  });

  router.registerButton("dashboard:stats", async (interaction) => {
    await guarded(interaction, async () => {
      await renderPanel(interaction, async () => buildStats(interaction.client.services.prisma));
    });
  });

  router.registerButton("dashboard:post-panel", async (interaction) => {
    await guarded(interaction, async () => {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const outcome = await ensurePanelMessage(
        interaction.client,
        config.channels.ticketPanel,
        buildTicketOpenPanel(),
        TICKET_PANEL_MARKER,
      );
      await interaction.editReply(
        EmbedService.success(
          outcome === "created"
            ? `Panel published in <#${config.channels.ticketPanel}>.`
            : `Panel already present in <#${config.channels.ticketPanel}>: updated instead of duplicating it.`,
        ).build(),
      );
    });
  });

  router.registerButton("dashboard:sweep", async (interaction) => {
    await guarded(interaction, async () => {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await interaction.client.services.ticket.checkInactiveTickets();
      await interaction.editReply(
        EmbedService.success("Inactivity sweep complete: warnings sent and expired tickets closed.").build(),
      );
    });
  });

  // --- Ticket -------------------------------------------------------------
  router.registerSelect("dashboard:t-select", async (interaction) => {
    await guarded(interaction, async (staff) => {
      const ticketId = interaction.values[0];
      if (!ticketId) return;
      await renderPanel(interaction, async () =>
        buildTicketPanel(interaction.client.services.prisma, staff.guild.id, ticketId),
      );
    });
  });

  /** Apertura diretta per id: la usano "Aggiorna", il ritorno dal sotto-pannello e i risultati di ricerca. */
  router.registerButton("dashboard:t-open", async (interaction, [ticketId]) => {
    if (!ticketId) return;
    await guarded(interaction, async (staff) => {
      await renderPanel(interaction, async () =>
        buildTicketPanel(interaction.client.services.prisma, staff.guild.id, ticketId),
      );
    });
  });

  router.registerButton("dashboard:t-people", async (interaction, [ticketId]) => {
    if (!ticketId) return;
    await guarded(interaction, async () => {
      await renderPanel(interaction, async () => buildParticipantsPanel(interaction.client.services.prisma, ticketId));
    });
  });

  router.registerButton("dashboard:t-search", async (interaction) => {
    await guarded(interaction, async () => {
      await interaction.showModal(
        EmbedService.modal("dashboard:t-search-modal", "Search Ticket")
          .input({
            customId: "number",
            label: "Ticket number (without #)",
            placeholder: "Numbering restarts at 1 for each ticket type",
            maxLength: 9,
          })
          .build(),
      );
    });
  });

  router.registerModal("dashboard:t-search-modal", async (interaction) => {
    await guarded(interaction, async () => {
      if (interaction.isFromMessage()) await interaction.deferUpdate();
      else await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const raw = interaction.fields.getTextInputValue("number").trim().replace(/^#/, "");
      const number = Number.parseInt(raw, 10);
      if (Number.isNaN(number)) {
        await interaction.editReply(EmbedService.error(`"${raw}" is not a ticket number.`).build());
        return;
      }

      await interaction.editReply(await buildSearchResults(interaction.client.services.prisma, number));
    });
  });

  router.registerButton("dashboard:t-claim", async (interaction, [ticketId]) => {
    await ticketAction(interaction, ticketId, (staff, id) => interaction.client.services.ticket.claim(id, staff));
  });

  router.registerButton("dashboard:t-resolve", async (interaction, [ticketId]) => {
    await ticketAction(interaction, ticketId, (staff, id) => interaction.client.services.ticket.resolve(id, staff));
  });

  router.registerButton("dashboard:t-reopen", async (interaction, [ticketId]) => {
    await ticketAction(interaction, ticketId, (staff, id) => interaction.client.services.ticket.reopen(id, staff));
  });

  router.registerButton("dashboard:t-delete", async (interaction, [ticketId]) => {
    // Il canale sparisce: tornare al pannello del ticket mostrerebbe un record
    // orfano, quindi si rientra sulla lista.
    await ticketAction(interaction, ticketId, (staff, id) => interaction.client.services.ticket.remove(id, staff), "chooser");
  });

  router.registerButton("dashboard:t-close", async (interaction, [ticketId]) => {
    if (!ticketId) return;
    await guarded(interaction, async () => {
      await interaction.showModal(
        reasonModal(`dashboard:t-close-modal:${ticketId}`, "Close Ticket", "Reason for closing"),
      );
    });
  });

  router.registerModal("dashboard:t-close-modal", async (interaction, [ticketId]) => {
    // Dopo la chiusura il canale viene eliminato a breve: si torna alla lista,
    // non a un pannello che punta a un canale in via di sparizione.
    await modalAction(
      interaction,
      ticketId,
      (staff, id) => interaction.client.services.ticket.close(id, staff, interaction.fields.getTextInputValue("reason")),
      "chooser",
    );
  });

  router.registerButton("dashboard:t-rename", async (interaction, [ticketId]) => {
    if (!ticketId) return;
    await guarded(interaction, async () => {
      await interaction.showModal(
        EmbedService.modal(`dashboard:t-rename-modal:${ticketId}`, "Rename Ticket")
          .input({
            customId: "subject",
            label: "New ticket subject",
            placeholder: "Shown in the list and in the channel topic",
            maxLength: 100,
          })
          .build(),
      );
    });
  });

  router.registerModal("dashboard:t-rename-modal", async (interaction, [ticketId]) => {
    await modalAction(interaction, ticketId, (staff, id) =>
      interaction.client.services.ticket.rename(id, interaction.fields.getTextInputValue("subject"), staff),
    );
  });

  router.registerButton("dashboard:t-priority", async (interaction, [ticketId]) => {
    if (!ticketId) return;
    await guarded(interaction, async () => {
      await interaction.showModal(
        EmbedService.modal(`dashboard:t-priority-modal:${ticketId}`, "Ticket Priority")
          .input({
            customId: "priority",
            label: "Priority (whole number)",
            placeholder: "Higher = higher in the list. Default 0.",
            maxLength: 3,
          })
          .build(),
      );
    });
  });

  router.registerModal("dashboard:t-priority-modal", async (interaction, [ticketId]) => {
    if (!ticketId) return;
    await guarded(interaction, async (staff) => {
      if (interaction.isFromMessage()) await interaction.deferUpdate();
      else await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const raw = interaction.fields.getTextInputValue("priority").trim();
      const priority = Number.parseInt(raw, 10);

      // Input non valido: si rimette il pannello com'era e si spiega l'errore a
      // parte, invece di sostituire il pannello con un messaggio d'errore.
      if (Number.isNaN(priority)) {
        await interaction.editReply(
          await buildTicketPanel(interaction.client.services.prisma, staff.guild.id, ticketId),
        );
        await interaction.followUp(EmbedService.error(`"${raw}" is not a whole number.`).buildEphemeral());
        return;
      }

      await interaction.client.services.ticket.setPriority(ticketId, priority, staff);
      await interaction.editReply(await buildTicketPanel(interaction.client.services.prisma, staff.guild.id, ticketId));
    });
  });

  // --- Verifica (dal pannello del ticket) ---------------------------------
  router.registerButton("dashboard:t-approve", async (interaction, [ticketId]) => {
    if (!ticketId) return;
    await guarded(interaction, async () => {
      await interaction.deferUpdate();
      await interaction.editReply(
        EmbedService.buttons()
          .color(Colors.Info)
          .title("Which tier are you approving with?")
          .description('The tier is assigned together with the "verified" status, then the ticket is closed.')
          .select({
            customId: `dashboard:t-approve-tier:${ticketId}`,
            placeholder: "Choose the tier",
            options: [
              { label: TIER_LABEL[Tier.None], value: Tier.None, description: "Verify without assigning a tier" },
              { label: TIER_LABEL[Tier.Customer], value: Tier.Customer },
              { label: TIER_LABEL[Tier.Premium], value: Tier.Premium },
            ],
          })
          .button({ label: "Back to Ticket", style: ButtonStyle.Secondary, customId: `dashboard:t-open:${ticketId}` })
          .build(),
      );
    });
  });

  router.registerSelect("dashboard:t-approve-tier", async (interaction, [ticketId]) => {
    const tier = parseTier(interaction.values[0]);
    if (!tier) return;
    // approveVerification chiude il ticket: si rientra sulla lista.
    await ticketAction(
      interaction,
      ticketId,
      (staff, id) => interaction.client.services.ticket.approveVerification(id, staff, tier),
      "chooser",
    );
  });

  router.registerButton("dashboard:t-reject", async (interaction, [ticketId]) => {
    if (!ticketId) return;
    await guarded(interaction, async () => {
      await interaction.showModal(
        reasonModal(`dashboard:t-reject-modal:${ticketId}`, "Reject Verification", "Reason (will be sent to the user)"),
      );
    });
  });

  router.registerModal("dashboard:t-reject-modal", async (interaction, [ticketId]) => {
    await modalAction(
      interaction,
      ticketId,
      (staff, id) =>
        interaction.client.services.ticket.rejectVerification(id, staff, interaction.fields.getTextInputValue("reason")),
      "chooser",
    );
  });

  // --- Partecipanti -------------------------------------------------------
  router.registerUserSelect("dashboard:t-assign", async (interaction, [ticketId]) => {
    const targetId = interaction.values[0];
    if (!ticketId || !targetId) return;
    await ticketAction(
      interaction,
      ticketId,
      async (staff, id) => {
        const target = await fetchTargetMember(staff.guild, targetId);
        await interaction.client.services.ticket.transfer(id, target, staff);
      },
      "people",
    );
  });

  router.registerUserSelect("dashboard:t-add", async (interaction, [ticketId]) => {
    const targetId = interaction.values[0];
    if (!ticketId || !targetId) return;
    await ticketAction(
      interaction,
      ticketId,
      (staff, id) => interaction.client.services.ticket.addParticipant(id, targetId, staff),
      "people",
    );
  });

  router.registerUserSelect("dashboard:t-remove", async (interaction, [ticketId]) => {
    const targetId = interaction.values[0];
    if (!ticketId || !targetId) return;
    await ticketAction(
      interaction,
      ticketId,
      (staff, id) => interaction.client.services.ticket.removeParticipant(id, targetId, staff),
      "people",
    );
  });

  // --- Utenti -------------------------------------------------------------
  /** Stato e tier si rileggono sempre dai ruoli (fonte di verita', vedi auth-service). */
  async function userPanelFor(
    interaction: AnyDashboardInteraction,
    staff: GuildMember,
    userId: string,
  ): Promise<BaseMessageOptions> {
    const { auth, prisma } = interaction.client.services;
    const target = await fetchTargetMember(staff.guild, userId);
    return buildUserPanel(prisma, target, auth.getState(target), auth.getTier(target));
  }

  /** Ricarica stato/tier dai ruoli e ridisegna il pannello utente. */
  async function refreshUserPanel(interaction: ComponentInteraction, staff: GuildMember, userId: string): Promise<void> {
    await interaction.editReply(await userPanelFor(interaction, staff, userId));
  }

  router.registerUserSelect("dashboard:u-select", async (interaction) => {
    await guarded(interaction, async (staff) => {
      const userId = interaction.values[0];
      if (!userId) return;
      await renderPanel(interaction, async () => userPanelFor(interaction, staff, userId));
    });
  });

  router.registerButton("dashboard:u-open", async (interaction, [userId]) => {
    if (!userId) return;
    await guarded(interaction, async (staff) => {
      await renderPanel(interaction, async () => userPanelFor(interaction, staff, userId));
    });
  });

  router.registerButton("dashboard:u-verify", async (interaction, [userId]) => {
    if (!userId) return;
    await guarded(interaction, async () => {
      await interaction.deferUpdate();
      await interaction.editReply(
        EmbedService.buttons()
          .color(Colors.Info)
          .title("Which tier?")
          .description(`You are about to verify <@${userId}>. The chosen tier is assigned together with the "verified" status.`)
          .select({
            customId: `dashboard:u-verify-tier:${userId}`,
            placeholder: "Choose the tier",
            options: [
              { label: TIER_LABEL[Tier.None], value: Tier.None, description: "Verify without assigning a tier" },
              { label: TIER_LABEL[Tier.Customer], value: Tier.Customer },
              { label: TIER_LABEL[Tier.Premium], value: Tier.Premium },
            ],
          })
          .button(backButton())
          .build(),
      );
    });
  });

  router.registerSelect("dashboard:u-verify-tier", async (interaction, [userId]) => {
    if (!userId) return;
    await guarded(interaction, async (staff) => {
      const tier = parseTier(interaction.values[0]);
      if (!tier) return;

      await interaction.deferUpdate();
      const target = await fetchTargetMember(staff.guild, userId);
      await interaction.client.services.auth.complete(target, tier);
      await refreshUserPanel(interaction, staff, userId);
    });
  });

  router.registerSelect("dashboard:u-tier", async (interaction, [userId]) => {
    if (!userId) return;
    await guarded(interaction, async (staff) => {
      const tier = parseTier(interaction.values[0]);
      if (!tier) return;

      await interaction.deferUpdate();
      const target = await fetchTargetMember(staff.guild, userId);
      await interaction.client.services.auth.setTier(target, tier);
      await refreshUserPanel(interaction, staff, userId);
    });
  });

  router.registerButton("dashboard:u-unsuspend", async (interaction, [userId]) => {
    if (!userId) return;
    await guarded(interaction, async (staff) => {
      await interaction.deferUpdate();
      const target = await fetchTargetMember(staff.guild, userId);
      await interaction.client.services.auth.unsuspend(target);
      await refreshUserPanel(interaction, staff, userId);
    });
  });

  router.registerButton("dashboard:u-reject", async (interaction, [userId]) => {
    if (!userId) return;
    await guarded(interaction, async () => {
      await interaction.showModal(
        reasonModal(`dashboard:u-reject-modal:${userId}`, "Reject Verification", "Reason (will be sent via DM to the user)"),
      );
    });
  });

  router.registerModal("dashboard:u-reject-modal", async (interaction, [userId]) => {
    await userModalAction(interaction, userId, (target) =>
      interaction.client.services.auth.reject(target, interaction.fields.getTextInputValue("reason")),
    );
  });

  router.registerButton("dashboard:u-suspend", async (interaction, [userId]) => {
    if (!userId) return;
    await guarded(interaction, async () => {
      await interaction.showModal(reasonModal(`dashboard:u-suspend-modal:${userId}`, "Suspend User", "Reason for suspension"));
    });
  });

  router.registerModal("dashboard:u-suspend-modal", async (interaction, [userId]) => {
    await userModalAction(interaction, userId, (target) =>
      interaction.client.services.auth.suspend(target, interaction.fields.getTextInputValue("reason")),
    );
  });

  /** Come modalAction, ma per le azioni su utente: agisce e ridisegna il pannello utente. */
  async function userModalAction(
    interaction: ModalSubmitInteraction,
    userId: string | undefined,
    action: (target: GuildMember) => Promise<void>,
  ): Promise<void> {
    if (!userId) return;
    await guarded(interaction, async (staff) => {
      if (interaction.isFromMessage()) await interaction.deferUpdate();
      else await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      await action(await fetchTargetMember(staff.guild, userId));
      await interaction.editReply(await userPanelFor(interaction, staff, userId));
    });
  }
}
