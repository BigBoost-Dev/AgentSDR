/**
 * The note that goes with "Follow up later": why it is later and what to do
 * on the day. Pure and import-free (the dialog, the route, the MCP tool, the
 * queue and the drafting job all use it).
 *
 * The note lives in the `record.follow_up_scheduled` event (toData.note) with
 * the context version the schedule produced; nothing else stores it.
 */
export const FOLLOW_UP_NOTE_MIN = 3;
export const FOLLOW_UP_NOTE_MAX = 2_000;
export const FOLLOW_UP_EVENT = "record.follow_up_scheduled";

/** The message for a note that cannot be used, or null when it is fine. */
export function followUpNoteError(note: string): string | null {
  const length = note.trim().length;
  if (length < FOLLOW_UP_NOTE_MIN) return "Say why it is later and what should happen then.";
  if (length > FOLLOW_UP_NOTE_MAX) return `Keep the note under ${FOLLOW_UP_NOTE_MAX} characters.`;
  return null;
}

export type FollowUpNote = { dueAt: string; note: string; actorRef: string | null; createdAt: string };

/** Reads a stored event's data back into a note, or null when it is not one. */
export function followUpFromEventData(
  toData: unknown,
  event: { actorRef?: string | null; createdAt: Date | string },
): FollowUpNote | null {
  const data = (toData && typeof toData === "object" ? toData : {}) as Record<string, unknown>;
  if (typeof data.dueAt !== "string" || typeof data.note !== "string" || !data.note.trim()) return null;
  if (Number.isNaN(new Date(data.dueAt).getTime())) return null;
  return {
    dueAt: new Date(data.dueAt).toISOString(),
    note: data.note.trim(),
    actorRef: event.actorRef ?? null,
    createdAt: new Date(event.createdAt).toISOString(),
  };
}

/**
 * Whether a follow-up note still applies. Scheduling bumps the record's
 * context version and stamps the event with it; a reply, a stage move or a
 * close bumps it again, so a different version means something newer
 * happened. Sending a message does not bump it, so beyond the version the
 * rep must not have acted yet: the record still waits on the scheduled time
 * (it stays equal to dueAt after it passes), or a draft written for the day
 * is open.
 */
export function isFollowUpNoteCurrent(input: {
  eventContextVersion: number | null;
  recordContextVersion: number;
  workflowState: string;
  nextActionAt: Date | string | null;
  dueAt: string;
  hasOpenDraft: boolean;
}): boolean {
  if (input.eventContextVersion === null || input.eventContextVersion !== input.recordContextVersion) return false;
  if (input.workflowState === "closed") return false;
  if (input.hasOpenDraft) return true;
  return input.nextActionAt !== null && new Date(input.nextActionAt).getTime() === new Date(input.dueAt).getTime();
}
