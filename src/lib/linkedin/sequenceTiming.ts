/**
 * Per-campaign timing of the LinkedIn sequence. Pure: no database, safe to import
 * from client components and from tests.
 *
 * Every delay counts from the previous step, exactly as the fixed 24 / 48 / 72
 * hour gaps always did. The defaults below ARE those gaps, so a campaign nobody
 * has configured behaves as it did before.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

export const SEQUENCE_DELAY_FIELDS = [
  "acceptanceDelayDays",
  "followUp1DelayDays",
  "followUp2DelayDays",
  "followUp3DelayDays",
  "followUp4DelayDays",
] as const;

export type SequenceDelayField = (typeof SEQUENCE_DELAY_FIELDS)[number];
export type SequenceDelays = Record<SequenceDelayField, number>;

/** Defaults mirror the database column defaults and the old 24 / 48 / 72 hour constants. */
export const DEFAULT_SEQUENCE_DELAYS: SequenceDelays = {
  acceptanceDelayDays: 0,
  followUp1DelayDays: 1,
  followUp2DelayDays: 2,
  followUp3DelayDays: 3,
  followUp4DelayDays: 4,
};

/** Bounds, mirrored by the "Campaign_sequence_delays_chk" CHECK constraint. */
export const SEQUENCE_DELAY_BOUNDS: Record<SequenceDelayField, { min: number; max: number }> = {
  acceptanceDelayDays: { min: 0, max: 30 },
  followUp1DelayDays: { min: 1, max: 60 },
  followUp2DelayDays: { min: 1, max: 60 },
  followUp3DelayDays: { min: 1, max: 60 },
  followUp4DelayDays: { min: 1, max: 60 },
};

export const SEQUENCE_DELAY_LABELS: Record<SequenceDelayField, string> = {
  acceptanceDelayDays: "Acceptance message delay",
  followUp1DelayDays: "Follow-up 1 delay",
  followUp2DelayDays: "Follow-up 2 delay",
  followUp3DelayDays: "Follow-up 3 delay",
  followUp4DelayDays: "Follow-up 4 delay",
};

export type SequenceDelayResult =
  | { ok: true; delays: Partial<SequenceDelays> }
  | { ok: false; error: string };

/**
 * Reads the delay fields present in `input` (a request body). Absent or null
 * fields are left out so callers can keep the stored / default value. A present
 * value must be a whole number inside its bounds.
 */
export function parseSequenceDelays(input: Record<string, unknown>): SequenceDelayResult {
  const delays: Partial<SequenceDelays> = {};
  for (const field of SEQUENCE_DELAY_FIELDS) {
    const raw = input[field];
    if (raw === undefined || raw === null || raw === "") continue;
    const { min, max } = SEQUENCE_DELAY_BOUNDS[field];
    const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      return { ok: false, error: `${SEQUENCE_DELAY_LABELS[field]} must be a whole number of days from ${min} to ${max}` };
    }
    delays[field] = value;
  }
  return { ok: true, delays };
}

/** Fills the gaps in a partial set of delays with the defaults. */
export function withDefaultDelays(delays: Partial<Record<SequenceDelayField, number | null | undefined>> | null | undefined): SequenceDelays {
  const result = { ...DEFAULT_SEQUENCE_DELAYS };
  for (const field of SEQUENCE_DELAY_FIELDS) {
    const value = delays?.[field];
    if (typeof value === "number") result[field] = value;
  }
  return result;
}

/**
 * True when `delayDays` whole days have passed since `since`. Mirrors the SQL
 * `since + delayDays * interval '1 day' <= now()` used by the sender (the
 * timestamps are `timestamp without time zone`, so a day is exactly 24 hours).
 */
export function isDelayElapsed(since: Date | null | undefined, delayDays: number, now: Date = new Date()): boolean {
  if (!since) return false;
  return since.getTime() + delayDays * DAY_MS <= now.getTime();
}

/** When the step is due, or null when its starting point is unknown. */
export function dueAt(since: Date | null | undefined, delayDays: number): Date | null {
  return since ? new Date(since.getTime() + delayDays * DAY_MS) : null;
}

/**
 * Should the acceptance message wait? True only for a campaign with an
 * acceptance delay whose accept was handled less than that long ago. A delay
 * of 0 (the default) never defers, whatever the dates are; an unknown accept
 * time does not defer either (nothing to wait from).
 */
export function shouldDeferAcceptance(acceptedAt: Date | null | undefined, delayDays: number, now: Date = new Date()): boolean {
  if (!(delayDays > 0)) return false;
  if (!acceptedAt) return false;
  return !isDelayElapsed(acceptedAt, delayDays, now);
}

export type AcceptanceDecision = "send" | "park" | "wait";

/**
 * What to do with an accepted connection's acceptance message.
 *  - "send": go ahead (no delay, or the delay is over).
 *  - "park": REQUEST_SENT and the campaign has a delay: this is the moment of the
 *    accept, so record it (acceptedAt = now, status CONNECTED) and send later.
 *  - "wait": already CONNECTED and the delay, counted from acceptedAt, is not over.
 * A CONNECTED lead with no acceptedAt is sent (it cannot wait for an unknown start).
 */
export function acceptanceDecision(
  lead: { status?: string | null; acceptedAt?: Date | null },
  delayDays: number,
  now: Date = new Date(),
): AcceptanceDecision {
  if (!(delayDays > 0)) return "send";
  if (lead.status === "CONNECTED") return shouldDeferAcceptance(lead.acceptedAt, delayDays, now) ? "wait" : "send";
  return "park";
}

/** "Immediately", "1 day later", "3 days later". */
export function delayLabel(days: number): string {
  return `${days} ${days === 1 ? "day" : "days"} later`;
}
