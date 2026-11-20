import { describe, expect, test } from "bun:test";
import { workingDaysElapsed, type WorkingHoursFields } from "./workingHours";

const hours = (workTimezone: string | null, workDays: string | null): WorkingHoursFields => ({
  workTimezone,
  workStartTime: null,
  workEndTime: null,
  workDays,
});
const IST_MON_FRI = hours("Asia/Kolkata", "1,2,3,4,5");
const IST_MON_SAT = hours("Asia/Kolkata", "1,2,3,4,5,6");

// 2026-11-19 is a Thursday. 10:00 IST = 04:30Z.
const THU_SENT = new Date("2026-11-19T04:30:00Z");
const istMorning = (day: string) => new Date(`${day}T04:30:00Z`);

describe("workingDaysElapsed", () => {
  test("Mon-Fri: an invite sent on Thursday has 1 working day on Friday, 2 on Monday, 3 on Tuesday, 4 on Wednesday", () => {
    expect(workingDaysElapsed(THU_SENT, istMorning("2026-11-19"), IST_MON_FRI)).toBe(0);
    expect(workingDaysElapsed(THU_SENT, istMorning("2026-11-20"), IST_MON_FRI)).toBe(1);
    expect(workingDaysElapsed(THU_SENT, istMorning("2026-11-21"), IST_MON_FRI)).toBe(1);
    expect(workingDaysElapsed(THU_SENT, istMorning("2026-11-22"), IST_MON_FRI)).toBe(1);
    expect(workingDaysElapsed(THU_SENT, istMorning("2026-11-23"), IST_MON_FRI)).toBe(2);
    expect(workingDaysElapsed(THU_SENT, istMorning("2026-11-24"), IST_MON_FRI)).toBe(3);
    expect(workingDaysElapsed(THU_SENT, istMorning("2026-11-25"), IST_MON_FRI)).toBe(4);
  });

  test("Mon-Sat counts the Saturday, so the same invite is a day further along", () => {
    expect(workingDaysElapsed(THU_SENT, istMorning("2026-11-20"), IST_MON_SAT)).toBe(1);
    expect(workingDaysElapsed(THU_SENT, istMorning("2026-11-21"), IST_MON_SAT)).toBe(2);
    expect(workingDaysElapsed(THU_SENT, istMorning("2026-11-22"), IST_MON_SAT)).toBe(2);
    expect(workingDaysElapsed(THU_SENT, istMorning("2026-11-23"), IST_MON_SAT)).toBe(3);
    expect(workingDaysElapsed(THU_SENT, istMorning("2026-11-24"), IST_MON_SAT)).toBe(4);
    expect(workingDaysElapsed(THU_SENT, istMorning("2026-11-25"), IST_MON_SAT)).toBe(5);
  });

  test("the send day is day 0 whatever the time of day, and a late-evening send rolls over at local midnight (not UTC midnight)", () => {
    // 23:30 IST Thursday = 18:00Z Thursday; 00:10 IST Friday = 18:40Z Thursday: still Thursday in UTC.
    const lateThursday = new Date("2026-11-19T18:00:00Z");
    expect(workingDaysElapsed(lateThursday, new Date("2026-11-19T18:20:00Z"), IST_MON_FRI)).toBe(0);
    expect(workingDaysElapsed(lateThursday, new Date("2026-11-19T18:40:00Z"), IST_MON_FRI)).toBe(1);
    // An early-morning send (00:30 IST Thursday = 19:00Z Wednesday) is already Thursday locally.
    const earlyThursday = new Date("2026-11-18T19:00:00Z");
    expect(workingDaysElapsed(earlyThursday, new Date("2026-11-19T18:00:00Z"), IST_MON_FRI)).toBe(0);
    expect(workingDaysElapsed(earlyThursday, new Date("2026-11-20T04:30:00Z"), IST_MON_FRI)).toBe(1);
  });

  test("US daylight-saving week (America/New_York) counts local dates, not 24-hour blocks", () => {
    const newYork = hours("America/New_York", "1,2,3,4,5");
    // Spring forward 2026-03-08. Fri 23:30 EST (Mar 7 04:30Z) -> Mon 00:30 EDT (Mar 9 04:30Z): Sat, Sun, Mon -> 1 working day.
    expect(workingDaysElapsed(new Date("2026-03-07T04:30:00Z"), new Date("2026-03-09T04:30:00Z"), newYork)).toBe(1);
    // Sat 23:30 EST -> Sun 23:30 EDT is 23 hours, still the next local date: Sunday, not a work day.
    expect(workingDaysElapsed(new Date("2026-03-08T04:30:00Z"), new Date("2026-03-09T03:30:00Z"), newYork)).toBe(0);
    // Fall back 2026-11-01. Sat Oct 31 23:30 EDT (Nov 1 03:30Z) -> Mon Nov 2 00:15 EST (Nov 2 05:15Z): Sun, Mon -> 1.
    expect(workingDaysElapsed(new Date("2026-11-01T03:30:00Z"), new Date("2026-11-02T05:15:00Z"), newYork)).toBe(1);
    // Mon-Sat default days in the same week add the Saturday.
    expect(workingDaysElapsed(new Date("2026-03-07T04:30:00Z"), new Date("2026-03-09T04:30:00Z"), hours("America/New_York", null))).toBe(2);
  });

  test("no hours set falls back to Asia/Kolkata and Mon-Sat", () => {
    const none = hours(null, null);
    // Thursday -> next Monday: Fri, Sat, Mon.
    expect(workingDaysElapsed(THU_SENT, istMorning("2026-11-23"), none)).toBe(3);
    // The fallback zone is IST: 00:10 IST Friday (Thursday in UTC) already counts a day.
    expect(workingDaysElapsed(new Date("2026-11-19T18:00:00Z"), new Date("2026-11-19T18:40:00Z"), none)).toBe(1);
  });

  test("an empty or invalid workDays string falls back to Mon-Sat", () => {
    expect(workingDaysElapsed(THU_SENT, istMorning("2026-11-21"), hours("Asia/Kolkata", ""))).toBe(2);
  });

  test("to before from, or the same instant, is 0", () => {
    expect(workingDaysElapsed(istMorning("2026-11-25"), THU_SENT, IST_MON_FRI)).toBe(0);
    expect(workingDaysElapsed(THU_SENT, THU_SENT, IST_MON_FRI)).toBe(0);
  });

  test("a long gap counts every work day (two weeks Mon-Fri = 10)", () => {
    expect(workingDaysElapsed(THU_SENT, istMorning("2026-12-03"), IST_MON_FRI)).toBe(10);
  });
});
