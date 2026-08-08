/**
 * Stati di autorizzazione, separati su due assi indipendenti.
 *
 * Tenerli distinti evita che sospendere un utente ne cancelli il tier
 * acquistato: sono informazioni ortogonali, non alternative.
 *
 * Enum di stringhe e non numerici: i valori restano stabili anche
 * inserendo un nuovo stato in mezzo alla lista, e i log sono leggibili.
 */

/** Ciclo di vita della verifica dell'utente. */
export enum AuthState {
  Guest = "guest",
  Pending = "pending",
  Verified = "verified",
  Suspended = "suspended",
}

/** Livello di accesso derivante dagli acquisti. */
export enum Tier {
  None = "none",
  Customer = "customer",
  Premium = "premium",
}

/**
 * Scala di progressione degli stati.
 * Suspended NON compare: e' uno stato bloccante fuori scala, gestito a parte
 * da hasAtLeast() perche' deve negare l'accesso a qualunque soglia.
 */
const STATE_RANK: Record<Exclude<AuthState, AuthState.Suspended>, number> = {
  [AuthState.Guest]: 0,
  [AuthState.Pending]: 1,
  [AuthState.Verified]: 2,
};

const TIER_RANK: Record<Tier, number> = {
  [Tier.None]: 0,
  [Tier.Customer]: 1,
  [Tier.Premium]: 2,
};

export function stateRank(state: AuthState): number {
  if (state === AuthState.Suspended) return -1;
  return STATE_RANK[state];
}

export function tierRank(tier: Tier): number {
  return TIER_RANK[tier];
}

/**
 * I valori che arrivano dai componenti Discord sono stringhe arbitrarie: vanno
 * validate, non castate. Ritorna undefined se la stringa non e' un tier noto.
 */
const TIER_BY_VALUE: Record<string, Tier | undefined> = {
  [Tier.None]: Tier.None,
  [Tier.Customer]: Tier.Customer,
  [Tier.Premium]: Tier.Premium,
};

export function parseTier(raw: string | undefined): Tier | undefined {
  return raw === undefined ? undefined : TIER_BY_VALUE[raw];
}
