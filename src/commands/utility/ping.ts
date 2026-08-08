import { SlashCommandBuilder } from "discord.js";
import type { Command } from "../../types/index.js";

const ping: Command = {
  data: new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Replies with Pong and the bot's latency"),

  async execute(interaction) {
    await interaction.reply("Pong! Calculating latency...");
    const sent = await interaction.fetchReply();
    const latency = sent.createdTimestamp - interaction.createdTimestamp;

    await interaction.editReply(
      `Pong! Message latency: ${latency}ms | WebSocket latency: ${interaction.client.ws.ping}ms`,
    );
  },
};

export default ping;
