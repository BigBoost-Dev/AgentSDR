import { describe, expect, test } from "bun:test";
import {
  classifyWebhookOwnership,
  compareEligibleAccountIds,
  compareLinkedinLead,
  legacyNextAction,
  peopleNextAction,
} from "./migrationParity.ts";

const NOW = new Date("2026-08-27T12:00:00Z");

function lead(overrides = {}) {
  return {
    id: "lead-1",
    status: "PENDING",
    campaignStatus: "ACTIVE",
    campaignId: "campaign-1",
    personId: "person-1",
    providerId: "provider-1",
    linkedinAccountId: null,
    legacyLinkedinUrl: "pat-lee",
    personLinkedinUrl: "pat-lee",
    sourceLinkedinIdentifier: null,
    sourceLinkedinApi: null,
    inviteRetryCount: 0,
    resolveRetryCount: 0,
    resolveNextAttemptAt: null,
    requestSentAt: null,
    acceptMessageSentAt: null,
    followUp1SentAt: null,
    followUp2SentAt: null,
    followUp3SentAt: null,
    connectionChatId: null,
    leadTemplates: { invitationMessage: "Hi Pat" },
    campaignTemplates: {},
    variables: { firstName: "Pat" },
    canonicalMessageTypes: new Set(),
    ...overrides,
  };
}

describe("LinkedIn old/new next-action parity", () => {
  test("keeps a resolved invitation target and next action unchanged", () => {
    const result = compareLinkedinLead(lead(), NOW);
    expect(result.targetCompatible).toBe(true);
    expect(result.differences).toEqual([]);
  });

  test("uses the exact unresolved source identifier for resolution", () => {
    const item = lead({
      providerId: null,
      personLinkedinUrl: null,
      legacyLinkedinUrl: "https://linkedin.com/sales/lead/ENCODED",
      sourceLinkedinIdentifier: "https://linkedin.com/sales/lead/ENCODED",
      sourceLinkedinApi: "sales_navigator",
    });
    expect(legacyNextAction(item, NOW).action).toBe("resolve_profile");
    expect(peopleNextAction(item, NOW).action).toBe("resolve_profile");
    expect(compareLinkedinLead(item, NOW).differences).toEqual([]);
  });

  test("allows a migrated provider id to take the safer resolution detour", () => {
    const result = compareLinkedinLead(lead({ sourceLinkedinIdentifier: "stale-source" }), NOW);
    expect(result.legacy.action).toBe("send_invitation");
    expect(result.current.action).toBe("resolve_profile");
    expect(result.safeResolutionDetour).toBe(true);
    expect(result.differences).toEqual([]);
  });

  test("does not require an invitation target after the request was sent", () => {
    const result = compareLinkedinLead(lead({
      status: "REQUEST_SENT",
      providerId: "provider-1",
      personLinkedinUrl: null,
      sourceLinkedinIdentifier: "provider-1",
    }), NOW);
    expect(result.targetCompatible).toBe(true);
    expect(result.differences).toEqual([]);
  });

  test("detects campaign-template or People-variable content drift", () => {
    const result = compareLinkedinLead(lead({
      leadTemplates: { invitationMessage: "Hi Pat" },
      campaignTemplates: { invitationMessage: "Hi {{firstName}} from the new campaign" },
    }), NOW);
    expect(result.differences).toContain("rendered_content");
  });

  test("canonical message claims prevent acceptance and follow-up replay after restart", () => {
    const acceptance = peopleNextAction(lead({
      status: "REQUEST_SENT",
      connectionChatId: "chat-1",
      leadTemplates: { acceptanceMessage: "Thanks" },
      canonicalMessageTypes: new Set(["ACCEPTANCE"]),
    }), NOW);
    expect(acceptance).toMatchObject({ action: "advance_acceptance", reason: "already_claimed" });

    const followUp = peopleNextAction(lead({
      status: "ACCEPT_MESSAGE_SENT",
      acceptMessageSentAt: new Date("2026-08-25T00:00:00Z"),
      leadTemplates: { followUp1Message: "Checking in" },
      canonicalMessageTypes: new Set(["FOLLOW_UP_1"]),
    }), NOW);
    expect(followUp).toMatchObject({ action: "advance_existing_claim", reason: "already_claimed" });
  });

  test("an existing invitation claim blocks provider replay until reconciliation", () => {
    const result = compareLinkedinLead(lead({ canonicalMessageTypes: new Set(["INVITATION"]) }), NOW);
    expect(result.current.action).toBe("wait_invitation_reconciliation");
    expect(result.current.reason).toBe("already_claimed");
    expect(result.differences).not.toContain("invitation_restart_duplicate_risk");
    expect(result.differences).not.toContain("next_action");
  });
});

