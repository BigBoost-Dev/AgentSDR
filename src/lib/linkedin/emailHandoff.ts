/**
 * The LinkedIn-to-email hand-off decision, pure: no database, so it is unit tested.
 * emailHandoff.server.ts reads the rows, calls these, and writes the outcome.
 *
 * Two kinds of hand-off, both set per LinkedIn campaign (null campaign id = off):
 *  - "if_not_accepted": the invitation was withdrawn (status WITHDRAWN), after a settle
 *    period that lets a racing accept arrive first; never when a Connection row exists.
 *  - "after_sequence": the sequence ended with no reply (status COMPLETED), once
 *    `emailAfterSequenceDelayDays` have passed since `completedAt`. A lead with no
 *    completedAt (completed before the migration) is never handed off.
 * A lead is decided exactly once (emailHandoffAt), whatever the result.
 */
import type { AssignmentResult } from "@/lib/leads/campaignAssignments";

export type HandoffKind = "if_not_accepted" | "after_sequence";

export type HandoffResult =
  | "enrolled"
  | "duplicate"
  | "suppressed"
  | "dnc"
  | "replied"
  | "active_elsewhere"
  | "no_email"
  | "stopped_by_accept";

/** Settle period after a withdrawal before the person is handed to email. */
export const WITHDRAW_SETTLE_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type HandoffLead = {
  status: string;
  emailHandoffAt: Date | null;
  inviteWithdrawnAt: Date | null;
  completedAt: Date | null;
  /** True when a Connection row exists for the lead (an accept is known). */
  hasConnection: boolean;
};

export type HandoffCampaignSettings = {
  status: string;
  emailCampaignIfNotAcceptedId: string | null;
  emailCampaignAfterSequenceId: string | null;
  emailAfterSequenceDelayDays: number;
};

export type HandoffDue = { kind: HandoffKind; emailCampaignId: string } | null;

/** Is this lead due for a hand-off right now, and to which email campaign? */
export function handoffDue(lead: HandoffLead, campaign: HandoffCampaignSettings, now: Date): HandoffDue {
  if (lead.emailHandoffAt) return null;
  if (campaign.status !== "ACTIVE") return null;

  if (lead.status === "WITHDRAWN") {
    if (!campaign.emailCampaignIfNotAcceptedId) return null;
    if (lead.hasConnection) return null;
    if (!lead.inviteWithdrawnAt) return null;
    if (now.getTime() - lead.inviteWithdrawnAt.getTime() < WITHDRAW_SETTLE_MS) return null;
    return { kind: "if_not_accepted", emailCampaignId: campaign.emailCampaignIfNotAcceptedId };
  }

  if (lead.status === "COMPLETED") {
    if (!campaign.emailCampaignAfterSequenceId) return null;
    if (!lead.completedAt) return null;
    if (now.getTime() - lead.completedAt.getTime() < campaign.emailAfterSequenceDelayDays * DAY_MS) return null;
    return { kind: "after_sequence", emailCampaignId: campaign.emailCampaignAfterSequenceId };
  }

  return null;
}

export type HandoffGuards = {
  doNotContact: boolean;
  /** Any LinkedIn lead of the person is REPLIED, or any email enrollment is reply_received. */
  replied: boolean;
  /** An active email enrollment in a campaign other than the target. */
  activeElsewhere: boolean;
  hasEmail: boolean;
};

/** The first guard that applies, in the fixed order dnc, replied, active_elsewhere, no_email; null = go ahead. */
export function handoffGuardResult(guards: HandoffGuards): Extract<HandoffResult, "dnc" | "replied" | "active_elsewhere" | "no_email"> | null {
  if (guards.doNotContact) return "dnc";
  if (guards.replied) return "replied";
  if (guards.activeElsewhere) return "active_elsewhere";
  if (!guards.hasEmail) return "no_email";
  return null;
}

