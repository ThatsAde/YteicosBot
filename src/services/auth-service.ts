import type { GuildMember } from "discord.js";
import { AuthState as PrismaAuthState, Tier as PrismaTier, type PrismaClient } from "@prisma/client";
import type { AppConfig, RoleIds } from "../config/index.js";
import { AlreadyVerifiedError, RoleHierarchyError, SuspendedUserError } from "../domain/errors.js";
import { EmbedService } from "./embed-service.js";
import type { LoggerService } from "./logger-service.js";
import { AuthState, Tier, stateRank, tierRank } from "./auth-state.js";

/**
 * Auth service — i RUOLI DISCORD sono la fonte di verita' per le decisioni
 * di autorizzazione (getState/getTier/hasAtLeast/hasTierAtLeast leggono SOLO
 * i ruoli del member). Il DB (tabella User) e' una copia per audit/query,
 * scritta in parallelo ma mai consultata per decidere un accesso.
 *
 * Nessun'altra parte del bot scrive ruoli di verifica: TicketService chiama
 * sempre begin/complete/reject/suspend, mai member.roles.add/remove.
 */

const STATE_ROLE_KEY: Record<Exclude<AuthState, AuthState.Guest>, keyof RoleIds> = {
  [AuthState.Pending]: "pending",
  [AuthState.Verified]: "verified",
  [AuthState.Suspended]: "suspended",
};

const STATE_ROLES_BY_PRIORITY: readonly AuthState[] = [AuthState.Suspended, AuthState.Verified, AuthState.Pending];

const TIER_ROLE_KEY: Record<Exclude<Tier, Tier.None>, keyof RoleIds> = {
  [Tier.Customer]: "customer",
  [Tier.Premium]: "premium",
};

const TIER_ROLES_BY_PRIORITY: readonly Tier[] = [Tier.Premium, Tier.Customer];

const STATE_TO_PRISMA: Record<AuthState, PrismaAuthState> = {
  [AuthState.Guest]: PrismaAuthState.GUEST,
  [AuthState.Pending]: PrismaAuthState.PENDING,
  [AuthState.Verified]: PrismaAuthState.VERIFIED,
  [AuthState.Suspended]: PrismaAuthState.SUSPENDED,
};

const TIER_TO_PRISMA: Record<Tier, PrismaTier> = {
  [Tier.None]: PrismaTier.NONE,
  [Tier.Customer]: PrismaTier.CUSTOMER,
  [Tier.Premium]: PrismaTier.PREMIUM,
};

