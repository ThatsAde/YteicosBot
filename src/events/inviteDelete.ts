import { Events } from "discord.js";
import type { Event } from "../types/index.js";

/** Un invito eliminato/scaduto non va piu' confrontato in resolveUsedInvite. */
const inviteDelete: Event<Events.InviteDelete> = {
  name: Events.InviteDelete,

  async execute(invite) {
    if (!invite.guild) return;
    invite.client.services.inviteTracker.forgetInvite(invite.guild.id, invite.code);
  },
};

export default inviteDelete;