describe("LinkedIn per-campaign follow-up delays", () => {
  const dayAgo = (days, hours = 0) => new Date(NOW.getTime() - days * 24 * 3600_000 - hours * 3600_000);
  const base = { status: "ACCEPT_MESSAGE_SENT", leadTemplates: { followUp1Message: "Checking in" } };

  test("default delays keep the old 24 / 48 / 72 hour gaps", () => {
    expect(peopleNextAction(lead({ ...base, acceptMessageSentAt: dayAgo(1, 1) }), NOW).action).toBe("send_follow_up_1");
    expect(peopleNextAction(lead({ ...base, acceptMessageSentAt: dayAgo(0, 23) }), NOW).action).toBe("wait");
    const second = { status: "FOLLOW_UP_1_SENT", leadTemplates: { followUp2Message: "Two" } };
    expect(peopleNextAction(lead({ ...second, followUp1SentAt: dayAgo(2, 1) }), NOW).action).toBe("send_follow_up_2");
    expect(peopleNextAction(lead({ ...second, followUp1SentAt: dayAgo(1, 23) }), NOW).action).toBe("wait");
    const third = { status: "FOLLOW_UP_2_SENT", leadTemplates: { followUp3Message: "Three" } };
    expect(peopleNextAction(lead({ ...third, followUp2SentAt: dayAgo(3, 1) }), NOW).action).toBe("send_follow_up_3");
    expect(peopleNextAction(lead({ ...third, followUp2SentAt: dayAgo(2, 23) }), NOW).action).toBe("wait");
  });

  test("a campaign's own delays replace the defaults, in both models", () => {
    const item = lead({ ...base, acceptMessageSentAt: dayAgo(2), campaignDelays: { followUp1DelayDays: 3 } });
    expect(peopleNextAction(item, NOW)).toMatchObject({ action: "wait", reason: "not_due" });
    expect(legacyNextAction(item, NOW)).toMatchObject({ action: "wait", reason: "not_due" });
    const due = lead({ ...base, acceptMessageSentAt: dayAgo(3), campaignDelays: { followUp1DelayDays: 3 } });
    expect(peopleNextAction(due, NOW).action).toBe("send_follow_up_1");
    expect(compareLinkedinLead(due, NOW).differences).toEqual([]);
  });

  test("follow-up 4 is sent from FOLLOW_UP_3_SENT after its own delay and ends the sequence", () => {
    const fourth = { status: "FOLLOW_UP_3_SENT", leadTemplates: { followUp4Message: "Four" }, followUp3SentAt: dayAgo(7) };
    expect(peopleNextAction(lead({ ...fourth, campaignDelays: { followUp4DelayDays: 7 } }), NOW).action).toBe("send_follow_up_4");
    expect(peopleNextAction(lead({ ...fourth, campaignDelays: { followUp4DelayDays: 8 } }), NOW).action).toBe("wait");
    expect(peopleNextAction(lead({ ...fourth, leadTemplates: {} }), NOW)).toMatchObject({ action: "complete", reason: "sequence_exhausted" });
    expect(peopleNextAction(lead({ ...fourth, canonicalMessageTypes: new Set(["FOLLOW_UP_4"]) }), NOW).action).toBe("advance_existing_claim");
    expect(compareLinkedinLead(lead({ ...fourth, campaignDelays: { followUp4DelayDays: 7 } }), NOW).differences).toEqual([]);
  });
});

describe("LinkedIn webhook ownership parity", () => {
  const candidate = (id, status, overrides = {}) => ({
    id,
    status,
    superseded: false,
    requestSentAt: new Date("2026-08-20T00:00:00Z"),
    createdAt: new Date("2026-08-01T00:00:00Z"),
    ...overrides,
  });

  test("routes an unambiguous provider/account pair to exactly one Lead", () => {
    expect(classifyWebhookOwnership([candidate("lead-1", "REQUEST_SENT")])).toMatchObject({
      inboundOwnerId: "lead-1",
      connectionOwnerId: "lead-1",
      inboundAmbiguous: false,
      connectionAmbiguous: false,
    });
  });

  test("rejects multiple request owners", () => {
    const result = classifyWebhookOwnership([
      candidate("lead-1", "REQUEST_SENT"),
      candidate("lead-2", "REQUEST_SENT"),
    ]);
    expect(result.inboundOwnerId).toBeNull();
    expect(result.connectionOwnerId).toBeNull();
    expect(result.connectionAmbiguous).toBe(true);
  });

  test("rejects an ambiguous connection-accepted fallback", () => {
    const result = classifyWebhookOwnership([
      candidate("lead-1", "CONNECTED"),
      candidate("lead-2", "REPLIED"),
    ]);
    expect(result.inboundOwnerId).toBeNull();
    expect(result.connectionAmbiguous).toBe(true);
    expect(result.connectionOwnerId).toBeNull();
  });

  test("ignores explicitly superseded history", () => {
    const result = classifyWebhookOwnership([
      candidate("canonical", "REQUEST_SENT"),
      candidate("history", "CANCELLED", { superseded: true }),
    ]);
    expect(result.inboundOwnerId).toBe("canonical");
    expect(result.connectionOwnerId).toBe("canonical");
  });
});

describe("LinkedIn account assignment parity", () => {
  test("compares candidate senders after old URL and new Person exclusion rules", () => {
    expect(compareEligibleAccountIds(["b", "a"], new Set(["b"]), new Set(["b"]))).toEqual({
      legacy: ["a"], current: ["a"], matches: true, safeNarrowing: true,
    });
    expect(compareEligibleAccountIds(["a", "b"], new Set(["a"]), new Set(["b"]))).toMatchObject({
      legacy: ["b"], current: ["a"], matches: false, safeNarrowing: false,
    });
    expect(compareEligibleAccountIds(["a", "b"], new Set(), new Set(["b"]))).toMatchObject({
      legacy: ["a", "b"], current: ["a"], matches: false, safeNarrowing: true,
    });
  });
});
