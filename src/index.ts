import { PrismaClient } from "@prisma/client";
import { client } from "./client.js";
import { config } from "./config/index.js";
import { loadCommands } from "./handlers/loadCommands.js";
import { loadEvents } from "./handlers/loadEvents.js";
import { logger } from "./utils/logger.js";
import { LoggerService } from "./services/logger-service.js";
import { AuthService } from "./services/auth-service.js";
import { TicketService } from "./services/ticket-service.js";
import { InviteTracker } from "./services/invite-tracker.js";
import { InteractionRouter } from "./interactions/router.js";
import { registerTicketHandlers } from "./interactions/ticket-handlers.js";
import { registerDashboardHandlers } from "./interactions/dashboard-handlers.js";

const INACTIVITY_CHECK_INTERVAL_MS = 15 * 60_000;

async function main(): Promise<void> {
  const prisma = new PrismaClient();

  // Ogni service riceve le sue dipendenze via costruttore: nessun singleton
  // importato altrove, tutto arriva esplicitamente da qui.
  const loggerService = new LoggerService(prisma, client, config);
  const authService = new AuthService(prisma, loggerService, config);
  const ticketService = new TicketService(prisma, client, config, loggerService, authService);
  const inviteTracker = new InviteTracker();

  client.services = { prisma, logger: loggerService, auth: authService, ticket: ticketService, inviteTracker };

  client.interactionRouter = new InteractionRouter();
  registerTicketHandlers(client.interactionRouter);
  registerDashboardHandlers(client.interactionRouter, config);

  await loadCommands(client);
  await loadEvents(client);

  setInterval(() => {
    void ticketService.checkInactiveTickets().catch((error: unknown) => {
      logger.error("Controllo ticket inattivi fallito", error);
    });
  }, INACTIVITY_CHECK_INTERVAL_MS).unref();

  await client.login(config.token);
}

process.on("unhandledRejection", (error) => {
  logger.error("Unhandled promise rejection", error);
});

process.on("SIGINT", () => {
  logger.info("Arresto in corso (SIGINT)...");
  client.destroy();
  process.exit(0);
});

main().catch((error) => {
  logger.error("Avvio del bot fallito", error);
  process.exit(1);
});
