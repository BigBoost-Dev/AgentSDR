/**
 * "Follow up on a date": the pure date rules, shared by the dialog, the
 * route and the MCP tool. Import-free so a client component can use it.
 */

/** Furthest a follow-up may be set: a typo like 2062 should not park a lead for good. */
export const MAX_FOLLOW_UP_DAYS = 730;
/** Hour of the chosen day (browser-local time) a follow-up falls due. */
export const FOLLOW_UP_DUE_HOUR = 9;

export const FOLLOW_UP_PRESETS = [
  { label: "Tomorrow", days: 1 },
  { label: "1 week", days: 7 },
  { label: "1 month", days: 30 },
  { label: "3 months", days: 90 },
] as const;

/** The message for a follow-up time that cannot be used, or null when it is fine. */
export function followUpDateError(at: Date, now: Date = new Date()): string | null {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) return "Pick a valid date.";
  if (at.getTime() <= now.getTime()) return "Pick a date in the future.";
  if (at.getTime() > now.getTime() + MAX_FOLLOW_UP_DAYS * 86_400_000) return `Pick a date within ${MAX_FOLLOW_UP_DAYS} days.`;
  return null;
}

/** 9:00 local time, `days` calendar days after `from`'s date. */
export function followUpDueIn(days: number, from: Date = new Date()): Date {
  return new Date(from.getFullYear(), from.getMonth(), from.getDate() + Math.round(days), FOLLOW_UP_DUE_HOUR, 0, 0, 0);
}

/** 9:00 local time on a `YYYY-MM-DD` date input value; null if it is not a real date. */
export function followUpDueOn(dateValue: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const due = new Date(year, month - 1, day, FOLLOW_UP_DUE_HOUR, 0, 0, 0);
  // new Date rolls 31 Feb over to March; a real date round-trips.
  if (due.getFullYear() !== year || due.getMonth() !== month - 1 || due.getDate() !== day) return null;
  return due;
}

/** `YYYY-MM-DD` of a date in local time, for a date input's value. */
export function toDateInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Whole calendar days from `from`'s date to `to`'s date (local time). */
export function daysBetween(to: Date, from: Date = new Date()): number {
  const a = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  const b = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  return Math.round((a - b) / 86_400_000);
}
