import { ChannelType, GuildMember, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import type { Command } from "../../types/index.js";
import { EmbedService } from "../../services/embed-service.js";
import { buildTicketOpenPanel } from "../../interactions/panels.js";

/** Comando staff: posta il pannello con i bottoni di apertura ticket nel canale corrente. */
const pannelloTicket: Command = {
  data: new SlashCommandBuilder()
    .setName("pannello-ticket")
    .setDescription("Post the ticket-opening panel in this channel (staff only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),

  async execute(interaction) {
    const member = interaction.member;
    if (!(member instanceof GuildMember) || interaction.channel?.type !== ChannelType.GuildText) {
      await interaction.reply(
        EmbedService.error("This command can only be used in a server text channel.").buildEphemeral(),
      );
      return;
    }

    // Stessa definizione usata dall'avvio e dalla dashboard (interactions/panels.ts):
    // il pannello esiste in un posto solo, questo comando lo pubblica altrove.
    await interaction.channel.send(buildTicketOpenPanel());
    await interaction.reply({ content: "Panel published.", flags: MessageFlags.Ephemeral });
  },
};

export default pannelloTicket;
