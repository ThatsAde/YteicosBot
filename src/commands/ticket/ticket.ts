import { GuildMember, MessageFlags, SlashCommandBuilder } from "discord.js";
import type { Command } from "../../types/index.js";
import { EmbedService } from "../../services/embed-service.js";
import { DomainError } from "../../domain/errors.js";

/**
 * Comandi di gestione ticket, usabili dentro il canale del ticket stesso
 * (il ticket viene risolto da interaction.channelId, mai passato a mano).
 * L'idoneita' staff e' gia' verificata da TicketService (assertStaff): qui
 * non serve ripeterla, solo intercettare il DomainError e mostrarlo.
 */
const ticket: Command = {
  data: new SlashCommandBuilder()
    .setName("ticket")
    .setDescription("Manage the ticket open in this channel (staff only)")
    .addSubcommand((sub) => sub.setName("prendi").setDescription("Claim this ticket"))
    .addSubcommand((sub) => sub.setName("risolvi").setDescription("Mark this ticket as resolved"))
    .addSubcommand((sub) =>
      sub
        .setName("chiudi")
        .setDescription("Close this ticket (generates a transcript, deletes the channel after a delay)")
        .addStringOption((option) => option.setName("motivo").setDescription("Reason for closing").setRequired(false)),
    )
    .addSubcommand((sub) => sub.setName("riapri").setDescription("Reopen this ticket"))
    .addSubcommand((sub) => sub.setName("elimina").setDescription("Delete the channel immediately, without waiting"))
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

    const ticketRecord = await interaction.client.services.prisma.ticket.findUnique({
      where: { channelId: interaction.channelId },
    });

    if (!ticketRecord) {
      await interaction.reply({
        ...EmbedService.error("This command must be used inside a ticket channel.").build(),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const subcommand = interaction.options.getSubcommand();
    const ticketService = interaction.client.services.ticket;

    try {
      switch (subcommand) {
        case "prendi":
          await ticketService.claim(ticketRecord.id, member);
          await interaction.editReply({ content: "Ticket claimed." });
          break;

        case "risolvi":
          await ticketService.resolve(ticketRecord.id, member);
          await interaction.editReply({ content: "Ticket marked as resolved." });
          break;

        case "chiudi": {
          const motivo = interaction.options.getString("motivo") ?? undefined;
          await ticketService.close(ticketRecord.id, member, motivo);
          await interaction.editReply({ content: "Ticket closed." });
          break;
        }

        case "riapri":
          await ticketService.reopen(ticketRecord.id, member);
          await interaction.editReply({ content: "Ticket reopened." });
          break;

        case "elimina":
          // Confirm first, then delete: remove() deletes the channel the
          // command was run from, so doing it in the opposite order risks
          // replying to an interaction whose channel no longer exists.
          await interaction.editReply({ content: "Ticket deleted." });
          await ticketService.remove(ticketRecord.id, member);
          break;
      }
    } catch (error) {
      const description = error instanceof DomainError ? error.message : "An unexpected error occurred.";
      await interaction.editReply(EmbedService.error(description).build());
    }
  },
};

export default ticket;
