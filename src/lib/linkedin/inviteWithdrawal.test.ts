import { describe, expect, test } from "bun:test";
import {
  MAX_WITHDRAW_RETRIES,
  firstDegreeFromProfile,
  isInvitationGoneError,
  isRateLimitError,
  isTransientError,
  isWithinWithdrawnAcceptWindow,
  planWithdrawal,
  shouldStopRun,
  isWithdrawalDue,
  selectDueWithdrawals,
} from "./inviteWithdrawal";
import { parseWithdrawAfterWorkingDays } from "./sequenceTiming";
import type { WorkingHoursFields } from "./workingHours";

const MON_FRI: WorkingHoursFields = { workTimezone: "Asia/Kolkata", workStartTime: null, workEndTime: null, workDays: "1,2,3,4,5" };
// Sent Thursday 2026-11-19 10:00 IST; with Mon-Fri, 4 working days have passed on Wednesday 2026-11-25.
const SENT = new Date("2026-11-19T04:30:00Z");
const TUESDAY = new Date("2026-11-24T04:30:00Z");
const WEDNESDAY = new Date("2026-11-25T04:30:00Z");

const candidate = (over: Partial<{ requestSentAt: Date | null; withdrawAfterWorkingDays: number | null; withdrawRetryCount: number }> = {}) => ({
  requestSentAt: SENT,
  withdrawAfterWorkingDays: 4,
  withdrawRetryCount: 0,
  ...over,
});

describe("isWithdrawalDue", () => {
  test("is due once the working days have passed, not before", () => {
    expect(isWithdrawalDue(candidate(), TUESDAY, MON_FRI)).toBe(false);
    expect(isWithdrawalDue(candidate(), WEDNESDAY, MON_FRI)).toBe(true);
  });

  test("off (null) is never due, whatever the age", () => {
    expect(isWithdrawalDue(candidate({ withdrawAfterWorkingDays: null }), new Date("2027-11-25T04:30:00Z"), MON_FRI)).toBe(false);
  });

  test("a lead with no send time is not due", () => {
    expect(isWithdrawalDue(candidate({ requestSentAt: null }), WEDNESDAY, MON_FRI)).toBe(false);
  });

  test("a lead that failed the maximum number of times is skipped", () => {
    expect(isWithdrawalDue(candidate({ withdrawRetryCount: MAX_WITHDRAW_RETRIES - 1 }), WEDNESDAY, MON_FRI)).toBe(true);
    expect(isWithdrawalDue(candidate({ withdrawRetryCount: MAX_WITHDRAW_RETRIES }), WEDNESDAY, MON_FRI)).toBe(false);
  });

  test("a Saturday counts for a Mon-Sat account, so the same invite is due a day sooner", () => {
    const monSat = { ...MON_FRI, workDays: "1,2,3,4,5,6" };
    expect(isWithdrawalDue(candidate(), TUESDAY, monSat)).toBe(true);
  });
});

describe("selectDueWithdrawals", () => {
  test("keeps the order, drops what is not due and stops at the limit", () => {
    const rows = [
      { id: "a", ...candidate() },
      { id: "b", ...candidate({ withdrawAfterWorkingDays: 10 }) },
      { id: "c", ...candidate() },
      { id: "d", ...candidate() },
    ];
    expect(selectDueWithdrawals(rows, WEDNESDAY, MON_FRI, 2).map((r) => r.id)).toEqual(["a", "c"]);
    expect(selectDueWithdrawals(rows, WEDNESDAY, MON_FRI, 10).map((r) => r.id)).toEqual(["a", "c", "d"]);
    expect(selectDueWithdrawals(rows, WEDNESDAY, MON_FRI, 0)).toEqual([]);
  });
});

describe("provider error mapping", () => {
  const sdkError = (body: unknown, response?: { status: number }) => Object.assign(new Error(""), { body, response });

  test("a 404 (on .body.status, .body.statusCode or .response.status) means the invitation is gone", () => {
    expect(isInvitationGoneError(sdkError({ status: 404, type: "errors/resource_not_found" }))).toBe(true);
    expect(isInvitationGoneError(sdkError({ statusCode: 404 }))).toBe(true);
    expect(isInvitationGoneError(sdkError(undefined, { status: 404 }))).toBe(true);
    expect(isInvitationGoneError(sdkError({ type: "errors/resource_not_found" }))).toBe(true);
  });

  test("other errors are not 'gone'", () => {
    expect(isInvitationGoneError(sdkError({ status: 500 }))).toBe(false);
    expect(isInvitationGoneError(sdkError({ status: 401, type: "errors/invalid_credentials" }))).toBe(false);
    expect(isInvitationGoneError(sdkError({ status: 429 }))).toBe(false);
    expect(isInvitationGoneError(new Error("network down"))).toBe(false);
    expect(isInvitationGoneError(null)).toBe(false);
    expect(isInvitationGoneError("404")).toBe(false);
  });

  test("rate and limit answers stop the account", () => {
    expect(isRateLimitError(sdkError({ status: 429 }))).toBe(true);
    expect(isRateLimitError(sdkError({ status: 422, message: "You have reached the weekly invitation limit" }))).toBe(true);
    expect(isRateLimitError(sdkError({ status: 500, message: "boom" }))).toBe(false);
    expect(isRateLimitError(new Error("network down"))).toBe(false);
  });
});

