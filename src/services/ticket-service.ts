import {
  AttachmentBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  type Client,
  type GuildMember,
  type Message,
  type OverwriteResolvable,
  type TextChannel,
} from "discord.js";
import {
  TicketType as PrismaTicketType,
  TicketState as PrismaTicketState,
  VerificationPlatform,
  VerificationOutcome,
  type PrismaClient,
  type Prisma,
  type Ticket as TicketRecord,
} from "@prisma/client";
import type { AppConfig, CategoryIds } from "../config/index.js";
import {
  TicketType,
  TicketState,
  assertTransition,
  buildTicketChannelName,
} from "../domain/ticket-state.js";
import {
  TicketCooldownError,
  TicketLimitReachedError,
  NotAVerificationTicketError,
  TicketNotFoundError,
  UnauthorizedTicketActionError,
  AlreadyVerifiedError,
  VerificationAlreadyPendingError,
  SuspendedUserError,
} from "../domain/errors.js";
import { AuthState, Tier } from "./auth-state.js";
import type { AuthService } from "./auth-service.js";
import type { LoggerService } from "./logger-service.js";
import { BRAND_NAME, Colors, EmbedService } from "./embed-service.js";

// VerificationPlatform e' puramente un dato categorico da mostrare/salvare,
// senza logica d'ordine come AuthState/Tier: riusiamo direttamente l'enum
// generato da Prisma invece di duplicarlo nel dominio.
export { VerificationPlatform };

export interface VerificationSubmission {
  platform: VerificationPlatform;
  platformUsername: string;
  product: string;
  purchaseDate?: Date;
}

export interface TicketFormField {
  label: string;
  value: string;
}

interface OpenTicketParams {
  type: Exclude<TicketType, TicketType.Verification>;
  author: GuildMember;
  subject?: string;
  /** Campi raccolti dalla form di apertura (vedi ticket-handlers.ts), postati come embed nel canale. */
  details?: readonly TicketFormField[];
}

const TICKET_TYPE_TO_PRISMA: Record<TicketType, PrismaTicketType> = {
  [TicketType.Verification]: PrismaTicketType.VERIFICATION,
  [TicketType.Commission]: PrismaTicketType.COMMISSION,
  [TicketType.Support]: PrismaTicketType.SUPPORT,
  [TicketType.PrioritySupport]: PrismaTicketType.PRIORITY_SUPPORT,
  [TicketType.Report]: PrismaTicketType.REPORT,
};

/** Esportate: la dashboard ne ha bisogno per interrogare la state machine di dominio. */
export const PRISMA_TO_TICKET_TYPE: Record<PrismaTicketType, TicketType> = {
  [PrismaTicketType.VERIFICATION]: TicketType.Verification,
  [PrismaTicketType.COMMISSION]: TicketType.Commission,
  [PrismaTicketType.SUPPORT]: TicketType.Support,
  [PrismaTicketType.PRIORITY_SUPPORT]: TicketType.PrioritySupport,
  [PrismaTicketType.REPORT]: TicketType.Report,
};

const TICKET_STATE_TO_PRISMA: Record<TicketState, PrismaTicketState> = {
  [TicketState.Open]: PrismaTicketState.OPEN,
  [TicketState.Claimed]: PrismaTicketState.CLAIMED,
  [TicketState.AwaitingUser]: PrismaTicketState.AWAITING_USER,
  [TicketState.AwaitingStaff]: PrismaTicketState.AWAITING_STAFF,
  [TicketState.Resolved]: PrismaTicketState.RESOLVED,
  [TicketState.Closed]: PrismaTicketState.CLOSED,
  [TicketState.Archived]: PrismaTicketState.ARCHIVED,
  [TicketState.Rejected]: PrismaTicketState.REJECTED,
};

export const PRISMA_TO_TICKET_STATE: Record<PrismaTicketState, TicketState> = {
  [PrismaTicketState.OPEN]: TicketState.Open,
  [PrismaTicketState.CLAIMED]: TicketState.Claimed,
  [PrismaTicketState.AWAITING_USER]: TicketState.AwaitingUser,
  [PrismaTicketState.AWAITING_STAFF]: TicketState.AwaitingStaff,
  [PrismaTicketState.RESOLVED]: TicketState.Resolved,
  [PrismaTicketState.CLOSED]: TicketState.Closed,
  [PrismaTicketState.ARCHIVED]: TicketState.Archived,
  [PrismaTicketState.REJECTED]: TicketState.Rejected,
};

