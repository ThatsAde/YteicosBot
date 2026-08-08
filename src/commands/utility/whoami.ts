import { GuildMember, MessageFlags, SlashCommandBuilder } from "discord.js";
import type { Command } from "../../types/index.js";
import { EmbedService } from "../../services/embed-service.js";

const whoami: Command = {
  data: new SlashCommandBuilder()
    .setName("whoami")
    .setDescription("Shows your verification status and tier")
    .setDMPermission(false),

  async execute(interaction) {
    const member = interaction.member;

    if (!(member instanceof GuildMember)) {
      await interaction.reply({
        ...EmbedService.error("This command can only be used inside a server.").build(),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const auth = interaction.client.services.auth;
    const embed = EmbedService.info(
      `**Status:** \`${auth.getState(member)}\`\n**Tier:** \`${auth.getTier(member)}\``,
      "Your Profile",
    ).build();

    await interaction.reply({ ...embed, flags: MessageFlags.Ephemeral });
  },
};

export default whoami;
