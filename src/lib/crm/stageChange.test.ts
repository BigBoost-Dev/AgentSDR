import { describe, expect, test } from "bun:test";
import { defaultStageChangeNext, stageChangeRoute } from "./stageChange";

describe("stage change routing", () => {
  test("an unresolved classification is corrected", () => {
    expect(stageChangeRoute(null)).toBe("correction");
    expect(stageChangeRoute("proposed")).toBe("correction");
    expect(stageChangeRoute("failed")).toBe("correction");
  });

  test("a resolved classification stays and the stage is moved", () => {
    for (const status of ["auto_applied", "accepted", "overridden", "rejected", "stale"]) {
      expect(stageChangeRoute(status)).toBe("move");
    }
  });

  test("the default next step follows whether the reply was answered", () => {
    expect(defaultStageChangeNext(false)).toBe("reply");
    expect(defaultStageChangeNext(true)).toBe("follow_up");
  });
});