export class AuthService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: LoggerService,
    private readonly config: AppConfig,
  ) {}

  /** Suspended vince su tutto: se presente, e' quello lo stato effettivo. */
  getState(member: GuildMember): AuthState {
    for (const state of STATE_ROLES_BY_PRIORITY) {
      const roleId = this.config.roles[STATE_ROLE_KEY[state as Exclude<AuthState, AuthState.Guest>]];
      if (member.roles.cache.has(roleId)) return state;
    }
    return AuthState.Guest;
  }

  getTier(member: GuildMember): Tier {
    for (const tier of TIER_ROLES_BY_PRIORITY) {
      const roleId = this.config.roles[TIER_ROLE_KEY[tier as Exclude<Tier, Tier.None>]];
      if (member.roles.cache.has(roleId)) return tier;
    }
    return Tier.None;
  }

  hasAtLeast(member: GuildMember, minimum: AuthState): boolean {
    const current = this.getState(member);
    if (current === AuthState.Suspended) return false;
    if (minimum === AuthState.Suspended) return false;
    return stateRank(current) >= stateRank(minimum);
  }

  hasTierAtLeast(member: GuildMember, minimum: Tier): boolean {
    if (this.getState(member) === AuthState.Suspended) return false;
    return tierRank(this.getTier(member)) >= tierRank(minimum);
  }

  /** Apertura di un ticket VERIFICATION: Guest -> Pending. */
  async begin(member: GuildMember, ticketId: string): Promise<void> {
    const current = this.getState(member);
    if (current === AuthState.Verified) throw new AlreadyVerifiedError(member.id);
    if (current === AuthState.Suspended) throw new SuspendedUserError(member.id);

    await this.applyState(member, AuthState.Pending);
    await this.persistUser(member.id, { authState: AuthState.Pending });
    await this.logger.log({ type: "auth.begin", userId: member.id, ticketId });
  }

  /**
   * Approvazione staff: Pending -> Verified + tier. Ritorna se il DM di
   * benvenuto e' partito, cosi' il chiamante (TicketService) puo' fare
   * fallback nel canale del ticket se i DM dell'utente sono chiusi.
   */
  async complete(member: GuildMember, tier: Tier, ticketId?: string): Promise<{ dmSent: boolean }> {
    await this.applyState(member, AuthState.Verified);
    if (tier !== Tier.None) await this.applyTier(member, tier);

    await this.persistUser(member.id, { authState: AuthState.Verified, tier, verifiedAt: new Date() });
    await this.logger.log({ type: "auth.complete", userId: member.id, tier, ticketId });

    const dmSent = await this.sendWelcomeDm(member);
    return { dmSent };
  }

  /** Rifiuto staff: torna a Guest, motivo obbligatorio. */
  async reject(member: GuildMember, reason: string, ticketId?: string): Promise<void> {
    await this.applyState(member, AuthState.Guest);
    await this.persistUser(member.id, { authState: AuthState.Guest });
    await this.logger.log({ type: "auth.reject", userId: member.id, reason, ticketId });

    const embed = EmbedService.error(
      `Your verification request on **Yteicos** has been rejected.\n**Reason:** ${reason}\n\nYou can open a new verification ticket whenever you like.`,
      "Verification Rejected",
    ).build();
    await member.send(embed).catch(() => undefined);
  }

  async suspend(member: GuildMember, reason: string): Promise<void> {
    await this.applyState(member, AuthState.Suspended);
    await this.persistUser(member.id, { authState: AuthState.Suspended, suspendedAt: new Date() });
    await this.logger.log({ type: "auth.suspend", userId: member.id, reason });
  }

  /**
   * Revoca della sospensione: riporta a Guest, non a Verified. Riverificare e'
   * una decisione separata dello staff, quindi togliere la sanzione non deve
   * ridare implicitamente un accesso che l'utente magari non aveva mai avuto.
   * Il tier NON viene toccato: e' un asse indipendente (vedi auth-state.ts).
   */
  async unsuspend(member: GuildMember): Promise<void> {
    if (this.getState(member) !== AuthState.Suspended) return;

    await this.applyState(member, AuthState.Guest);
    await this.persistUser(member.id, { authState: AuthState.Guest, suspendedAt: null });
    await this.logger.log({ type: "auth.unsuspend", userId: member.id });
  }

  async setTier(member: GuildMember, tier: Tier): Promise<void> {
    const previous = this.getTier(member);
    if (previous === tier) return;

    await this.applyTier(member, tier);
    await this.persistUser(member.id, { tier });
    await this.logger.log({ type: "auth.tier_changed", userId: member.id, from: previous, to: tier });
  }

  private async applyState(member: GuildMember, next: AuthState): Promise<void> {
    const previous = this.getState(member);
    if (previous === next) return;

    const toRemove = STATE_ROLES_BY_PRIORITY.map(
      (state) => this.config.roles[STATE_ROLE_KEY[state as Exclude<AuthState, AuthState.Guest>]],
    ).filter((roleId) => member.roles.cache.has(roleId));

    try {
      if (toRemove.length > 0) await member.roles.remove(toRemove, `auth: ${previous} -> ${next}`);
      if (next !== AuthState.Guest) {
        const roleId = this.config.roles[STATE_ROLE_KEY[next as Exclude<AuthState, AuthState.Guest>]];
        await member.roles.add(roleId, `auth: ${previous} -> ${next}`);
      }
    } catch (error) {
      throw new RoleHierarchyError(member.id, error);
    }
  }

  private async applyTier(member: GuildMember, next: Tier): Promise<void> {
    const previous = this.getTier(member);
    if (previous === next) return;

    const toRemove = TIER_ROLES_BY_PRIORITY.map(
      (tier) => this.config.roles[TIER_ROLE_KEY[tier as Exclude<Tier, Tier.None>]],
    ).filter((roleId) => member.roles.cache.has(roleId));

    try {
      if (toRemove.length > 0) await member.roles.remove(toRemove, `auth: tier ${previous} -> ${next}`);
      if (next !== Tier.None) {
        const roleId = this.config.roles[TIER_ROLE_KEY[next as Exclude<Tier, Tier.None>]];
        await member.roles.add(roleId, `auth: tier ${previous} -> ${next}`);
      }
    } catch (error) {
      throw new RoleHierarchyError(member.id, error);
    }
  }

  private async persistUser(
    discordId: string,
    data: { authState?: AuthState; tier?: Tier; verifiedAt?: Date | null; suspendedAt?: Date | null },
  ): Promise<void> {
    await this.prisma.user.upsert({
      where: { discordId },
      create: {
        discordId,
        authState: data.authState ? STATE_TO_PRISMA[data.authState] : undefined,
        tier: data.tier ? TIER_TO_PRISMA[data.tier] : undefined,
        verifiedAt: data.verifiedAt,
        suspendedAt: data.suspendedAt,
      },
      update: {
        authState: data.authState ? STATE_TO_PRISMA[data.authState] : undefined,
        tier: data.tier ? TIER_TO_PRISMA[data.tier] : undefined,
        verifiedAt: data.verifiedAt,
        suspendedAt: data.suspendedAt,
      },
    });
  }

  private async sendWelcomeDm(member: GuildMember): Promise<boolean> {
    const channelList = this.config.channels.unlockedOnVerification.map((id) => `<#${id}>`).join("\n");
    const embed = EmbedService.success(
      `You have been verified on **Yteicos**! You now have access to:\n${channelList}`,
      "Welcome!",
    ).build();

    return member
      .send(embed)
      .then(() => true)
      .catch(() => false);
  }
}
