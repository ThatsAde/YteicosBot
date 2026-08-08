import { Events, GuildMember, MessageFlags } from "discord.js";
import type { Interaction, InteractionReplyOptions } from "discord.js";
import type { Event } from "../types/index.js";
import { logger } from "../utils/logger.js";
import { EmbedService } from "../services/embed-service.js";
import { DomainError } from "../domain/errors.js";

const interactionCreate: Event<Events.InteractionCreate> = {
  name: Events.InteractionCreate,

  async execute(interaction) {
    if (!interaction.isChatInputCommand()) {
      await dispatchComponentInteraction(interaction);
      return;
    }

    const command = interaction.client.commands.get(interaction.commandName);

    if (!command) {
      logger.warn(`Comando sconosciuto ricevuto: "${interaction.commandName}".`);
      await interaction.reply({
        ...EmbedService.error("This command does not exist (or has not been registered yet).").build(),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Guardia di autorizzazione, applicata qui una volta sola: i comandi
    // dichiarano solo i requisiti, senza ripetere il controllo.
    if (command.requiredState || command.requiredTier) {
      // L'identita' viene sempre dall'interazione, mai da un'opzione del comando.
      const member = interaction.member;

      if (!(member instanceof GuildMember)) {
        await interaction.reply({
          ...EmbedService.error("This command can only be used inside a server.").build(),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const auth = interaction.client.services.auth;
      const stateOk = !command.requiredState || auth.hasAtLeast(member, command.requiredState);
      const tierOk = !command.requiredTier || auth.hasTierAtLeast(member, command.requiredTier);

      if (!stateOk || !tierOk) {
        logger.debug(
          `Accesso negato a ${member.user.tag} per "${interaction.commandName}" ` +
            `(richiesti stato=${command.requiredState ?? "-"}, tier=${command.requiredTier ?? "-"}).`,
        );
        await interaction.reply({
          ...EmbedService.error("You do not have the required permissions to use this command.").build(),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    try {
      await command.execute(interaction);
    } catch (error) {
      logger.error(`Errore durante l'esecuzione del comando "${interaction.commandName}"`, error);

      const description = error instanceof DomainError ? error.message : "An error occurred while executing the command.";
      const errorReply: InteractionReplyOptions = {
        ...EmbedService.error(description).build(),
        flags: MessageFlags.Ephemeral,
      };

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(errorReply);
      } else {
        await interaction.reply(errorReply);
      }
    }
  },
};

async function dispatchComponentInteraction(interaction: Interaction): Promise<void> {
  if (
    !interaction.isButton() &&
    !interaction.isModalSubmit() &&
    !interaction.isStringSelectMenu() &&
    !interaction.isUserSelectMenu()
  ) {
    return;
  }

  try {
    const handled = await interaction.client.interactionRouter.dispatch(interaction);
    if (!handled) {
      logger.warn(`Nessuna route registrata per customId "${interaction.customId}".`);
    }
  } catch (error) {
    logger.error(`Errore durante la gestione dell'interazione "${interaction.customId}"`, error);

    const description = error instanceof DomainError ? error.message : "An unexpected error occurred.";
    const payload: InteractionReplyOptions = {
      ...EmbedService.error(description).build(),
      flags: MessageFlags.Ephemeral,
    };

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload).catch(() => undefined);
    } else {
      await interaction.reply(payload).catch(() => undefined);
    }
  }
}

export default interactionCreate;
