import { describe, expect, test } from "bun:test";
import { daysBetween, followUpDateError, followUpDueIn, followUpDueOn, MAX_FOLLOW_UP_DAYS, toDateInputValue } from "./followUpDate";

const now = new Date(2026, 10, 18, 14, 30);

describe("follow-up dates", () => {
  test("rejects invalid, past and too-distant times", () => {
    expect(followUpDateError(new Date("nope"), now)).not.toBeNull();
    expect(followUpDateError(new Date(now.getTime() - 1), now)).not.toBeNull();
    expect(followUpDateError(now, now)).not.toBeNull();
    expect(followUpDateError(new Date(now.getTime() + (MAX_FOLLOW_UP_DAYS + 1) * 86_400_000), now)).not.toBeNull();
    expect(followUpDateError(new Date(now.getTime() + 45 * 86_400_000), now)).toBeNull();
  });

  test("followUpDueIn lands at 9:00 local, N calendar days on", () => {
    const due = followUpDueIn(45, now);
    expect([due.getFullYear(), due.getMonth(), due.getDate(), due.getHours(), due.getMinutes()]).toEqual([2027, 0, 2, 9, 0]);
    expect(followUpDateError(followUpDueIn(1, now), now)).toBeNull();
  });

  test("followUpDueOn parses date inputs and refuses impossible dates", () => {
    const due = followUpDueOn("2027-02-14")!;
    expect([due.getFullYear(), due.getMonth(), due.getDate(), due.getHours()]).toEqual([2027, 1, 14, 9]);
    expect(followUpDueOn("2027-02-31")).toBeNull();
    expect(followUpDueOn("")).toBeNull();
    expect(followUpDueOn("14/02/2027")).toBeNull();
  });

  test("round-trips through the date input value and day count", () => {
    const due = followUpDueIn(45, now);
    expect(toDateInputValue(due)).toBe("2027-01-02");
    expect(daysBetween(due, now)).toBe(45);
  });
});
