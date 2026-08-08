import { Events } from "discord.js";
import type { Event } from "../types/index.js";

/** Tiene la cache di InviteTracker aggiornata senza rifare fetch di tutti gli inviti a ogni join. */
const inviteCreate: Event<Events.InviteCreate> = {
  name: Events.InviteCreate,

  async execute(invite) {
    invite.client.services.inviteTracker.trackInvite(invite);
  },
};

export default inviteCreate;
