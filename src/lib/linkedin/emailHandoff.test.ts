import { describe, expect, test } from "bun:test";
import {
  WITHDRAW_SETTLE_MS,
  enrollmentHandoffResult,
  handoffDue,
  handoffGuardResult,
  parseEmailHandoffSettings,
  acceptReleaseDecision,
  type HandoffCampaignSettings,
  type HandoffLead,
} from "./emailHandoff";

const NOW = new Date("2026-11-20T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CAMPAIGN_A = "11111111-1111-4111-8111-111111111111";
const CAMPAIGN_B = "22222222-2222-4222-8222-222222222222";

const campaign = (over: Partial<HandoffCampaignSettings> = {}): HandoffCampaignSettings => ({
  status: "ACTIVE",
  emailCampaignIfNotAcceptedId: CAMPAIGN_A,
  emailCampaignAfterSequenceId: CAMPAIGN_B,
  emailAfterSequenceDelayDays: 4,
  ...over,
});
const lead = (over: Partial<HandoffLead> = {}): HandoffLead => ({
  status: "WITHDRAWN",
  emailHandoffAt: null,
  inviteWithdrawnAt: ago(2 * HOUR),
  completedAt: null,
  hasConnection: false,
  ...over,
});

describe("handoffDue: withdrawn invitations (campaign A)", () => {
  test("is due after the settle period, to the if-not-accepted campaign", () => {
    expect(handoffDue(lead(), campaign(), NOW)).toEqual({ kind: "if_not_accepted", emailCampaignId: CAMPAIGN_A });
    expect(handoffDue(lead({ inviteWithdrawnAt: ago(WITHDRAW_SETTLE_MS) }), campaign(), NOW)).not.toBeNull();
  });

  test("not inside the 1-hour settle period", () => {
    expect(handoffDue(lead({ inviteWithdrawnAt: ago(WITHDRAW_SETTLE_MS - 1) }), campaign(), NOW)).toBeNull();
  });

  test("not when a Connection row exists, there is no withdrawal time, or the campaign has no email campaign for it", () => {
    expect(handoffDue(lead({ hasConnection: true }), campaign(), NOW)).toBeNull();
    expect(handoffDue(lead({ inviteWithdrawnAt: null }), campaign(), NOW)).toBeNull();
    expect(handoffDue(lead(), campaign({ emailCampaignIfNotAcceptedId: null }), NOW)).toBeNull();
  });
});

describe("handoffDue: sequence completed (campaign B)", () => {
  const done = (over: Partial<HandoffLead> = {}) => lead({ status: "COMPLETED", inviteWithdrawnAt: null, completedAt: ago(5 * DAY), ...over });

  test("is due once the delay since completedAt has passed, to the after-sequence campaign", () => {
    expect(handoffDue(done(), campaign(), NOW)).toEqual({ kind: "after_sequence", emailCampaignId: CAMPAIGN_B });
    expect(handoffDue(done({ completedAt: ago(4 * DAY) }), campaign(), NOW)).not.toBeNull();
  });

  test("not before the delay, and a delay of 0 is due at once", () => {
    expect(handoffDue(done({ completedAt: ago(4 * DAY - 1) }), campaign(), NOW)).toBeNull();
    expect(handoffDue(done({ completedAt: ago(0) }), campaign({ emailAfterSequenceDelayDays: 0 }), NOW)).not.toBeNull();
  });

  test("a lead with no completedAt (completed before the migration) is never handed off", () => {
    expect(handoffDue(done({ completedAt: null }), campaign({ emailAfterSequenceDelayDays: 0 }), NOW)).toBeNull();
  });

  test("not without an after-sequence email campaign", () => {
    expect(handoffDue(done(), campaign({ emailCampaignAfterSequenceId: null }), NOW)).toBeNull();
  });
});

describe("handoffDue: everything else", () => {
  test("a lead already decided is never due again", () => {
    expect(handoffDue(lead({ emailHandoffAt: ago(HOUR) }), campaign(), NOW)).toBeNull();
    expect(handoffDue(lead({ status: "COMPLETED", completedAt: ago(9 * DAY), emailHandoffAt: ago(HOUR) }), campaign(), NOW)).toBeNull();
  });

  test("a paused LinkedIn campaign hands nothing off", () => {
    expect(handoffDue(lead(), campaign({ status: "PAUSED" }), NOW)).toBeNull();
  });

  test("other statuses are never due", () => {
    for (const status of ["PENDING", "REQUEST_SENT", "CONNECTED", "ACCEPT_MESSAGE_SENT", "FOLLOW_UP_1_SENT", "REPLIED", "FAILED", "CANCELLED"]) {
      expect(handoffDue(lead({ status, completedAt: ago(9 * DAY) }), campaign(), NOW)).toBeNull();
    }
  });
});

describe("handoffGuardResult", () => {
  const clear = { doNotContact: false, replied: false, activeElsewhere: false, hasEmail: true };

  test("nothing applies: go ahead", () => {
    expect(handoffGuardResult(clear)).toBeNull();
  });

  test("each guard gives its own result", () => {
    expect(handoffGuardResult({ ...clear, doNotContact: true })).toBe("dnc");
    expect(handoffGuardResult({ ...clear, replied: true })).toBe("replied");
    expect(handoffGuardResult({ ...clear, activeElsewhere: true })).toBe("active_elsewhere");
    expect(handoffGuardResult({ ...clear, hasEmail: false })).toBe("no_email");
  });

  test("the order is dnc, replied, active_elsewhere, no_email", () => {
    expect(handoffGuardResult({ doNotContact: true, replied: true, activeElsewhere: true, hasEmail: false })).toBe("dnc");
    expect(handoffGuardResult({ doNotContact: false, replied: true, activeElsewhere: true, hasEmail: false })).toBe("replied");
    expect(handoffGuardResult({ doNotContact: false, replied: false, activeElsewhere: true, hasEmail: false })).toBe("active_elsewhere");
  });
});

describe("enrollmentHandoffResult", () => {
  const counts = (over: Partial<{ added: number; skippedDuplicate: number; skippedSuppressed: number; skippedMissingIdentity: number }>) => ({
    requested: 1, added: 0, skippedMissingIdentity: 0, skippedDuplicate: 0, skippedSuppressed: 0, ...over,
  });

  test("maps the enrollment counts for one person", () => {
    expect(enrollmentHandoffResult(counts({ added: 1 }))).toBe("enrolled");
    expect(enrollmentHandoffResult(counts({ skippedDuplicate: 1 }))).toBe("duplicate");
    expect(enrollmentHandoffResult(counts({ skippedSuppressed: 1 }))).toBe("suppressed");
    expect(enrollmentHandoffResult(counts({ skippedMissingIdentity: 1 }))).toBe("no_email");
  });
});

describe("acceptReleaseDecision", () => {
  const decided = new Date("2026-11-20T10:00:00Z");

  test("an enrolled hand-off is stopped and released when the accept wins", () => {
    expect(acceptReleaseDecision({ emailHandoffAt: decided, emailHandoffResult: "enrolled", emailHandoffCampaignId: CAMPAIGN_A })).toEqual({ release: true, stopCampaignId: CAMPAIGN_A });
  });

  test("any other decided hand-off is released (so email B can follow) but there is nothing to stop", () => {
    for (const result of ["duplicate", "suppressed", "dnc", "replied", "active_elsewhere", "no_email", "stopped_by_accept", null]) {
      expect(acceptReleaseDecision({ emailHandoffAt: decided, emailHandoffResult: result, emailHandoffCampaignId: CAMPAIGN_A })).toEqual({ release: true, stopCampaignId: null });
    }
    expect(acceptReleaseDecision({ emailHandoffAt: decided, emailHandoffResult: "enrolled", emailHandoffCampaignId: null })).toEqual({ release: true, stopCampaignId: null });
  });

  test("a lead never handed off is left alone", () => {
    expect(acceptReleaseDecision({ emailHandoffAt: null, emailHandoffResult: null, emailHandoffCampaignId: null })).toEqual({ release: false, stopCampaignId: null });
    expect(acceptReleaseDecision({})).toEqual({ release: false, stopCampaignId: null });
  });
});

describe("parseEmailHandoffSettings", () => {
  test("absent fields are left out; null or empty turns a campaign off; a UUID is kept", () => {
    expect(parseEmailHandoffSettings({})).toEqual({ ok: true });
    expect(parseEmailHandoffSettings({ emailCampaignIfNotAcceptedId: null, emailCampaignAfterSequenceId: "" })).toEqual({
      ok: true, emailCampaignIfNotAcceptedId: null, emailCampaignAfterSequenceId: null,
    });
    expect(parseEmailHandoffSettings({ emailCampaignIfNotAcceptedId: CAMPAIGN_A, emailAfterSequenceDelayDays: "4" })).toEqual({
      ok: true, emailCampaignIfNotAcceptedId: CAMPAIGN_A, emailAfterSequenceDelayDays: 4,
    });
  });

  test("the delay accepts 0 to 60 whole days; an empty delay is left out", () => {
    expect(parseEmailHandoffSettings({ emailAfterSequenceDelayDays: 0 })).toEqual({ ok: true, emailAfterSequenceDelayDays: 0 });
    expect(parseEmailHandoffSettings({ emailAfterSequenceDelayDays: 60 })).toEqual({ ok: true, emailAfterSequenceDelayDays: 60 });
    expect(parseEmailHandoffSettings({ emailAfterSequenceDelayDays: null })).toEqual({ ok: true });
  });

  test("a non-UUID id, and a delay of -1, 61, 2.5 or text, are refused", () => {
    expect(parseEmailHandoffSettings({ emailCampaignAfterSequenceId: "abc" }).ok).toBe(false);
    expect(parseEmailHandoffSettings({ emailCampaignIfNotAcceptedId: 5 }).ok).toBe(false);
    for (const bad of [-1, 61, 2.5, "x", true]) expect(parseEmailHandoffSettings({ emailAfterSequenceDelayDays: bad }).ok).toBe(false);
  });
});
