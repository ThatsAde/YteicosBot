import type { AuthState } from "../services/auth-state.js";
import type { TicketState, TicketType } from "./ticket-state.js";

/**
 * Errori di dominio: mai `throw new Error("stringa")` fuori da qui.
 * Ogni errore porta un `code` stabile (utile per i log strutturati e per
 * mappare l'errore a un messaggio utente in modo deterministico).
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class AlreadyVerifiedError extends DomainError {
  readonly code = "AUTH_ALREADY_VERIFIED";

  constructor(readonly userId: string) {
    super(`User ${userId} is already verified.`);
  }
}

export class SuspendedUserError extends DomainError {
  readonly code = "AUTH_SUSPENDED";

  constructor(readonly userId: string) {
    super(`User ${userId} is suspended and cannot perform this action.`);
  }
}

export class VerificationAlreadyPendingError extends DomainError {
  readonly code = "AUTH_VERIFICATION_PENDING";

  constructor(readonly userId: string) {
    super(`User ${userId} already has a pending verification.`);
  }
}

export class RoleHierarchyError extends DomainError {
  readonly code = "AUTH_ROLE_HIERARCHY";

  constructor(readonly userId: string, cause: unknown) {
    super(
      `Could not update roles for ${userId}: make sure the bot has the "Manage Roles" permission ` +
        `and that its role sits above the roles it manages in the server hierarchy.`,
      { cause },
    );
  }
}

export class MissingRoleConfigError extends DomainError {
  readonly code = "CONFIG_MISSING_ROLE";

  constructor(readonly state: AuthState | string) {
    super(`No Discord role configured for "${state}". Add the ID in .env.`);
  }
}

export class NotInGuildError extends DomainError {
  readonly code = "CONTEXT_NOT_IN_GUILD";

  constructor() {
    super("This command can only be used inside a server.");
  }
}

export class DiscordUserNotFoundError extends DomainError {
  readonly code = "DISCORD_USER_NOT_FOUND";

  constructor(readonly userId: string) {
    super(`User ${userId} is no longer a member of this server.`);
  }
}

export class TicketNotFoundError extends DomainError {
  readonly code = "TICKET_NOT_FOUND";

  constructor(readonly ticketId: string) {
    super(`Ticket "${ticketId}" not found.`);
  }
}

export class NotAVerificationTicketError extends DomainError {
  readonly code = "TICKET_NOT_VERIFICATION";

  constructor(readonly ticketId: string) {
    super("This is not a verification ticket: proof of purchase can only be attached there.");
  }
}

export class InvalidTicketTransitionError extends DomainError {
  readonly code = "TICKET_INVALID_TRANSITION";

  constructor(
    readonly from: TicketState,
    readonly to: TicketState,
    reason?: string,
  ) {
    super(`Invalid transition ${from} -> ${to}${reason ? ` (${reason})` : ""}.`);
  }
}

export class TicketLimitReachedError extends DomainError {
  readonly code = "TICKET_LIMIT_REACHED";

  constructor(
    readonly userId: string,
    readonly ticketType: TicketType,
    readonly limit: number,
  ) {
    super(`${userId} already has ${limit} open tickets of type ${ticketType}.`);
  }
}

export class TicketCooldownError extends DomainError {
  readonly code = "TICKET_COOLDOWN";

  constructor(
    readonly userId: string,
    readonly ticketType: TicketType,
    readonly cooldownMs: number,
  ) {
    super(`${userId} must wait before opening another ticket of type ${ticketType}.`);
  }
}

export class UnauthorizedTicketActionError extends DomainError {
  readonly code = "TICKET_UNAUTHORIZED";

  constructor(
    readonly userId: string,
    readonly ticketType: TicketType,
  ) {
    super(`${userId} does not meet the requirements to interact with a ticket of type ${ticketType}.`);
  }
}

export class InvalidButtonConfigError extends DomainError {
  readonly code = "EMBED_INVALID_BUTTON";

  constructor(reason: string) {
    super(`Invalid button configuration: ${reason}`);
  }
}

export class TooManyComponentRowsError extends DomainError {
  readonly code = "EMBED_TOO_MANY_ROWS";

  constructor() {
    super("Exceeded the limit of 5 component rows on a message.");
  }
}

export class TooManyButtonsError extends DomainError {
  readonly code = "EMBED_TOO_MANY_BUTTONS";

  constructor() {
    super("Exceeded the limit of 25 buttons (5x5) on a message.");
  }
}

export class TooManyFieldsError extends DomainError {
  readonly code = "EMBED_TOO_MANY_FIELDS";

  constructor(readonly limit: number) {
    super(`Exceeded the limit of ${limit} fields on an embed.`);
  }
}

export class InvalidSelectConfigError extends DomainError {
  readonly code = "EMBED_INVALID_SELECT";

  constructor(reason: string) {
    super(`Invalid select configuration: ${reason}`);
  }
}

/**
 * customId e valori delle opzioni non vengono troncati come le etichette: sono
 * dati di routing (vedi interactions/router.ts), accorciarli in silenzio
 * romperebbe l'handler invece di salvare il messaggio.
 */
export class CustomIdTooLongError extends DomainError {
  readonly code = "EMBED_CUSTOM_ID_TOO_LONG";

  constructor(readonly customId: string, readonly limit: number) {
    super(`customId "${customId}" exceeds the ${limit} characters allowed by Discord.`);
  }
}

export class EmptyModalError extends DomainError {
  readonly code = "EMBED_EMPTY_MODAL";

  constructor() {
    super("A modal must have at least one field.");
  }
}

export class EmbedTooLargeError extends DomainError {
  readonly code = "EMBED_TOO_LARGE";

  constructor(readonly length: number, readonly limit: number) {
    super(`Embed too long: ${length} total characters against a maximum of ${limit}.`);
  }
}

export class LogChannelUnavailableError extends DomainError {
  readonly code = "LOG_CHANNEL_UNAVAILABLE";

  constructor(readonly channelId: string) {
    super(`Log channel ${channelId} does not exist or is not a text channel.`);
  }
}
