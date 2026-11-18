import { describe, expect, test } from "bun:test";
import { followUpFromEventData, followUpNoteError, isFollowUpNoteCurrent } from "./followUpNote";

const due = "2026-12-01T09:00:00.000Z";
const base = { eventContextVersion: 4, recordContextVersion: 4, workflowState: "waiting", nextActionAt: new Date(due), dueAt: due, hasOpenDraft: false };

describe("follow-up note", () => {
  test("validates length after trimming", () => {
    expect(followUpNoteError("  ab  ")).not.toBeNull();
    expect(followUpNoteError("abc")).toBeNull();
    expect(followUpNoteError("x".repeat(2_000))).toBeNull();
    expect(followUpNoteError("x".repeat(2_001))).not.toBeNull();
  });

  test("reads an event back, rejecting events without a note", () => {
    const created = new Date("2026-11-18T10:00:00Z");
    expect(followUpFromEventData({ dueAt: due, note: " Send the deck " }, { actorRef: "Sam", createdAt: created }))
      .toEqual({ dueAt: due, note: "Send the deck", actorRef: "Sam", createdAt: created.toISOString() });
    expect(followUpFromEventData({ dueAt: due }, { createdAt: created })).toBeNull();
    expect(followUpFromEventData({ dueAt: "nope", note: "x" }, { createdAt: created })).toBeNull();
    expect(followUpFromEventData(null, { createdAt: created })).toBeNull();
  });

  test("current while waiting on the date, and after it passes until the rep acts", () => {
    expect(isFollowUpNoteCurrent(base)).toBe(true);
    expect(isFollowUpNoteCurrent({ ...base, nextActionAt: due })).toBe(true);
  });

  test("not current after a reply, stage move or close (context version moved)", () => {
    expect(isFollowUpNoteCurrent({ ...base, recordContextVersion: 5 })).toBe(false);
    expect(isFollowUpNoteCurrent({ ...base, eventContextVersion: null })).toBe(false);
    expect(isFollowUpNoteCurrent({ ...base, workflowState: "closed" })).toBe(false);
  });

  test("not current once the rep sent something (next action moved, no open draft)", () => {
    expect(isFollowUpNoteCurrent({ ...base, nextActionAt: null })).toBe(false);
    expect(isFollowUpNoteCurrent({ ...base, nextActionAt: new Date("2026-12-20T09:00:00Z") })).toBe(false);
  });

  test("current while a draft written for the day is open, whatever the next action", () => {
    expect(isFollowUpNoteCurrent({ ...base, nextActionAt: new Date("2026-12-01T12:00:00Z"), hasOpenDraft: true })).toBe(true);
    expect(isFollowUpNoteCurrent({ ...base, nextActionAt: null, hasOpenDraft: true })).toBe(true);
  });
});
