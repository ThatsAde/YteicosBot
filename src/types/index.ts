import type {
  ChatInputCommandInteraction,
  ClientEvents,
  Collection,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import type { PrismaClient } from "@prisma/client";
import type { AuthState, Tier } from "../services/auth-state.js";
import type { AuthService } from "../services/auth-service.js";
import type { LoggerService } from "../services/logger-service.js";
import type { TicketService } from "../services/ticket-service.js";
import type { InviteTracker } from "../services/invite-tracker.js";
import type { InteractionRouter } from "../interactions/router.js";

/**
 * Istanze condivise, costruite una volta in index.ts e attaccate al Client.
 * Non sono singleton import-abili da ovunque: arrivano sempre esplicitamente
 * dall'interazione (interaction.client.services), coerente con l'iniezione
 * via costruttore usata dentro ai service stessi.
 */
export interface AppServices {
  prisma: PrismaClient;
  logger: LoggerService;
  auth: AuthService;
  ticket: TicketService;
  inviteTracker: InviteTracker;
}

export interface Command {
  data:
    | SlashCommandBuilder
    | SlashCommandOptionsOnlyBuilder
    | SlashCommandSubcommandsOnlyBuilder;
  /**
   * Stato minimo richiesto. Il controllo e' applicato una volta sola in
   * events/interactionCreate.ts, quindi qui basta dichiararlo.
   */
  requiredState?: AuthState;
  /** Tier minimo richiesto, verificato insieme a requiredState. */
  requiredTier?: Tier;
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
}

export interface Event<K extends keyof ClientEvents = keyof ClientEvents> {
  name: K;
  once?: boolean;
  execute(...args: ClientEvents[K]): Promise<void> | void;
}

declare module "discord.js" {
  interface Client {
    commands: Collection<string, Command>;
    services: AppServices;
    interactionRouter: InteractionRouter;
  }
}
