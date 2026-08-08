import type { Collection, Guild, Invite } from "discord.js";

/**
 * Cache in-memory (per processo) degli usi di ogni invito per guild. L'API
 * Discord non dice mai direttamente "questo membro e' entrato con l'invito X":
 * va dedotto confrontando gli usi di ogni invito prima e dopo un join, quindi
 * serve uno snapshot da tenere aggiornato.
 *
 * La cache si perde a ogni restart: primeGuild() (chiamata da events/ready.ts)
 * la ricostruisce dallo stato reale via fetch, quindi non serve persistenza.
 */
export class InviteTracker {
  private readonly usesByGuild = new Map<string, Map<string, number>>();

  async primeGuild(guild: Guild): Promise<void> {
    const invites = await guild.invites.fetch();
    this.usesByGuild.set(guild.id, this.snapshot(invites));
  }

  /** Da chiamare su inviteCreate: aggiunge/aggiorna un invito senza rifare fetch di tutti. */
  trackInvite(invite: Invite): void {
    if (!invite.guild) return;
    const guildUses = this.usesByGuild.get(invite.guild.id) ?? new Map<string, number>();
    guildUses.set(invite.code, invite.uses ?? 0);
    this.usesByGuild.set(invite.guild.id, guildUses);
  }

  /** Da chiamare su inviteDelete: un invito scaduto/eliminato non va piu' confrontato. */
  forgetInvite(guildId: string, code: string): void {
    this.usesByGuild.get(guildId)?.delete(code);
  }

  /**
   * Da chiamare su guildMemberAdd: confronta lo snapshot precedente con lo
   * stato attuale e ritorna l'invito il cui contatore e' salito. Se nessuno e'
   * salito (link di invito monouso gia' consumato e sparito, vanity URL, invito
   * temporaneo scaduto nello stesso istante) ritorna undefined: il chiamante
   * deve trattarlo come "provenienza sconosciuta", non come errore.
   */
  async resolveUsedInvite(guild: Guild): Promise<Invite | undefined> {
    const before = this.usesByGuild.get(guild.id) ?? new Map<string, number>();
    const after = await guild.invites.fetch();

    const used = after.find((invite) => (invite.uses ?? 0) > (before.get(invite.code) ?? 0));
    this.usesByGuild.set(guild.id, this.snapshot(after));
    return used;
  }

  private snapshot(invites: Collection<string, Invite>): Map<string, number> {
    return new Map(invites.map((invite) => [invite.code, invite.uses ?? 0]));
  }
}
