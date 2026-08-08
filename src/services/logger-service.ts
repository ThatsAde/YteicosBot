import { ChannelType, type Client, type TextChannel } from "discord.js";
import { LogLevel as PrismaLogLevel, LogCategory as PrismaLogCategory, type PrismaClient, type Prisma } from "@prisma/client";
import type { AppConfig } from "../config/index.js";
import { LogCategory } from "../config/index.js";
import type { Tier } from "./auth-state.js";
import { EmbedService, Colors } from "./embed-service.js";
import { LogChannelUnavailableError } from "../domain/errors.js";
import { logger as consoleLogger } from "../utils/logger.js";

/**
 * Severita' dell'evento di dominio. Distinta dal LogLevel di utils/logger.ts
 * (quello e' la soglia del logger di processo generico; questo e' un dato di
 * dominio, persistito su AuditLog.level).
 */
export enum LogLevel {
  Debug,
  Info,
  Warn,
  Error,
}

interface BaseLogEvent {
  actorId?: string;
}

export type LogEvent =
  | (BaseLogEvent & { type: "auth.begin"; userId: string; ticketId: string })
  // ticketId opzionale: verifica e rifiuto possono partire anche dalla dashboard
  // staff, dove non c'e' nessun ticket associato.
  | (BaseLogEvent & { type: "auth.complete"; userId: string; tier: Tier; ticketId?: string })
  | (BaseLogEvent & { type: "auth.reject"; userId: string; reason: string; ticketId?: string })
  | (BaseLogEvent & { type: "auth.suspend"; userId: string; reason: string })
  | (BaseLogEvent & { type: "auth.unsuspend"; userId: string })
  | (BaseLogEvent & { type: "auth.tier_changed"; userId: string; from: Tier; to: Tier })
  | (BaseLogEvent & { type: "ticket.opened"; ticketId: string; ticketType: string; ticketNumber: number; authorId: string })
  | (BaseLogEvent & { type: "ticket.claimed"; ticketId: string; ticketNumber: number; staffId: string })
  | (BaseLogEvent & {
      type: "ticket.message_flagged";
      ticketId: string;
      ticketNumber: number;
      messageId: string;
      reason: string;
    })
  | (BaseLogEvent & { type: "ticket.closed"; ticketId: string; ticketNumber: number; closedBy: string; reason?: string })
  | (BaseLogEvent & { type: "ticket.reopened"; ticketId: string; ticketNumber: number; reopenedBy: string })
  | (BaseLogEvent & { type: "ticket.deleted"; ticketId: string; ticketNumber: number; deletedBy: string })
  | (BaseLogEvent & {
      type: "ticket.proof_submitted";
      ticketId: string;
      ticketNumber: number;
      userId: string;
      attachmentUrls: readonly string[];
    })
  | (BaseLogEvent & { type: "system.error"; scope: string; error: Error });

type EventType = LogEvent["type"];

interface EventMeta {
  category: LogCategory;
  level: LogLevel;
}

const EVENT_META: { [K in EventType]: EventMeta } = {
  "auth.begin": { category: LogCategory.Auth, level: LogLevel.Info },
  "auth.complete": { category: LogCategory.Auth, level: LogLevel.Info },
  "auth.reject": { category: LogCategory.Auth, level: LogLevel.Warn },
  "auth.suspend": { category: LogCategory.Auth, level: LogLevel.Warn },
  "auth.unsuspend": { category: LogCategory.Auth, level: LogLevel.Info },
  "auth.tier_changed": { category: LogCategory.Purchase, level: LogLevel.Info },
  "ticket.opened": { category: LogCategory.Ticket, level: LogLevel.Info },
  "ticket.claimed": { category: LogCategory.Ticket, level: LogLevel.Info },
  "ticket.message_flagged": { category: LogCategory.Moderation, level: LogLevel.Warn },
  "ticket.closed": { category: LogCategory.Ticket, level: LogLevel.Info },
  "ticket.reopened": { category: LogCategory.Ticket, level: LogLevel.Info },
  "ticket.deleted": { category: LogCategory.Ticket, level: LogLevel.Warn },
  "ticket.proof_submitted": { category: LogCategory.Ticket, level: LogLevel.Info },
  "system.error": { category: LogCategory.System, level: LogLevel.Error },
};

interface RenderedEvent {
  title: string;
  description: string;
}

type EventRenderer<K extends EventType> = (event: Extract<LogEvent, { type: K }>) => RenderedEvent;

/** Le azioni auth possono nascere da un ticket o dalla dashboard staff: la
 *  provenienza va nel messaggio solo quando esiste davvero un ticket. */
function originSuffix(ticketId: string | undefined): string {
  return ticketId ? ` (ticket <#${ticketId}>).` : " (manual action from the staff dashboard).";
}

