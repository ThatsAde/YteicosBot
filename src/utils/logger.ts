import { config } from "../config/index.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const ANSI = {
  reset: "\x1b[0m",
  gray: "\x1b[90m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
} as const;

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: ANSI.gray,
  info: ANSI.cyan,
  warn: ANSI.yellow,
  error: ANSI.red,
};

function timestamp(): string {
  return new Date().toISOString();
}

/**
 * Rende leggibile qualsiasi valore passato come dettaglio di un log.
 * Sugli Error stampa lo stack, che e' l'unica parte davvero utile.
 */
function formatDetail(detail: unknown): string {
  if (detail === undefined || detail === null) return "";
  if (detail instanceof Error) return `\n${detail.stack ?? `${detail.name}: ${detail.message}`}`;
  if (typeof detail === "object") {
    try {
      return `\n${JSON.stringify(detail, null, 2)}`;
    } catch {
      return `\n${String(detail)}`;
    }
  }
  return ` ${String(detail)}`;
}

function write(level: LogLevel, scope: string | undefined, message: string, detail?: unknown): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[config.logLevel]) return;

  const prefix = `${ANSI.gray}[${timestamp()}]${ANSI.reset} ${LEVEL_COLOR[level]}[${level.toUpperCase()}]${ANSI.reset}`;
  const scopeTag = scope ? ` ${ANSI.gray}[${scope}]${ANSI.reset}` : "";
  const line = `${prefix}${scopeTag} ${message}${formatDetail(detail)}`;

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export interface Logger {
  debug(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
  /** Ritorna un logger che prefissa ogni riga con [name], es. logger.scope("auth"). */
  scope(name: string): Logger;
}

function createLogger(scopeName?: string): Logger {
  return {
    debug: (message, detail) => write("debug", scopeName, message, detail),
    info: (message, detail) => write("info", scopeName, message, detail),
    warn: (message, detail) => write("warn", scopeName, message, detail),
    error: (message, detail) => write("error", scopeName, message, detail),
    scope: (name) => createLogger(scopeName ? `${scopeName}:${name}` : name),
  };
}

export const logger = createLogger();
