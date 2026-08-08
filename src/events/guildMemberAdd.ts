import { ChannelType, Events } from "discord.js";
import type { Event } from "../types/index.js";
import { config } from "../config/index.js";
import { Colors, EmbedService } from "../services/embed-service.js";
import { logger } from "../utils/logger.js";

/**
 * Al join di ogni nuovo membro (umano): assegna il ruolo base "member" e posta
 * nel canale invite-log chi lo ha invitato, ricavato confrontando gli usi
 * degli inviti prima/dopo (InviteTracker, l'unico modo: l'evento non porta
 * questa informazione). I bot che entrano non passano da qui: non hanno bisogno
 * del ruolo base e non sono mai arrivati tramite un invito "umano" da tracciare.
 */
const guildMemberAdd: Event<Events.GuildMemberAdd> = {
  name: Events.GuildMemberAdd,

  async execute(member) {
    if (member.user.bot) return;

    const scoped = logger.scope("invites");

    await member.roles.add(config.roles.member, "Auto-role al join").catch((error) => {
      scoped.error(`Impossibile assegnare il ruolo base a ${member.user.tag}`, error);
    });

    const usedInvite = await member.client.services.inviteTracker.resolveUsedInvite(member.guild).catch((error) => {
      scoped.error(`Impossibile risolvere l'invito usato da ${member.user.tag}`, error);
      return undefined;
    });

    const embed = EmbedService.basic()
      .color(Colors.Info)
      .title("Member Joined")
      .description(`<@${member.id}> joined the server.`)
      .field("Invited by", usedInvite?.inviter ? `<@${usedInvite.inviter.id}>` : "Unknown", true)
      .field("Invite code", usedInvite ? `\`${usedInvite.code}\`` : "-", true)
      .field("Total uses", usedInvite ? `${usedInvite.uses ?? 0}` : "-", true)
      .field("Account created", `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, true)
      .field("Member count", `${member.guild.memberCount}`, true)
      .timestamp()
      .build();

    const channel = await member.client.channels.fetch(config.channels.inviteLog).catch(() => null);
    if (channel?.type === ChannelType.GuildText) {
      await channel.send(embed).catch((error) => scoped.error("Impossibile postare nel canale invite-log", error));
    } else {
      scoped.error(`Canale invite-log ${config.channels.inviteLog} non esiste o non e' testuale.`);
    }
  },
};

export default guildMemberAdd;
