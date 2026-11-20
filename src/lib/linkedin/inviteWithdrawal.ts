/**
 * Pure decisions for withdrawing unaccepted LinkedIn invitations: who is due, and how
 * to read the provider's answers. No database, no SDK, so it can be unit tested.
 */
import { errorHttpStatus, extractApiErrorDetail } from "./serializeError";
import { workingDaysElapsed, type WorkingHoursFields } from "./workingHours";

/** A lead is given up on after this many failed withdraw attempts. */
export const MAX_WITHDRAW_RETRIES = 3;

export type WithdrawalCandidate = {
  requestSentAt: Date | null;
  /** The campaign's setting; null = never withdraw. */
  withdrawAfterWorkingDays: number | null;
  withdrawRetryCount: number;
};

/**
 * Is this invitation due to be withdrawn? The send day is day 0; the invite is due once
 * `withdrawAfterWorkingDays` work days (in the account's time zone and days) have passed.
 */
export function isWithdrawalDue(candidate: WithdrawalCandidate, now: Date, hours: WorkingHoursFields): boolean {
  const after = candidate.withdrawAfterWorkingDays;
  if (after === null || !(after >= 1)) return false;
  if (!candidate.requestSentAt) return false;
  if (candidate.withdrawRetryCount >= MAX_WITHDRAW_RETRIES) return false;
  return workingDaysElapsed(candidate.requestSentAt, now, hours) >= after;
}

/** The due candidates in their given order (oldest first), at most `limit`. */
export function selectDueWithdrawals<T extends WithdrawalCandidate>(candidates: T[], now: Date, hours: WorkingHoursFields, limit: number): T[] {
  const due: T[] = [];
  for (const candidate of candidates) {
    if (due.length >= limit) break;
    if (isWithdrawalDue(candidate, now, hours)) due.push(candidate);
  }
  return due;
}

/**
 * Unipile answers 404 when an invitation id no longer exists (already withdrawn, accepted,
 * declined or expired). The SDK's UnsuccessfulRequestError carries the status on `.body.status`
 * (or `.response.status`); a `body.type` of "errors/resource_not_found" is accepted as well.
 */
export function isInvitationGoneError(err: unknown): boolean {
  if (errorHttpStatus(err) === 404) return true;
  const type = (err as { body?: { type?: unknown } } | null)?.body?.type;
  return typeof type === "string" && /not_found/i.test(type);
}

/** Limit / throttling answers: the account must stop for this run. */
export function isRateLimitError(err: unknown): boolean {
  if (errorHttpStatus(err) === 429) return true;
  const detail = extractApiErrorDetail((err as { body?: unknown } | null)?.body).toLowerCase();
  return detail.includes("limit") || detail.includes("quota") || detail.includes("too many") || detail.includes("weekly");
}

/**
 * Reads whether a raw Unipile LinkedIn profile is a first-degree connection:
 * `network_distance` ("FIRST_DEGREE", also seen as "DISTANCE_1") or `is_relationship`.
 * null = the profile says nothing about it.
 */
export function firstDegreeFromProfile(raw: unknown): boolean | null {
  if (!raw || typeof raw !== "object") return null;
  const profile = raw as { network_distance?: unknown; is_relationship?: unknown };
  if (typeof profile.network_distance === "string" && profile.network_distance.trim()) {
    const distance = profile.network_distance.trim().toUpperCase();
    return distance === "FIRST_DEGREE" || distance === "DISTANCE_1";
  }
  if (typeof profile.is_relationship === "boolean") return profile.is_relationship;
  return null;
}

/**
 * A failure that says nothing about the lead: HTTP 429, HTTP 5xx, or no HTTP status at all
 * (network error, timeout). The run stops and no retry is counted against the lead.
 * 4xx answers other than 429 are about this lead (404 is handled separately as "gone").
 */
export function isTransientError(err: unknown): boolean {
  const status = errorHttpStatus(err);
  return status === undefined || status === 429 || status >= 500;
}

/** Stop the account's run: transient trouble or a limit message. Never counted as the lead's fault. */
export function shouldStopRun(err: unknown): boolean {
  return isTransientError(err) || isRateLimitError(err);
}

export type WithdrawalPlan = "cancel_listed" | "check_profile" | "cancel_stored" | "reconcile";

/**
 * What to do for one due lead, given the account's pending-invitation list.
 *  - listed: cancel that invitation id.
 *  - not listed, list complete: the invite is no longer pending; check the profile (accepted, or gone by hand?).
 *  - not listed, list incomplete: fall back to the stored invitation id; with none, an operator must
 *    reconcile (never marked WITHDRAWN).
 */
export function planWithdrawal(input: { listed: boolean; listComplete: boolean; hasStoredId: boolean }): WithdrawalPlan {
  if (input.listed) return "cancel_listed";
  if (input.listComplete) return "check_profile";
  return input.hasStoredId ? "cancel_stored" : "reconcile";
}

/** An accept may enter the accept flow from WITHDRAWN only this long after the withdrawal (it covers the race). */
export const WITHDRAWN_ACCEPT_WINDOW_DAYS = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

export function isWithinWithdrawnAcceptWindow(inviteWithdrawnAt: Date | null | undefined, now: Date): boolean {
  if (!inviteWithdrawnAt) return false;
  return now.getTime() - inviteWithdrawnAt.getTime() <= WITHDRAWN_ACCEPT_WINDOW_DAYS * DAY_MS;
}
