import { InvalidTicketTransitionError } from "./errors.js";

export enum TicketType {
  Verification = "VERIFICATION",
  Commission = "COMMISSION",
  Support = "SUPPORT",
  PrioritySupport = "PRIORITY_SUPPORT",
  Report = "REPORT",
}

export enum TicketState {
  Open = "OPEN",
  Claimed = "CLAIMED",
  AwaitingUser = "AWAITING_USER",
  AwaitingStaff = "AWAITING_STAFF",
  Resolved = "RESOLVED",
  Closed = "CLOSED",
  Archived = "ARCHIVED",
  Rejected = "REJECTED",
}

/**
 * Open -> Claimed -> (AwaitingUser <-> AwaitingStaff) -> Resolved -> Closed -> Archived
 * Rejected e' un ramo laterale, raggiungibile solo da ticket VERIFICATION prima
 * della risoluzione (controllato a parte in assertTransition, non qui: questa
 * mappa e' agnostica al tipo perche' la state machine "di forma" e' la stessa
 * per tutti i ticket).
 * Closed/Resolved possono tornare ad AwaitingStaff: e' la riapertura (ticket.reopened).
 */
const TRANSITIONS: Record<TicketState, ReadonlySet<TicketState>> = {
  [TicketState.Open]: new Set([TicketState.Claimed, TicketState.Rejected]),
  [TicketState.Claimed]: new Set([
    TicketState.AwaitingUser,
    TicketState.AwaitingStaff,
    TicketState.Resolved,
    TicketState.Rejected,
  ]),
  [TicketState.AwaitingUser]: new Set([TicketState.AwaitingStaff, TicketState.Resolved, TicketState.Rejected]),
  [TicketState.AwaitingStaff]: new Set([TicketState.AwaitingUser, TicketState.Resolved, TicketState.Rejected]),
  [TicketState.Resolved]: new Set([TicketState.Closed, TicketState.AwaitingStaff]),
  [TicketState.Closed]: new Set([TicketState.Archived, TicketState.AwaitingStaff]),
  [TicketState.Archived]: new Set([]),
  [TicketState.Rejected]: new Set([TicketState.Archived]),
};

/** Stati che, se raggiunti, chiudono il ciclo di vita "attivo" del ticket. */
export const TERMINAL_STATES: ReadonlySet<TicketState> = new Set([
  TicketState.Closed,
  TicketState.Archived,
  TicketState.Rejected,
]);

export function canTransition(from: TicketState, to: TicketState, type: TicketType): boolean {
  if (to === TicketState.Rejected && type !== TicketType.Verification) return false;
  return TRANSITIONS[from].has(to);
}

export function assertTransition(from: TicketState, to: TicketState, type: TicketType): void {
  if (!canTransition(from, to, type)) {
    const reason = to === TicketState.Rejected && type !== TicketType.Verification
      ? `${type} does not support the Rejected state`
      : undefined;
    throw new InvalidTicketTransitionError(from, to, reason);
  }
}

const CHANNEL_PREFIX: Record<TicketType, string> = {
  [TicketType.Verification]: "verify",
  [TicketType.Commission]: "commission",
  [TicketType.Support]: "support",
  [TicketType.PrioritySupport]: "priority",
  [TicketType.Report]: "report",
};

export function buildTicketChannelName(type: TicketType, number: number): string {
  return `${CHANNEL_PREFIX[type]}-${String(number).padStart(4, "0")}`;
}