describe("firstDegreeFromProfile", () => {
  test("reads network_distance, then is_relationship, else unknown", () => {
    expect(firstDegreeFromProfile({ network_distance: "FIRST_DEGREE" })).toBe(true);
    expect(firstDegreeFromProfile({ network_distance: "DISTANCE_1" })).toBe(true);
    expect(firstDegreeFromProfile({ network_distance: "SECOND_DEGREE" })).toBe(false);
    expect(firstDegreeFromProfile({ network_distance: "OUT_OF_NETWORK" })).toBe(false);
    expect(firstDegreeFromProfile({ is_relationship: true })).toBe(true);
    expect(firstDegreeFromProfile({ is_relationship: false })).toBe(false);
    expect(firstDegreeFromProfile({ first_name: "Pat" })).toBeNull();
    expect(firstDegreeFromProfile(null)).toBeNull();
  });
});

describe("parseWithdrawAfterWorkingDays", () => {
  test("absent is not mentioned, null or empty means never, whole numbers 1..60 are accepted", () => {
    expect(parseWithdrawAfterWorkingDays({})).toEqual({ ok: true, present: false, value: null });
    expect(parseWithdrawAfterWorkingDays({ withdrawAfterWorkingDays: null })).toEqual({ ok: true, present: true, value: null });
    expect(parseWithdrawAfterWorkingDays({ withdrawAfterWorkingDays: "" })).toEqual({ ok: true, present: true, value: null });
    expect(parseWithdrawAfterWorkingDays({ withdrawAfterWorkingDays: 4 })).toEqual({ ok: true, present: true, value: 4 });
    expect(parseWithdrawAfterWorkingDays({ withdrawAfterWorkingDays: "60" })).toEqual({ ok: true, present: true, value: 60 });
  });

  test("0, 61, fractions and text are refused", () => {
    for (const bad of [0, 61, -1, 2.5, "abc", true]) {
      expect(parseWithdrawAfterWorkingDays({ withdrawAfterWorkingDays: bad }).ok).toBe(false);
    }
  });
});

describe("isTransientError", () => {
  const sdkError = (status?: number) => Object.assign(new Error(""), { body: status === undefined ? undefined : { status } });

  test("429, 5xx and errors with no HTTP status (network, timeout) are transient", () => {
    expect(isTransientError(sdkError(429))).toBe(true);
    expect(isTransientError(sdkError(500))).toBe(true);
    expect(isTransientError(sdkError(503))).toBe(true);
    expect(isTransientError(new Error("ETIMEDOUT"))).toBe(true);
    expect(isTransientError(sdkError(undefined))).toBe(true);
  });

  test("other 4xx answers are about the lead", () => {
    for (const status of [400, 401, 403, 404, 422]) expect(isTransientError(sdkError(status))).toBe(false);
  });

  test("shouldStopRun also stops on a limit message with a 4xx status", () => {
    expect(shouldStopRun(sdkError(422))).toBe(false);
    expect(shouldStopRun(Object.assign(new Error(""), { body: { status: 422, message: "weekly invitation limit reached" } }))).toBe(true);
    expect(shouldStopRun(sdkError(502))).toBe(true);
  });
});

describe("planWithdrawal", () => {
  test("listed: cancel that id; unlisted in a complete list: check the profile", () => {
    expect(planWithdrawal({ listed: true, listComplete: false, hasStoredId: false })).toBe("cancel_listed");
    expect(planWithdrawal({ listed: true, listComplete: true, hasStoredId: true })).toBe("cancel_listed");
    expect(planWithdrawal({ listed: false, listComplete: true, hasStoredId: true })).toBe("check_profile");
    expect(planWithdrawal({ listed: false, listComplete: true, hasStoredId: false })).toBe("check_profile");
  });

  test("unlisted in an incomplete list: the stored id, or reconcile when there is none", () => {
    expect(planWithdrawal({ listed: false, listComplete: false, hasStoredId: true })).toBe("cancel_stored");
    expect(planWithdrawal({ listed: false, listComplete: false, hasStoredId: false })).toBe("reconcile");
  });
});

describe("isWithinWithdrawnAcceptWindow", () => {
  const withdrawn = new Date("2026-11-20T10:00:00Z");
  const at = (hours: number) => new Date(withdrawn.getTime() + hours * 3_600_000);

  test("an accept within 2 days of the withdrawal may continue as an accept", () => {
    expect(isWithinWithdrawnAcceptWindow(withdrawn, at(0))).toBe(true);
    expect(isWithinWithdrawnAcceptWindow(withdrawn, at(48))).toBe(true);
  });

  test("later than 2 days, or with no withdrawal time, it may not", () => {
    expect(isWithinWithdrawnAcceptWindow(withdrawn, at(48.01))).toBe(false);
    expect(isWithinWithdrawnAcceptWindow(null, at(1))).toBe(false);
    expect(isWithinWithdrawnAcceptWindow(undefined, at(1))).toBe(false);
  });
});
