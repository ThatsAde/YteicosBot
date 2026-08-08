import type {
  ButtonInteraction,
  Interaction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
  UserSelectMenuInteraction,
} from "discord.js";

/**
 * Router tipizzato per interazioni non-comando (bottoni, modal, select).
 * customId convenzione: "namespace:parte1:parte2:...", es. "ticket:open:verification".
 * Il namespace sono i primi due segmenti; il resto sono parametri passati
 * all'handler gia' splittati (es. l'id del ticket).
 */

type RouteHandler<I> = (interaction: I, params: readonly string[]) => Promise<void>;

interface Route<I> {
  readonly namespace: string;
  readonly handle: RouteHandler<I>;
}

function namespaceOf(customId: string): string {
  return customId.split(":").slice(0, 2).join(":");
}

export class InteractionRouter {
  private readonly buttonRoutes = new Map<string, Route<ButtonInteraction>>();
  private readonly modalRoutes = new Map<string, Route<ModalSubmitInteraction>>();
  private readonly selectRoutes = new Map<string, Route<StringSelectMenuInteraction>>();
  private readonly userSelectRoutes = new Map<string, Route<UserSelectMenuInteraction>>();

  registerButton(namespace: string, handle: RouteHandler<ButtonInteraction>): void {
    this.buttonRoutes.set(namespace, { namespace, handle });
  }

  registerModal(namespace: string, handle: RouteHandler<ModalSubmitInteraction>): void {
    this.modalRoutes.set(namespace, { namespace, handle });
  }

  registerSelect(namespace: string, handle: RouteHandler<StringSelectMenuInteraction>): void {
    this.selectRoutes.set(namespace, { namespace, handle });
  }

  registerUserSelect(namespace: string, handle: RouteHandler<UserSelectMenuInteraction>): void {
    this.userSelectRoutes.set(namespace, { namespace, handle });
  }

  /** Ritorna true se una route ha gestito l'interazione (utile per il log "nessuna route trovata"). */
  async dispatch(interaction: Interaction): Promise<boolean> {
    if (interaction.isButton()) return this.run(this.buttonRoutes, interaction);
    if (interaction.isModalSubmit()) return this.run(this.modalRoutes, interaction);
    if (interaction.isUserSelectMenu()) return this.run(this.userSelectRoutes, interaction);
    if (interaction.isStringSelectMenu()) return this.run(this.selectRoutes, interaction);
    return false;
  }

  private async run<I extends { customId: string }>(routes: Map<string, Route<I>>, interaction: I): Promise<boolean> {
    const namespace = namespaceOf(interaction.customId);
    const route = routes.get(namespace);
    if (!route) return false;

    const params = interaction.customId.split(":").slice(2);
    await route.handle(interaction, params);
    return true;
  }
}