// Mappa esaustiva: dimenticare un renderer per un nuovo membro di LogEvent e'
// un errore di compilazione (manca la chiave nel mapped type), non un bug a runtime.
const EVENT_RENDERERS: { [K in EventType]: EventRenderer<K> } = {
  "auth.begin": (e) => ({
    title: "Verification Started",
    description: `<@${e.userId}> started a verification (ticket <#${e.ticketId}>).`,
  }),
  "auth.complete": (e) => ({
    title: "Verification Completed",
    description: `<@${e.userId}> was verified with tier **${e.tier}**${originSuffix(e.ticketId)}`,
  }),
  "auth.reject": (e) => ({
    title: "Verification Rejected",
    description: `<@${e.userId}> rejected - ${e.reason}${originSuffix(e.ticketId)}`,
  }),
  "auth.suspend": (e) => ({
    title: "User Suspended",
    description: `<@${e.userId}> suspended - ${e.reason}.`,
  }),
  "auth.unsuspend": (e) => ({
    title: "Suspension Revoked",
    description: `<@${e.userId}> can interact with the bot again (status reverted to guest).`,
  }),
  "auth.tier_changed": (e) => ({
    title: "Tier Updated",
    description: `<@${e.userId}>: ${e.from} -> ${e.to}.`,
  }),
  "ticket.opened": (e) => ({
    title: `Ticket #${e.ticketNumber} Opened`,
    description: `Type **${e.ticketType}** by <@${e.authorId}>.`,
  }),
  "ticket.claimed": (e) => ({
    title: `Ticket #${e.ticketNumber} Claimed`,
    description: `By <@${e.staffId}>.`,
  }),
  "ticket.message_flagged": (e) => ({
    title: `Message Reported - Ticket #${e.ticketNumber}`,
    description: `Reason: ${e.reason} (message \`${e.messageId}\`).`,
  }),
  "ticket.closed": (e) => ({
    title: `Ticket #${e.ticketNumber} Closed`,
    description: `By <@${e.closedBy}>${e.reason ? ` - ${e.reason}` : "."}`,
  }),
  "ticket.reopened": (e) => ({
    title: `Ticket #${e.ticketNumber} Reopened`,
    description: `By <@${e.reopenedBy}>.`,
  }),
  "ticket.deleted": (e) => ({
    title: `Ticket #${e.ticketNumber} Deleted`,
    description: `By <@${e.deletedBy}>.`,
  }),
  "ticket.proof_submitted": (e) => ({
    title: `Proof Received - Ticket #${e.ticketNumber}`,
    description: `By <@${e.userId}>: ${e.attachmentUrls.length} attachment(s).`,
  }),
  "system.error": (e) => ({
    title: `System Error (${e.scope})`,
    description: e.error.message,
  }),
};

/**
 * TS non correla automaticamente l'indicizzazione di una mappa esaustiva sul
 * discriminante ("correlated unions") col narrowing di `event`: e' un limite
 * noto del type-checker, non un buco di questo codice. L'unico modo per
 * evitarlo sarebbe uno switch con un caso per membro, che e' esattamente cio'
 * che la mappa vuole rimpiazzare. Il cast e' quindi corretto per costruzione
 * (la mappa e' esaustiva grazie al mapped type sopra) e localizzato qui soltanto.
 */
function renderEvent(event: LogEvent): RenderedEvent {
  const renderer = EVENT_RENDERERS[event.type] as (e: LogEvent) => RenderedEvent;
  return renderer(event);
}

function extractUserId(event: LogEvent): string | undefined {
  return "userId" in event ? event.userId : undefined;
}

function extractTicketId(event: LogEvent): string | undefined {
  return "ticketId" in event ? event.ticketId : undefined;
}

const CATEGORY_TO_PRISMA: Record<LogCategory, PrismaLogCategory> = {
  [LogCategory.Auth]: PrismaLogCategory.AUTH,
  [LogCategory.Ticket]: PrismaLogCategory.TICKET,
  [LogCategory.Moderation]: PrismaLogCategory.MODERATION,
  [LogCategory.Purchase]: PrismaLogCategory.PURCHASE,
  [LogCategory.System]: PrismaLogCategory.SYSTEM,
};

const LEVEL_TO_PRISMA: Record<LogLevel, PrismaLogLevel> = {
  [LogLevel.Debug]: PrismaLogLevel.DEBUG,
  [LogLevel.Info]: PrismaLogLevel.INFO,
  [LogLevel.Warn]: PrismaLogLevel.WARN,
  [LogLevel.Error]: PrismaLogLevel.ERROR,
};

const LEVEL_TO_CONSOLE_METHOD: Record<LogLevel, "debug" | "info" | "warn" | "error"> = {
  [LogLevel.Debug]: "debug",
  [LogLevel.Info]: "info",
  [LogLevel.Warn]: "warn",
  [LogLevel.Error]: "error",
};

const LEVEL_TO_EMBED_COLOR: Record<LogLevel, number> = {
  [LogLevel.Debug]: Colors.Pending,
  [LogLevel.Info]: Colors.Info,
  [LogLevel.Warn]: Colors.Warning,
  [LogLevel.Error]: Colors.Error,
};

