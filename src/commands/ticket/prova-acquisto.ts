import { GuildMember, MessageFlags, SlashCommandBuilder } from "discord.js";
import type { Command } from "../../types/index.js";
import { EmbedService } from "../../services/embed-service.js";
import { DomainError } from "../../domain/errors.js";

// Le modal non accettano allegati: la prova d'acquisto passa da qui invece
// che da un listener sui messaggi, cosi' non serve l'intent privilegiato
// MessageContent (vedi client.ts).
const provaAcquisto: Command = {
  data: new SlashCommandBuilder()
    .setName("prova-acquisto")
    .setDescription("Attach proof of purchase to your verification ticket")
    .addAttachmentOption((option) => option.setName("prova1").setDescription("Screenshot or receipt").setRequired(true))
    .addAttachmentOption((option) => option.setName("prova2").setDescription("Additional attachment (optional)").setRequired(false))
    .addAttachmentOption((option) => option.setName("prova3").setDescription("Additional attachment (optional)").setRequired(false))
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

    const ticket = await interaction.client.services.prisma.ticket.findUnique({
      where: { channelId: interaction.channelId },
    });

    if (!ticket) {
      await interaction.reply({
        ...EmbedService.error("This command must be used inside your verification ticket channel.").build(),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const attachments = ["prova1", "prova2", "prova3"]
      .map((name) => interaction.options.getAttachment(name))
      .filter((attachment): attachment is NonNullable<typeof attachment> => attachment !== null)
      .map((attachment) => attachment.url);

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      await interaction.client.services.ticket.submitProof(ticket.id, member, attachments);
      await interaction.editReply({ content: "Proof of purchase submitted." });
    } catch (error) {
      const description = error instanceof DomainError ? error.message : "An unexpected error occurred.";
      await interaction.editReply(EmbedService.error(description).build());
    }
  },
};

export default provaAcquisto;
