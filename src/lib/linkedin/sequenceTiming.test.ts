import { describe, expect, test } from "bun:test";
import {
  DAY_MS,
  DEFAULT_SEQUENCE_DELAYS,
  acceptanceDecision,
  dueAt,
  isDelayElapsed,
  parseSequenceDelays,
  shouldDeferAcceptance,
  withDefaultDelays,
} from "./sequenceTiming";

const NOW = new Date("2026-11-20T12:00:00Z");
const ago = (days: number, extraMs = 0) => new Date(NOW.getTime() - days * DAY_MS - extraMs);

describe("default delays", () => {
  test("are the old 24 / 48 / 72 hour gaps, a 4 day fourth gap and an immediate acceptance", () => {
    expect(DEFAULT_SEQUENCE_DELAYS).toEqual({
      acceptanceDelayDays: 0,
      followUp1DelayDays: 1,
      followUp2DelayDays: 2,
      followUp3DelayDays: 3,
      followUp4DelayDays: 4,
    });
    expect(DEFAULT_SEQUENCE_DELAYS.followUp1DelayDays * 24).toBe(24);
    expect(DEFAULT_SEQUENCE_DELAYS.followUp2DelayDays * 24).toBe(48);
    expect(DEFAULT_SEQUENCE_DELAYS.followUp3DelayDays * 24).toBe(72);
  });

  test("withDefaultDelays fills only what is missing", () => {
    expect(withDefaultDelays(null)).toEqual(DEFAULT_SEQUENCE_DELAYS);
    expect(withDefaultDelays({ followUp2DelayDays: 4, followUp3DelayDays: null })).toEqual({ ...DEFAULT_SEQUENCE_DELAYS, followUp2DelayDays: 4 });
  });
});

describe("parseSequenceDelays", () => {
  test("accepts values on the bounds and leaves absent fields out", () => {
    expect(parseSequenceDelays({})).toEqual({ ok: true, delays: {} });
    expect(parseSequenceDelays({ acceptanceDelayDays: 0, followUp1DelayDays: 1, followUp4DelayDays: 60 })).toEqual({
      ok: true,
      delays: { acceptanceDelayDays: 0, followUp1DelayDays: 1, followUp4DelayDays: 60 },
    });
    expect(parseSequenceDelays({ acceptanceDelayDays: 30, followUp2DelayDays: "7" })).toEqual({
      ok: true,
      delays: { acceptanceDelayDays: 30, followUp2DelayDays: 7 },
    });
  });

  test("rejects out-of-range, fractional and non-numeric values", () => {
    for (const body of [
      { acceptanceDelayDays: 31 },
      { acceptanceDelayDays: -1 },
      { followUp1DelayDays: 0 },
      { followUp3DelayDays: 61 },
      { followUp4DelayDays: 0 },
      { followUp2DelayDays: 2.5 },
      { followUp2DelayDays: "soon" },
      { followUp2DelayDays: true },
    ]) {
      expect(parseSequenceDelays(body).ok).toBe(false);
    }
  });
});