const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_THRESHOLD = 5;

interface RateBucket {
  windowStart: number;
  count: number;
  suppressed: number;
}

/** JSON.parse ritorna `any` per contratto di libreria (lib.es5.d.ts): l'unico
 *  punto che tocca quel bordo e' questo, con un cast esplicito e mirato al
 *  tipo Json di Prisma — non e' un `unknown as` e non propaga `any` altrove. */
function toJsonPayload(event: LogEvent): Prisma.InputJsonValue {
  const replacer = (_key: string, value: unknown): unknown => {
    if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
    return value;
  };
  return JSON.parse(JSON.stringify(event, replacer)) as Prisma.InputJsonValue;
}

/**
 * LoggerService — ogni evento di dominio finisce su tre sink INDIPENDENTI:
 * console, AuditLog (Postgres), embed nel canale Discord della categoria.
 * Un sink che fallisce (Discord down, DB down) non deve impedire agli altri
 * di scrivere: per questo i tre sink girano con Promise.allSettled, non await
 * in sequenza con throw.
 */
export class LoggerService {
  private readonly rateBuckets = new Map<EventType, RateBucket>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly client: Client,
    private readonly config: AppConfig,
  ) {}

  async log(event: LogEvent): Promise<void> {
    const meta = EVENT_META[event.type];
    const rendered = renderEvent(event);

    const results = await Promise.allSettled([
      this.writeConsole(event, meta, rendered),
      this.writeAudit(event, meta),
      this.writeDiscord(event, meta, rendered),
    ]);

    for (const result of results) {
      if (result.status === "rejected") {
        consoleLogger.scope("logger-service").error("Sink di log fallito", result.reason);
      }
    }
  }

  private async writeConsole(event: LogEvent, meta: EventMeta, rendered: RenderedEvent): Promise<void> {
    const scoped = consoleLogger.scope(meta.category);
    const method = LEVEL_TO_CONSOLE_METHOD[meta.level];

    if (process.env.NODE_ENV === "production") {
      scoped[method](JSON.stringify(event));
    } else {
      scoped[method](`${rendered.title} — ${rendered.description}`);
    }
  }

  private async writeAudit(event: LogEvent, meta: EventMeta): Promise<void> {
    const userId = extractUserId(event);
    const ticketId = extractTicketId(event);

    const [user, ticket] = await Promise.all([
      userId ? this.prisma.user.findUnique({ where: { discordId: userId } }) : Promise.resolve(null),
      ticketId ? this.prisma.ticket.findUnique({ where: { id: ticketId } }) : Promise.resolve(null),
    ]);

    await this.prisma.auditLog.create({
      data: {
        category: CATEGORY_TO_PRISMA[meta.category],
        level: LEVEL_TO_PRISMA[meta.level],
        eventType: event.type,
        message: renderEvent(event).description,
        payload: toJsonPayload(event),
        userId: user?.id,
        ticketId: ticket?.id,
      },
    });
  }

  private async writeDiscord(event: LogEvent, meta: EventMeta, rendered: RenderedEvent): Promise<void> {
    const { emit, aggregateNote } = this.shouldEmitEmbed(event.type);
    if (!emit) return;

    const channel = await this.resolveLogChannel(meta.category);

    const description = aggregateNote ? `${rendered.description}\n\n${aggregateNote}` : rendered.description;

    const message = EmbedService.basic()
      .color(LEVEL_TO_EMBED_COLOR[meta.level])
      .title(rendered.title)
      .description(description)
      .footer("Yteicos")
      .timestamp()
      .build();

    await channel.send(message);
  }

  private async resolveLogChannel(category: LogCategory): Promise<TextChannel> {
    const channelId = this.config.channels.logs[category];
    const channel = await this.client.channels.fetch(channelId).catch(() => null);

    if (channel?.type !== ChannelType.GuildText) {
      throw new LogChannelUnavailableError(channelId);
    }

    return channel;
  }

  /**
   * Se lo stesso tipo di evento supera la soglia entro la finestra, sopprime
   * l'embed (console e DB continuano a scrivere sempre) e aggrega: la prossima
   * volta che la finestra si chiude, il primo embed della nuova finestra porta
   * una nota con il conteggio di quelli soppressi.
   */
  private shouldEmitEmbed(type: EventType): { emit: boolean; aggregateNote?: string } {
    const now = Date.now();
    const bucket = this.rateBuckets.get(type);

    if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
      const aggregateNote =
        bucket && bucket.suppressed > 0
          ? `_(+${bucket.suppressed} "${type}" events aggregated in the previous window)_`
          : undefined;
      this.rateBuckets.set(type, { windowStart: now, count: 1, suppressed: 0 });
      return { emit: true, aggregateNote };
    }

    bucket.count++;
    if (bucket.count <= RATE_LIMIT_THRESHOLD) return { emit: true };

    bucket.suppressed++;
    return { emit: false };
  }
}