const NON_TERMINAL_PRISMA_STATES: PrismaTicketState[] = [
  PrismaTicketState.OPEN,
  PrismaTicketState.CLAIMED,
  PrismaTicketState.AWAITING_USER,
  PrismaTicketState.AWAITING_STAFF,
  PrismaTicketState.RESOLVED,
];

/** proofUrls e' Json su SQLite (vedi schema.prisma): serve rileggerlo come lista. */
export function toStringArray(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * TicketService — orchestratore del ciclo di vita dei ticket. Non scrive MAI
 * i ruoli di verifica direttamente: per lo stato d'autorizzazione chiama
 * sempre AuthService.begin/complete/reject.
 */
export class TicketService {
  private readonly pendingDeletions = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly client: Client,
    private readonly config: AppConfig,
    private readonly logger: LoggerService,
    private readonly auth: AuthService,
  ) {}

  // ---------------------------------------------------------------------
  // Apertura
  // ---------------------------------------------------------------------

  async openTicket({ type, author, subject, details }: OpenTicketParams): Promise<TicketRecord> {
    await this.assertCanOpen(type, author);
    const user = await this.ensureUser(author.id);

    const number = await this.reserveTicketNumber(type);
    const channel = await this.createTicketChannel(type, author, number);

    let ticket: TicketRecord;
    try {
      ticket = await this.prisma.ticket.create({
        data: { type: TICKET_TYPE_TO_PRISMA[type], number, channelId: channel.id, authorId: user.id, subject },
      });
    } catch (error) {
      await channel.delete("Rollback: ticket creation failed on DB").catch(() => undefined);
      throw error;
    }

    await this.logger.log({
      type: "ticket.opened",
      ticketId: ticket.id,
      ticketType: type,
      ticketNumber: number,
      authorId: author.id,
    });

    await channel.send(this.buildWelcomeMessage(type, ticket.number, author));
    await channel.send(this.buildControlPanel(type, ticket.id));

    if (details && details.length > 0) {
      const embed = EmbedService.info(
        details.map((field) => `**${field.label}:** ${field.value}`).join("\n"),
        "Request Details",
      ).build();
      await channel.send(embed);
    }

    return ticket;
  }

  /** VERIFICATION e' un flusso a se': l'apertura crea insieme ticket + richiesta + auth.begin. */
  async openVerificationTicket(author: GuildMember, submission: VerificationSubmission): Promise<TicketRecord> {
    await this.assertCanOpen(TicketType.Verification, author);
    const user = await this.ensureUser(author.id);

    const number = await this.reserveTicketNumber(TicketType.Verification);
    const channel = await this.createTicketChannel(TicketType.Verification, author, number);

    let ticket: TicketRecord;
    try {
      ticket = await this.prisma.ticket.create({
        data: { type: PrismaTicketType.VERIFICATION, number, channelId: channel.id, authorId: user.id },
      });
      await this.prisma.verificationRequest.create({
        data: {
          ticketId: ticket.id,
          userId: user.id,
          platform: submission.platform,
          platformUsername: submission.platformUsername,
          product: submission.product,
          purchaseDate: submission.purchaseDate,
        },
      });
    } catch (error) {
      await channel.delete("Rollback: verification ticket creation failed on DB").catch(() => undefined);
      throw error;
    }

    await this.logger.log({
      type: "ticket.opened",
      ticketId: ticket.id,
      ticketType: TicketType.Verification,
      ticketNumber: number,
      authorId: author.id,
    });

    await this.auth.begin(author, ticket.id);

    await channel.send(this.buildWelcomeMessage(TicketType.Verification, ticket.number, author));
    await channel.send(
      EmbedService.info(
        `**Platform:** ${submission.platform}\n**Username:** ${submission.platformUsername}\n**Product:** ${submission.product}` +
          (submission.purchaseDate ? `\n**Purchase date:** ${submission.purchaseDate.toLocaleDateString("en-US")}` : ""),
        "Request Details",
      )
        .footer("Now attach proof of purchase with /prova-acquisto in this channel.")
        .build(),
    );
    await channel.send(this.buildControlPanel(TicketType.Verification, ticket.id));

    return ticket;
  }

  /** Da /prova-acquisto: le modal non accettano file, quindi la prova arriva come opzione Attachment. */
  async submitProof(ticketId: string, submitter: GuildMember, attachmentUrls: readonly string[]): Promise<void> {
    const ticket = await this.getTicketOrThrow(ticketId);
    // Senza questo controllo, usare /prova-acquisto in un ticket di supporto
    // faceva esplodere findUniqueOrThrow con un errore Prisma incomprensibile.
    if (ticket.type !== PrismaTicketType.VERIFICATION) throw new NotAVerificationTicketError(ticketId);
    await this.assertParticipant(ticket, submitter);

    // SQLite non ha liste native (vedi prisma/schema.prisma): proofUrls e' Json,
    // quindi l'append e' un read-modify-write, non un push atomico come su Postgres.
    // Innocuo qui: un solo staff/autore scrive alla volta su questo campo.
    const existing = await this.prisma.verificationRequest.findUniqueOrThrow({ where: { ticketId } });
    const updatedUrls = [...toStringArray(existing.proofUrls), ...attachmentUrls];

    await this.prisma.verificationRequest.update({
      where: { ticketId },
      data: { proofUrls: updatedUrls },
    });

    await this.logger.log({
      type: "ticket.proof_submitted",
      ticketId,
      ticketNumber: ticket.number,
      userId: submitter.id,
      attachmentUrls,
    });

    await this.notifyChannel(
      ticket.channelId,
      EmbedService.success(`Received ${attachmentUrls.length} attachment(s). A staff member will review the request.`, "Proof Received").build(),
    );
  }

  // ---------------------------------------------------------------------
  // Gestione staff
  // ---------------------------------------------------------------------

  async claim(ticketId: string, staff: GuildMember): Promise<void> {
    this.assertStaff(staff);
    const staffUser = await this.ensureUser(staff.id);
    const ticket = await this.transition(ticketId, TicketState.Claimed);

    await this.prisma.ticket.update({ where: { id: ticketId }, data: { claimedById: staffUser.id } });
    await this.logger.log({ type: "ticket.claimed", ticketId, ticketNumber: ticket.number, staffId: staff.id });
    await this.notifyChannel(ticket.channelId, EmbedService.info(`Claimed by <@${staff.id}>.`, "Ticket Assigned").build());
  }

  async transfer(ticketId: string, toStaff: GuildMember, byStaff: GuildMember): Promise<void> {
    this.assertStaff(byStaff);
    this.assertStaff(toStaff);
    const toUser = await this.ensureUser(toStaff.id);
    const ticket = await this.getTicketOrThrow(ticketId);

    await this.prisma.ticket.update({ where: { id: ticketId }, data: { claimedById: toUser.id } });
    await this.notifyChannel(
      ticket.channelId,
      EmbedService.info(`Transferred from <@${byStaff.id}> to <@${toStaff.id}>.`, "Ticket Transferred").build(),
    );
  }

  async addParticipant(ticketId: string, targetUserId: string, byStaff: GuildMember): Promise<void> {
    this.assertStaff(byStaff);
    const ticket = await this.getTicketOrThrow(ticketId);
    const targetUser = await this.ensureUser(targetUserId);

    await this.prisma.ticketParticipant.upsert({
      where: { ticketId_userId: { ticketId, userId: targetUser.id } },
      create: { ticketId, userId: targetUser.id },
      update: {},
    });

    const channel = await this.fetchTicketChannel(ticket.channelId);
    await channel.permissionOverwrites.create(targetUserId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
    });

    await this.notifyChannel(ticket.channelId, EmbedService.info(`<@${targetUserId}> added to the ticket by <@${byStaff.id}>.`).build());
  }

  async removeParticipant(ticketId: string, targetUserId: string, byStaff: GuildMember): Promise<void> {
    this.assertStaff(byStaff);
    const ticket = await this.getTicketOrThrow(ticketId);

    await this.prisma.ticketParticipant
      .delete({ where: { ticketId_userId: { ticketId, userId: (await this.ensureUser(targetUserId)).id } } })
      .catch(() => undefined);

    const channel = await this.fetchTicketChannel(ticket.channelId);
    await channel.permissionOverwrites.delete(targetUserId).catch(() => undefined);

    await this.notifyChannel(ticket.channelId, EmbedService.info(`<@${targetUserId}> removed from the ticket by <@${byStaff.id}>.`).build());
  }

  async rename(ticketId: string, subject: string, byStaff: GuildMember): Promise<void> {
    this.assertStaff(byStaff);
    const ticket = await this.getTicketOrThrow(ticketId);
    await this.prisma.ticket.update({ where: { id: ticketId }, data: { subject } });

    const channel = await this.fetchTicketChannel(ticket.channelId);
    await channel.setTopic(`Ticket #${ticket.number} - ${subject}`).catch(() => undefined);
  }

  async setPriority(ticketId: string, priority: number, byStaff: GuildMember): Promise<void> {
    this.assertStaff(byStaff);
    const ticket = await this.getTicketOrThrow(ticketId);
    await this.prisma.ticket.update({ where: { id: ticketId }, data: { priority } });
    await this.notifyChannel(ticket.channelId, EmbedService.info(`Priority set to **${priority}** by <@${byStaff.id}>.`).build());
  }

  // ---------------------------------------------------------------------
  // Ciclo di vita
  // ---------------------------------------------------------------------

  async resolve(ticketId: string, byStaff: GuildMember): Promise<void> {
    this.assertStaff(byStaff);
    const ticket = await this.transition(ticketId, TicketState.Resolved);
    await this.notifyChannel(ticket.channelId, EmbedService.success(`Resolved by <@${byStaff.id}>.`, "Ticket Resolved").build());
  }

  async close(ticketId: string, closedBy: GuildMember | "system", reason?: string): Promise<void> {
    if (closedBy !== "system") this.assertStaff(closedBy);
    const ticket = await this.transition(ticketId, TicketState.Closed);
    await this.logger.log({
      type: "ticket.closed",
      ticketId,
      ticketNumber: ticket.number,
      closedBy: closedBy === "system" ? "system" : closedBy.id,
      reason,
    });
    await this.finalize(ticket, closedBy === "system" ? "system" : closedBy.id, reason, "closed");
  }

  async reopen(ticketId: string, byStaff: GuildMember): Promise<void> {
    this.assertStaff(byStaff);
    this.cancelScheduledDeletion(ticketId);
    const ticket = await this.transition(ticketId, TicketState.AwaitingStaff);
    await this.logger.log({ type: "ticket.reopened", ticketId, ticketNumber: ticket.number, reopenedBy: byStaff.id });
    await this.notifyChannel(ticket.channelId, EmbedService.info(`Reopened by <@${byStaff.id}>.`, "Ticket Reopened").build());
  }

  async remove(ticketId: string, byStaff: GuildMember): Promise<void> {
    this.assertStaff(byStaff);
    const ticket = await this.getTicketOrThrow(ticketId);
    this.cancelScheduledDeletion(ticketId);

    await this.prisma.ticket.update({ where: { id: ticketId }, data: { state: PrismaTicketState.ARCHIVED, archivedAt: new Date() } });
    await this.logger.log({ type: "ticket.deleted", ticketId, ticketNumber: ticket.number, deletedBy: byStaff.id });

    await this.fetchTicketChannel(ticket.channelId)
      .then((channel) => channel.delete(`Ticket deleted by ${byStaff.user.tag}`))
      .catch(() => undefined);
  }

  async approveVerification(ticketId: string, staff: GuildMember, tier: Tier): Promise<void> {
    this.assertStaff(staff);
    const ticket = await this.getTicketOrThrow(ticketId);
    if (PRISMA_TO_TICKET_TYPE[ticket.type] !== TicketType.Verification) {
      throw new UnauthorizedTicketActionError(staff.id, PRISMA_TO_TICKET_TYPE[ticket.type]);
    }

    const author = await this.fetchAuthorMember(ticket, staff.guild);
    const { dmSent } = await this.auth.complete(author, tier, ticketId);

    await this.transition(ticketId, TicketState.Resolved);

    if (!dmSent) {
      await this.notifyChannel(
        ticket.channelId,
        EmbedService.success(`You have been verified! Tier assigned: **${tier}**. (Could not reach you via DM: check your privacy settings.)`, "Verification Approved").build(),
      );
    } else {
      await this.notifyChannel(ticket.channelId, EmbedService.success(`Verification approved by <@${staff.id}>. Tier: **${tier}**.`, "Verification Approved").build());
    }

    await this.prisma.verificationRequest.update({
      where: { ticketId },
      data: { outcome: VerificationOutcome.APPROVED, reviewedBy: staff.id, reviewedAt: new Date() },
    });

    await this.close(ticketId, staff, "Verification approved");
  }

  async rejectVerification(ticketId: string, staff: GuildMember, reason: string): Promise<void> {
    this.assertStaff(staff);
    const ticket = await this.getTicketOrThrow(ticketId);
    if (PRISMA_TO_TICKET_TYPE[ticket.type] !== TicketType.Verification) {
      throw new UnauthorizedTicketActionError(staff.id, PRISMA_TO_TICKET_TYPE[ticket.type]);
    }

    const author = await this.fetchAuthorMember(ticket, staff.guild);
    await this.auth.reject(author, reason, ticketId);

    await this.prisma.verificationRequest.update({
      where: { ticketId },
      data: { outcome: VerificationOutcome.REJECTED, reviewedBy: staff.id, reviewReason: reason, reviewedAt: new Date() },
    });

    const transitioned = await this.transition(ticketId, TicketState.Rejected);
    await this.finalize(transitioned, staff.id, reason, "rejected");
  }

  /** Chiamato periodicamente (vedi index.ts) per warning + auto-close per inattivita'. */
  async checkInactiveTickets(): Promise<void> {
    const now = Date.now();
    const openTickets = await this.prisma.ticket.findMany({
      where: { state: { in: [PrismaTicketState.CLAIMED, PrismaTicketState.AWAITING_USER, PrismaTicketState.AWAITING_STAFF] } },
    });

    for (const ticket of openTickets) {
      const idleMs = now - ticket.lastActivityAt.getTime();

      try {
        if (idleMs >= this.config.tickets.autoCloseInactivityMs) {
          await this.close(ticket.id, "system", "Prolonged inactivity");
        } else if (idleMs >= this.config.tickets.autoCloseWarningMs && !ticket.inactivityWarnedAt) {
          const remainingMs = this.config.tickets.autoCloseInactivityMs - idleMs;
          await this.notifyChannel(
            ticket.channelId,
            EmbedService.pending(
              `This ticket will be automatically closed in ${Math.max(1, Math.round(remainingMs / 60_000))} minutes if there are no new messages.`,
              "Ticket Inactive",
            ).build(),
          );
          await this.prisma.ticket.update({ where: { id: ticket.id }, data: { inactivityWarnedAt: new Date() } });
        }
      } catch (error) {
        await this.logger.log({
          type: "system.error",
          scope: "ticket.autoClose",
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
  }

  /** Da agganciare a src/events/messageCreate.ts. */
  async bumpActivity(channelId: string): Promise<void> {
    await this.prisma.ticket
      .updateMany({
        where: { channelId, state: { in: NON_TERMINAL_PRISMA_STATES } },
        data: { lastActivityAt: new Date(), inactivityWarnedAt: null },
      })
      .catch(() => undefined);
  }

  // ---------------------------------------------------------------------
  // Interni
  // ---------------------------------------------------------------------

  private async assertCanOpen(type: TicketType, author: GuildMember): Promise<void> {
    const state = this.auth.getState(author);
    if (state === AuthState.Suspended) throw new SuspendedUserError(author.id);

    if (type === TicketType.Verification) {
      if (state === AuthState.Verified) throw new AlreadyVerifiedError(author.id);
      if (state === AuthState.Pending) throw new VerificationAlreadyPendingError(author.id);
    }

    if (type === TicketType.PrioritySupport) {
      if (!this.auth.hasAtLeast(author, AuthState.Verified) || !this.auth.hasTierAtLeast(author, Tier.Customer)) {
        throw new UnauthorizedTicketActionError(author.id, type);
      }
    }

    const user = await this.ensureUser(author.id);

    const openCount = await this.prisma.ticket.count({
      where: { authorId: user.id, type: TICKET_TYPE_TO_PRISMA[type], state: { in: NON_TERMINAL_PRISMA_STATES } },
    });
    if (openCount >= this.config.tickets.maxOpenPerUserPerType) {
      throw new TicketLimitReachedError(author.id, type, this.config.tickets.maxOpenPerUserPerType);
    }

    const lastTicket = await this.prisma.ticket.findFirst({
      where: { authorId: user.id, type: TICKET_TYPE_TO_PRISMA[type] },
      orderBy: { openedAt: "desc" },
    });
    if (lastTicket && Date.now() - lastTicket.openedAt.getTime() < this.config.tickets.cooldownMs) {
      throw new TicketCooldownError(author.id, type, this.config.tickets.cooldownMs);
    }
  }

  private assertStaff(member: GuildMember): void {
    if (!member.roles.cache.has(this.config.roles.staff)) {
      throw new UnauthorizedTicketActionError(member.id, TicketType.Support);
    }
  }

  private async assertParticipant(ticket: TicketRecord, member: GuildMember): Promise<void> {
    const user = await this.ensureUser(member.id);
    if (user.id === ticket.authorId) return;
    if (member.roles.cache.has(this.config.roles.staff)) return;

    const participant = await this.prisma.ticketParticipant.findUnique({
      where: { ticketId_userId: { ticketId: ticket.id, userId: user.id } },
    });
    if (!participant) throw new UnauthorizedTicketActionError(member.id, PRISMA_TO_TICKET_TYPE[ticket.type]);
  }

  private async ensureUser(discordId: string): Promise<{ id: string }> {
    return this.prisma.user.upsert({ where: { discordId }, create: { discordId }, update: {} });
  }

  private async getTicketOrThrow(ticketId: string): Promise<TicketRecord> {
    const ticket = await this.prisma.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw new TicketNotFoundError(ticketId);
    return ticket;
  }

  /**
   * Transizione con difesa dal doppio click: l'update e' condizionato allo
   * stato letto poco prima (`where: { state: ticket.state }`). Se un'altra
   * richiesta concorrente ha gia' vinto la corsa, `count` torna 0 e la
   * transizione fallisce esplicitamente invece di applicarsi due volte.
   */
  private async transition(ticketId: string, to: TicketState): Promise<TicketRecord> {
    const ticket = await this.getTicketOrThrow(ticketId);
    const from = PRISMA_TO_TICKET_STATE[ticket.state];
    const type = PRISMA_TO_TICKET_TYPE[ticket.type];

    assertTransition(from, to, type);

    const timestampField = this.timestampFieldFor(to);
    const result = await this.prisma.ticket.updateMany({
      where: { id: ticketId, state: ticket.state },
      data: { state: TICKET_STATE_TO_PRISMA[to], ...timestampField },
    });

    if (result.count === 0) {
      throw new TicketNotFoundError(`${ticketId} (state modified concurrently)`);
    }

    return { ...ticket, state: TICKET_STATE_TO_PRISMA[to], ...timestampField } as TicketRecord;
  }

  private timestampFieldFor(state: TicketState): Partial<Pick<TicketRecord, "claimedAt" | "resolvedAt" | "closedAt" | "archivedAt">> {
    const now = new Date();
    switch (state) {
      case TicketState.Claimed:
        return { claimedAt: now };
      case TicketState.Resolved:
        return { resolvedAt: now };
      case TicketState.Closed:
      case TicketState.Rejected:
        return { closedAt: now };
      case TicketState.Archived:
        return { archivedAt: now };
      default:
        return {};
    }
  }

  private async reserveTicketNumber(type: TicketType): Promise<number> {
    const prismaType = TICKET_TYPE_TO_PRISMA[type];
    const counter = await this.prisma.ticketCounter.upsert({
      where: { type: prismaType },
      create: { type: prismaType, value: 1 },
      update: { value: { increment: 1 } },
    });
    return counter.value;
  }

  private categoryFor(type: TicketType): string {
    const map: Record<TicketType, keyof CategoryIds> = {
      [TicketType.Verification]: "verification",
      [TicketType.Commission]: "commissions",
      [TicketType.Support]: "support",
      [TicketType.PrioritySupport]: "prioritySupport",
      [TicketType.Report]: "moderation",
    };
    return this.config.categories[map[type]];
  }

  private async createTicketChannel(type: TicketType, author: GuildMember, number: number): Promise<TextChannel> {
    const guild = author.guild;

    const overwrites: OverwriteResolvable[] = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: author.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
        ],
      },
      {
        id: this.config.roles.staff,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageMessages,
        ],
      },
    ];

    const channel = await guild.channels.create({
      name: buildTicketChannelName(type, number),
      type: ChannelType.GuildText,
      parent: this.categoryFor(type),
      permissionOverwrites: overwrites,
      topic: `Ticket #${number} - ${type} - opened by ${author.user.tag}`,
    });

    return channel;
  }

  private async fetchTicketChannel(channelId: string): Promise<TextChannel> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      throw new TicketNotFoundError(`channel ${channelId} not found or not a text channel`);
    }
    return channel;
  }

  private async fetchAuthorMember(ticket: TicketRecord, guild: GuildMember["guild"]): Promise<GuildMember> {
    const authorRecord = await this.prisma.user.findUniqueOrThrow({ where: { id: ticket.authorId } });
    return guild.members.fetch(authorRecord.discordId);
  }

  private async notifyChannel(channelId: string, options: Parameters<TextChannel["send"]>[0]): Promise<Message> {
    const channel = await this.fetchTicketChannel(channelId);
    return channel.send(options);
  }

  private buildWelcomeMessage(type: TicketType, number: number, author: GuildMember) {
    const byType: Record<TicketType, string> = {
      [TicketType.Verification]: "A staff member will review your verification request shortly.",
      [TicketType.Commission]: "Describe the commission you want to request here: type of work, estimated budget, and deadline.",
      [TicketType.Support]: "Describe the issue you are experiencing; a staff member will respond shortly.",
      [TicketType.PrioritySupport]: "Priority ticket: staff has been notified.",
      [TicketType.Report]: "Describe the report: this channel is visible to staff only.",
    };

    return EmbedService.info(byType[type], `Ticket #${number}`)
      .footer(`Opened by ${author.user.tag}`)
      .build();
  }

  /**
   * Pannello staff postato nel canale del ticket alla creazione: senza questo,
   * le route `ticket:*` / `verify:*` esistevano ma nessun messaggio le esponeva.
   *
   * I bottoni sono visibili anche all'autore (che vede il canale), ma ogni
   * handler passa da assertStaff: la sicurezza sta nel service, non nel
   * nascondere il componente.
   */
  private buildControlPanel(type: TicketType, ticketId: string) {
    const panel = EmbedService.buttons()
      .color(Colors.GlacialAccent)
      .title("Ticket Management")
      .description("Actions reserved for staff.")
      .footer(BRAND_NAME)
      .button({ label: "Claim", style: ButtonStyle.Primary, customId: `ticket:claim:${ticketId}` })
      .button({ label: "Resolve", style: ButtonStyle.Success, customId: `ticket:resolve:${ticketId}` })
      .button({ label: "Reopen", style: ButtonStyle.Secondary, customId: `ticket:reopen:${ticketId}` })
      .button({ label: "Close", style: ButtonStyle.Danger, customId: `ticket:close:${ticketId}` });

    if (type === TicketType.Verification) {
      panel
        .button({ label: "Approve Verification", style: ButtonStyle.Success, customId: `verify:approve:${ticketId}` })
        .button({ label: "Reject Verification", style: ButtonStyle.Danger, customId: `verify:reject:${ticketId}` });
    }

    return panel.build();
  }

  private async finalize(
    ticket: TicketRecord,
    actorId: string,
    reason: string | undefined,
    verb: "closed" | "rejected",
  ): Promise<void> {
    const transcript = await this.buildTranscript(ticket.channelId, ticket.number);
    await this.uploadTranscript(ticket, transcript);

    const label = actorId === "system" ? "the system (inactivity)" : `<@${actorId}>`;
    const deleteInMinutes = Math.round(this.config.tickets.closeDeleteDelayMs / 60_000);

    await this.notifyChannel(
      ticket.channelId,
      EmbedService.warning(
        `Ticket ${verb} by ${label}${reason ? ` - ${reason}` : "."}\nThe channel will be deleted in ${deleteInMinutes} minutes.`,
        `Ticket ${verb === "closed" ? "Closed" : "Rejected"}`,
      ).build(),
    ).catch(() => undefined);

    this.scheduleDeletion(ticket.id, ticket.channelId, this.config.tickets.closeDeleteDelayMs);
  }

  private async buildTranscript(channelId: string, ticketNumber: number): Promise<{ html: Buffer; json: Buffer }> {
    const channel = await this.fetchTicketChannel(channelId);
    const messages: Message[] = [];
    let before: string | undefined;

    for (let page = 0; page < 5 && messages.length < 500; page++) {
      const batch = await channel.messages.fetch({ limit: 100, before });
      if (batch.size === 0) break;
      messages.push(...batch.values());
      before = batch.last()?.id;
      if (batch.size < 100) break;
    }

    messages.reverse();

    const jsonPayload = messages.map((message) => ({
      id: message.id,
      author: { id: message.author.id, tag: message.author.tag },
      content: message.content,
      attachments: message.attachments.map((attachment) => attachment.url),
      createdAt: message.createdAt.toISOString(),
    }));

    const rows = messages
      .map((message) => {
        const attachments = message.attachments
          .map((attachment) => `<a href="${attachment.url}">${escapeHtml(attachment.name)}</a>`)
          .join(", ");
        return `<tr><td>${escapeHtml(message.createdAt.toISOString())}</td><td>${escapeHtml(message.author.tag)}</td><td>${escapeHtml(message.content)}</td><td>${attachments}</td></tr>`;
      })
      .join("\n");

    const html =
      `<!doctype html><html><head><meta charset="utf-8"><title>Ticket #${ticketNumber} Transcript</title>` +
      `<style>body{font-family:sans-serif;background:#0b1420;color:#e2e8f0}table{width:100%;border-collapse:collapse}td{padding:6px;border-bottom:1px solid #22303f;vertical-align:top}</style>` +
      `</head><body><h1>Ticket #${ticketNumber} Transcript</h1><table>${rows}</table></body></html>`;

    return { html: Buffer.from(html, "utf-8"), json: Buffer.from(JSON.stringify(jsonPayload, null, 2), "utf-8") };
  }

  private async uploadTranscript(ticket: TicketRecord, transcript: { html: Buffer; json: Buffer }): Promise<void> {
    const archiveChannel = await this.fetchTicketChannel(this.config.channels.archive);
    const message = await archiveChannel.send({
      content: `Ticket #${ticket.number} transcript (${PRISMA_TO_TICKET_TYPE[ticket.type]})`,
      files: [
        new AttachmentBuilder(transcript.html, { name: `ticket-${ticket.number}.html` }),
        new AttachmentBuilder(transcript.json, { name: `ticket-${ticket.number}.json` }),
      ],
    });

    const htmlUrl = message.attachments.find((attachment) => attachment.name.endsWith(".html"))?.url;
    await this.prisma.ticket.update({ where: { id: ticket.id }, data: { transcriptUrl: htmlUrl } });
  }

  private scheduleDeletion(ticketId: string, channelId: string, delayMs: number): void {
    this.cancelScheduledDeletion(ticketId);

    const timer = setTimeout(() => {
      this.pendingDeletions.delete(ticketId);
      void this.archiveAndDelete(ticketId, channelId).catch((error: unknown) =>
        this.logger.log({
          type: "system.error",
          scope: "ticket.autoDelete",
          error: error instanceof Error ? error : new Error(String(error)),
        }),
      );
    }, delayMs);

    timer.unref();
    this.pendingDeletions.set(ticketId, timer);
  }

  private cancelScheduledDeletion(ticketId: string): void {
    const timer = this.pendingDeletions.get(ticketId);
    if (timer) {
      clearTimeout(timer);
      this.pendingDeletions.delete(ticketId);
    }
  }

  private async archiveAndDelete(ticketId: string, channelId: string): Promise<void> {
    await this.prisma.ticket.update({
      where: { id: ticketId },
      data: { state: PrismaTicketState.ARCHIVED, archivedAt: new Date() },
    });

    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (channel?.type === ChannelType.GuildText) {
      await channel.delete("Auto-delete after closing").catch(() => undefined);
    }
  }
}
