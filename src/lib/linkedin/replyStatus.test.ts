import { describe, expect, test } from "bun:test";
import { leadStatusEnum, type LeadStatus } from "./schema";
import { isLateInvitationEcho, isLinkedinReplyStatus } from "./replyStatus";

describe("isLinkedinReplyStatus", () => {
  test("a reply from a CONNECTED lead (acceptance delay running) counts, so it stops the sequence", () => {
    expect(isLinkedinReplyStatus("CONNECTED")).toBe(true);
  });

  test("a message from a lead whose invitation we withdrew is a real reply", () => {
    expect(isLinkedinReplyStatus("WITHDRAWN")).toBe(true);
  });

  test("every post-acceptance status counts, and a thread already REPLIED keeps recording", () => {
    for (const status of ["ACCEPT_MESSAGE_SENT", "FOLLOW_UP_1_SENT", "FOLLOW_UP_2_SENT", "FOLLOW_UP_3_SENT", "COMPLETED", "REPLIED"] as const) {
      expect(isLinkedinReplyStatus(status)).toBe(true);
    }
  });

  test("statuses before the connection exists, and dead ends, do not", () => {
    for (const status of ["PENDING", "REQUEST_SENT", "FAILED", "CANCELLED"] as const) {
      expect(isLinkedinReplyStatus(status)).toBe(false);
    }
  });

  test("every status in the enum is classified (a new status must be decided here)", () => {
    const expected: Record<LeadStatus, boolean> = {
      PENDING: false,
      REQUEST_SENT: false,
      CONNECTED: true,
      ACCEPT_MESSAGE_SENT: true,
      FOLLOW_UP_1_SENT: true,
      FOLLOW_UP_2_SENT: true,
      FOLLOW_UP_3_SENT: true,
      COMPLETED: true,
      REPLIED: true,
      FAILED: false,
      CANCELLED: false,
      WITHDRAWN: true,
    };
    for (const status of leadStatusEnum.enumValues) {
      expect(isLinkedinReplyStatus(status)).toBe(expected[status]);
    }
  });
});

describe("isLateInvitationEcho", () => {
  const note = "Hi Pat, would love to connect";

  test("the invitation note arriving after the accept is an echo, in ACCEPT_MESSAGE_SENT and in CONNECTED (acceptance delay running)", () => {
    expect(isLateInvitationEcho("ACCEPT_MESSAGE_SENT", note, `  ${note} `)).toBe(true);
    expect(isLateInvitationEcho("CONNECTED", note, note)).toBe(true);
  });

  test("the invitation note delivered into the chat of a WITHDRAWN lead (accept raced the withdrawal) is an echo, not a reply", () => {
    expect(isLateInvitationEcho("WITHDRAWN", note, note)).toBe(true);
    expect(isLateInvitationEcho("WITHDRAWN", note, "Sure, tell me more")).toBe(false);
  });

  test("a different message is a reply, and so is anything in other statuses or with no invitation text", () => {
    expect(isLateInvitationEcho("CONNECTED", note, "Sure, tell me more")).toBe(false);
    expect(isLateInvitationEcho("FOLLOW_UP_1_SENT", note, note)).toBe(false);
    expect(isLateInvitationEcho("CONNECTED", null, note)).toBe(false);
    expect(isLateInvitationEcho("CONNECTED", "", "")).toBe(false);
  });
});