/** Maps the enrollment helper's counts (for one person) to a hand-off result. */
export function enrollmentHandoffResult(result: AssignmentResult): Extract<HandoffResult, "enrolled" | "duplicate" | "suppressed" | "no_email"> {
  if (result.added > 0) return "enrolled";
  if (result.skippedDuplicate > 0) return "duplicate";
  if (result.skippedSuppressed > 0) return "suppressed";
  return "no_email";
}

/**
 * What an accept does to an earlier email hand-off, decided from the lead's FRESH row (read under
 * the person lock, never from a copy taken before a provider call). A lead that was decided
 * (`emailHandoffAt` set) is released: `emailHandoffAt` is cleared so the decision no longer blocks a
 * later hand-off (for example email B after the sequence), while the result and campaign id stay as
 * history. When the hand-off had enrolled the person (`enrolled`) in a known campaign, that
 * enrollment is also stopped and the result becomes `stopped_by_accept`: accept wins.
 */
export function acceptReleaseDecision(fresh: {
  emailHandoffAt?: Date | null;
  emailHandoffResult?: string | null;
  emailHandoffCampaignId?: string | null;
}): { release: boolean; stopCampaignId: string | null } {
  if (!fresh.emailHandoffAt) return { release: false, stopCampaignId: null };
  const stop = fresh.emailHandoffResult === "enrolled" && fresh.emailHandoffCampaignId ? fresh.emailHandoffCampaignId : null;
  return { release: true, stopCampaignId: stop };
}

/** Bounds for "add to the after-sequence email campaign after [n] days"; mirrored by "Campaign_email_after_delay_chk". */
export const EMAIL_AFTER_DELAY_BOUNDS = { min: 0, max: 60 } as const;
export const DEFAULT_EMAIL_AFTER_DELAY_DAYS = 3;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EmailHandoffSettingsInput =
  /** A field left out of the result was not mentioned (keep the stored value); null = off. */
  | { ok: true; emailCampaignIfNotAcceptedId?: string | null; emailCampaignAfterSequenceId?: string | null; emailAfterSequenceDelayDays?: number }
  | { ok: false; error: string };

/**
 * Reads the hand-off settings from a request body. The two campaign ids are null/"" (off) or a UUID
 * (the caller then checks the campaign exists in the organization); the delay is a whole number 0..60
 * and, like the other timing fields, an absent, null or empty value is left out.
 */
export function parseEmailHandoffSettings(input: Record<string, unknown>): EmailHandoffSettingsInput {
  const result: { emailCampaignIfNotAcceptedId?: string | null; emailCampaignAfterSequenceId?: string | null; emailAfterSequenceDelayDays?: number } = {};
  const labels = {
    emailCampaignIfNotAcceptedId: "The email campaign for withdrawn invitations",
    emailCampaignAfterSequenceId: "The email campaign for the end of the sequence",
  } as const;
  for (const field of ["emailCampaignIfNotAcceptedId", "emailCampaignAfterSequenceId"] as const) {
    const raw = input[field];
    if (raw === undefined) continue;
    if (raw === null || (typeof raw === "string" && raw.trim() === "")) {
      result[field] = null;
      continue;
    }
    if (typeof raw !== "string" || !UUID.test(raw.trim())) return { ok: false, error: `${labels[field]} must be empty or an email campaign id` };
    result[field] = raw.trim().toLowerCase();
  }
  const rawDelay = input.emailAfterSequenceDelayDays;
  if (rawDelay !== undefined && rawDelay !== null && rawDelay !== "") {
    const value = typeof rawDelay === "string" ? Number(rawDelay) : rawDelay;
    const { min, max } = EMAIL_AFTER_DELAY_BOUNDS;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      return { ok: false, error: `Days before the email campaign starts must be a whole number from ${min} to ${max}` };
    }
    result.emailAfterSequenceDelayDays = value;
  }
  return { ok: true, ...result };
}