describe("isDelayElapsed and dueAt", () => {
  test("a step is due exactly when its whole days have passed", () => {
    expect(isDelayElapsed(ago(1), 1, NOW)).toBe(true);
    expect(isDelayElapsed(ago(1, -1), 1, NOW)).toBe(false);
    expect(isDelayElapsed(ago(3), 4, NOW)).toBe(false);
    expect(isDelayElapsed(null, 1, NOW)).toBe(false);
    expect(dueAt(ago(0), 4)?.getTime()).toBe(NOW.getTime() + 4 * DAY_MS);
    expect(dueAt(null, 4)).toBeNull();
  });

  test("the defaults give 24 / 48 / 72 hours", () => {
    const hours = (h: number) => new Date(NOW.getTime() - h * 3600_000);
    expect(isDelayElapsed(hours(24), DEFAULT_SEQUENCE_DELAYS.followUp1DelayDays, NOW)).toBe(true);
    expect(isDelayElapsed(hours(23.9), DEFAULT_SEQUENCE_DELAYS.followUp1DelayDays, NOW)).toBe(false);
    expect(isDelayElapsed(hours(48), DEFAULT_SEQUENCE_DELAYS.followUp2DelayDays, NOW)).toBe(true);
    expect(isDelayElapsed(hours(47.9), DEFAULT_SEQUENCE_DELAYS.followUp2DelayDays, NOW)).toBe(false);
    expect(isDelayElapsed(hours(72), DEFAULT_SEQUENCE_DELAYS.followUp3DelayDays, NOW)).toBe(true);
    expect(isDelayElapsed(hours(71.9), DEFAULT_SEQUENCE_DELAYS.followUp3DelayDays, NOW)).toBe(false);
  });

  test("the lender flow lands at +1, +4, +8, +12 and +19 days after the accept", () => {
    const delays = { acceptanceDelayDays: 1, followUp1DelayDays: 3, followUp2DelayDays: 4, followUp3DelayDays: 4, followUp4DelayDays: 7 };
    const accepted = NOW;
    const acceptance = dueAt(accepted, delays.acceptanceDelayDays)!;
    const followUp1 = dueAt(acceptance, delays.followUp1DelayDays)!;
    const followUp2 = dueAt(followUp1, delays.followUp2DelayDays)!;
    const followUp3 = dueAt(followUp2, delays.followUp3DelayDays)!;
    const followUp4 = dueAt(followUp3, delays.followUp4DelayDays)!;
    expect([acceptance, followUp1, followUp2, followUp3, followUp4].map((d) => (d.getTime() - accepted.getTime()) / DAY_MS)).toEqual([1, 4, 8, 12, 19]);
  });
});

describe("shouldDeferAcceptance", () => {
  test("a delay of 0 never defers, whatever the dates are", () => {
    expect(shouldDeferAcceptance(NOW, 0, NOW)).toBe(false);
    expect(shouldDeferAcceptance(ago(0), 0, NOW)).toBe(false);
    expect(shouldDeferAcceptance(null, 0, NOW)).toBe(false);
  });

  test("defers while connectedAt + delay is still in the future", () => {
    expect(shouldDeferAcceptance(NOW, 1, NOW)).toBe(true);
    expect(shouldDeferAcceptance(ago(0, 3600_000), 1, NOW)).toBe(true);
    expect(shouldDeferAcceptance(ago(1, -1), 1, NOW)).toBe(true);
  });

  test("sends once the delay has passed (a CONNECTED lead past its delay is due)", () => {
    expect(shouldDeferAcceptance(ago(1), 1, NOW)).toBe(false);
    expect(shouldDeferAcceptance(ago(2), 1, NOW)).toBe(false);
    expect(shouldDeferAcceptance(ago(30), 30, NOW)).toBe(false);
  });

  test("an unknown accept time does not defer", () => {
    expect(shouldDeferAcceptance(null, 5, NOW)).toBe(false);
  });
});

describe("acceptanceDecision", () => {
  test("no delay always sends, whatever the status", () => {
    expect(acceptanceDecision({ status: "REQUEST_SENT" }, 0, NOW)).toBe("send");
    expect(acceptanceDecision({ status: "CONNECTED", acceptedAt: NOW }, 0, NOW)).toBe("send");
  });

  test("a REQUEST_SENT lead with a delay is parked at the moment of the accept, however old its Connection row is", () => {
    expect(acceptanceDecision({ status: "REQUEST_SENT", acceptedAt: null }, 1, NOW)).toBe("park");
    expect(acceptanceDecision({ status: "REQUEST_SENT", acceptedAt: ago(40) }, 1, NOW)).toBe("park");
  });

  test("a CONNECTED lead waits until acceptedAt plus the delay, then sends", () => {
    expect(acceptanceDecision({ status: "CONNECTED", acceptedAt: ago(0, 3600_000) }, 1, NOW)).toBe("wait");
    expect(acceptanceDecision({ status: "CONNECTED", acceptedAt: ago(1) }, 1, NOW)).toBe("send");
    expect(acceptanceDecision({ status: "CONNECTED", acceptedAt: ago(2) }, 1, NOW)).toBe("send");
  });

  test("a CONNECTED lead whose campaign delay was set back to 0 sends, and one with no acceptedAt is not stranded", () => {
    expect(acceptanceDecision({ status: "CONNECTED", acceptedAt: NOW }, 0, NOW)).toBe("send");
    expect(acceptanceDecision({ status: "CONNECTED", acceptedAt: null }, 3, NOW)).toBe("send");
  });
});
