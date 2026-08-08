import "dotenv/config";
import type { LogLevel } from "../utils/logger.js";

/** Categorie dei canali di log di dominio (vedi services/logger-service.ts). */
export enum LogCategory {
  Auth = "AUTH",
  Ticket = "TICKET",
  Moderation = "MODERATION",
  Purchase = "PURCHASE",
  System = "SYSTEM",
}

export interface RoleIds {
  pending: string;
  verified: string;
  suspended: string;
  customer: string;
  premium: string;
  staff: string;
  /** Ruolo base assegnato automaticamente a ogni nuovo membro (vedi events/guildMemberAdd.ts). */
  member: string;
}

export interface CategoryIds {
  verification: string;
  commissions: string;
  support: string;
  prioritySupport: string;
  moderation: string;
}

export interface ChannelIds {
  ticketPanel: string;
  /** Canale staff dove il bot pubblica (e mantiene aggiornato) il pannello di controllo. */
  staffDashboard: string;
  archive: string;
  /** Canali da elencare nel DM di benvenuto dopo la verifica. */
  unlockedOnVerification: readonly string[];
  logs: Record<LogCategory, string>;
  /** Canale dove events/guildMemberAdd.ts posta chi ha invitato ogni nuovo membro. */
  inviteLog: string;
}

export interface TicketSettings {
  maxOpenPerUserPerType: number;
  cooldownMs: number;
  autoCloseWarningMs: number;
  autoCloseInactivityMs: number;
  closeDeleteDelayMs: number;
}

export interface AppConfig {
  token: string;
  clientId: string;
  guildId?: string;
  logLevel: LogLevel;
  roles: RoleIds;
  categories: CategoryIds;
  channels: ChannelIds;
  tickets: TicketSettings;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable missing: ${name}. Check your .env (see .env.example).`);
  }
  return value;
}

function requireIntEnv(name: string, defaultValue?: number): number {
  const raw = process.env[name];
  if (!raw) {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`Environment variable missing: ${name}. Check your .env (see .env.example).`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable "${name}" non e' un intero valido: "${raw}".`);
  }
  return parsed;
}

function requireListEnv(name: string): readonly string[] {
  const raw = requireEnv(name);
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

const VALID_LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

function parseLogLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.toLowerCase();
  if (!raw) return "info";
  if (!VALID_LOG_LEVELS.includes(raw as LogLevel)) {
    throw new Error(`LOG_LEVEL non valido: "${raw}". Valori ammessi: ${VALID_LOG_LEVELS.join(", ")}.`);
  }
  return raw as LogLevel;
}

const MINUTES = 60_000;
const HOURS = 60 * MINUTES;

export const config: AppConfig = {
  token: requireEnv("DISCORD_TOKEN"),
  clientId: requireEnv("CLIENT_ID"),
  guildId: process.env.GUILD_ID || undefined,
  logLevel: parseLogLevel(),

  roles: {
    pending: requireEnv("ROLE_PENDING"),
    verified: requireEnv("ROLE_VERIFIED"),
    suspended: requireEnv("ROLE_SUSPENDED"),
    customer: requireEnv("ROLE_CUSTOMER"),
    premium: requireEnv("ROLE_PREMIUM"),
    staff: requireEnv("ROLE_STAFF"),
    member: requireEnv("ROLE_MEMBER"),
  },

  categories: {
    verification: requireEnv("CATEGORY_VERIFICATION"),
    commissions: requireEnv("CATEGORY_COMMISSIONS"),
    support: requireEnv("CATEGORY_SUPPORT"),
    prioritySupport: requireEnv("CATEGORY_PRIORITY_SUPPORT"),
    moderation: requireEnv("CATEGORY_MODERATION"),
  },

  channels: {
    ticketPanel: requireEnv("CHANNEL_TICKET_PANEL"),
    staffDashboard: requireEnv("CHANNEL_STAFF_DASHBOARD"),
    archive: requireEnv("CHANNEL_ARCHIVE"),
    unlockedOnVerification: requireListEnv("CHANNELS_UNLOCKED_ON_VERIFICATION"),
    inviteLog: requireEnv("CHANNEL_INVITE_LOG"),
    logs: {
      [LogCategory.Auth]: requireEnv("CHANNEL_LOG_AUTH"),
      [LogCategory.Ticket]: requireEnv("CHANNEL_LOG_TICKET"),
      [LogCategory.Moderation]: requireEnv("CHANNEL_LOG_MODERATION"),
      [LogCategory.Purchase]: requireEnv("CHANNEL_LOG_PURCHASE"),
      [LogCategory.System]: requireEnv("CHANNEL_LOG_SYSTEM"),
    },
  },

  tickets: {
    maxOpenPerUserPerType: requireIntEnv("TICKET_MAX_OPEN_PER_TYPE", 1),
    cooldownMs: requireIntEnv("TICKET_COOLDOWN_MINUTES", 5) * MINUTES,
    autoCloseWarningMs: requireIntEnv("TICKET_AUTOCLOSE_WARNING_HOURS", 24) * HOURS,
    autoCloseInactivityMs: requireIntEnv("TICKET_AUTOCLOSE_HOURS", 48) * HOURS,
    closeDeleteDelayMs: requireIntEnv("TICKET_CLOSE_DELETE_DELAY_MINUTES", 10) * MINUTES,
  },
};

// Prisma legge DATABASE_URL da process.env in autonomia: qui validiamo solo che
// esista, per fallire subito con un messaggio chiaro invece che dentro Prisma.
requireEnv("DATABASE_URL");
