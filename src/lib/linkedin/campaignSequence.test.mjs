import { describe, expect, test } from "bun:test";
import {
  EMPTY_LINKEDIN_SEQUENCE,
  LINKEDIN_SEQUENCE_STEPS,
  linkedinSequenceDelaysError,
  linkedinSequenceError,
  linkedinSequenceOffsetsDays,
  linkedinSequenceSteps,
  normalizeLinkedinSequence,
} from "./campaignSequence.ts";

describe("LinkedIn campaign sequence", () => {
  test("matches the fixed worker order and timing", () => {
    expect(LINKEDIN_SEQUENCE_STEPS.map(({ field, timing }) => ({ field, timing }))).toEqual([
      { field: "invitationMessage", timing: "Immediately" },
      { field: "acceptanceMessage", timing: "When accepted" },
      { field: "followUp1Message", timing: "1 day later" },
      { field: "followUp2Message", timing: "2 days later" },
      { field: "followUp3Message", timing: "3 days later" },
      { field: "followUp4Message", timing: "4 days later" },
    ]);
  });

  test("the default delays are the old 24 / 48 / 72 hour gaps and send the acceptance at once", () => {
    expect(linkedinSequenceOffsetsDays()).toEqual({ acceptance: 0, followUp1: 1, followUp2: 3, followUp3: 6, followUp4: 10 });
    expect(linkedinSequenceOffsetsDays(null)).toEqual(linkedinSequenceOffsetsDays({}));
  });

  test("the lender flow lands at +1, +4, +8, +12 and +19 days after the accept", () => {
    const delays = { acceptanceDelayDays: 1, followUp1DelayDays: 3, followUp2DelayDays: 4, followUp3DelayDays: 4, followUp4DelayDays: 7 };
    expect(linkedinSequenceOffsetsDays(delays)).toEqual({ acceptance: 1, followUp1: 4, followUp2: 8, followUp3: 12, followUp4: 19 });
  });

  test("timing labels follow the campaign's delays", () => {
    const steps = linkedinSequenceSteps({ acceptanceDelayDays: 1, followUp1DelayDays: 3, followUp4DelayDays: 7 });
    expect(steps.map(({ timing }) => timing)).toEqual([
      "Immediately",
      "1 day after accepted",
      "3 days later",
      "2 days later",
      "3 days later",
      "7 days later",
    ]);
  });

  test("rejects a gap before follow-up 4", () => {
    expect(
      linkedinSequenceError({ ...EMPTY_LINKEDIN_SEQUENCE, followUp1Message: "One", followUp2Message: "Two", followUp4Message: "Four" }),
    ).toBe("Add follow-up 3 before adding a later follow-up");
    expect(
      linkedinSequenceError({ ...EMPTY_LINKEDIN_SEQUENCE, followUp1Message: "One", followUp2Message: "Two", followUp3Message: "Three", followUp4Message: "Four" }),
    ).toBeNull();
  });

  test("rejects delays outside their ranges", () => {
    expect(linkedinSequenceDelaysError({ acceptanceDelayDays: 0, followUp1DelayDays: 1, followUp4DelayDays: 60 })).toBeNull();
    expect(linkedinSequenceDelaysError({ acceptanceDelayDays: 31 })).toContain("0 to 30");
    expect(linkedinSequenceDelaysError({ acceptanceDelayDays: -1 })).toContain("0 to 30");
    expect(linkedinSequenceDelaysError({ followUp2DelayDays: 0 })).toContain("1 to 60");
    expect(linkedinSequenceDelaysError({ followUp4DelayDays: 61 })).toContain("1 to 60");
    expect(linkedinSequenceDelaysError({ followUp1DelayDays: 1.5 })).toContain("whole number");
    expect(linkedinSequenceDelaysError({ followUp3DelayDays: "abc" })).toContain("whole number");
  });

  test("normalizes whitespace and nullable values", () => {
    expect(normalizeLinkedinSequence({ invitationMessage: "  Hello  ", acceptanceMessage: null })).toEqual({
      ...EMPTY_LINKEDIN_SEQUENCE,
      invitationMessage: "Hello",
    });
  });

  test("allows optional messages but rejects gaps between follow-ups", () => {
    expect(linkedinSequenceError({ ...EMPTY_LINKEDIN_SEQUENCE, acceptanceMessage: "Thanks" })).toBeNull();
    expect(linkedinSequenceError({ ...EMPTY_LINKEDIN_SEQUENCE, followUp2Message: "Checking in" })).toBe(
      "Add follow-up 1 before adding a later follow-up",
    );
    expect(linkedinSequenceError({ ...EMPTY_LINKEDIN_SEQUENCE, followUp1Message: "One", followUp3Message: "Three" })).toBe(
      "Add follow-up 2 before adding a later follow-up",
    );
  });

  test("enforces the LinkedIn invitation limit", () => {
    expect(linkedinSequenceError({ ...EMPTY_LINKEDIN_SEQUENCE, invitationMessage: "x".repeat(300) })).toBeNull();
    expect(linkedinSequenceError({ ...EMPTY_LINKEDIN_SEQUENCE, invitationMessage: "x".repeat(301) })).toContain("300");
  });
});
