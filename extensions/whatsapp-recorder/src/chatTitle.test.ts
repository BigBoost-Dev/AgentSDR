import { describe, expect, test } from "bun:test";
import { headerTitle } from "./chatTitle";

describe("headerTitle", () => {
  test("skips a letter avatar before the name", () => {
    expect(headerTitle("A\nAgnim (Amrutam)\nclick here for contact info")).toBe("Agnim (Amrutam)");
    expect(headerTitle("AG\nAgnim (Amrutam)")).toBe("Agnim (Amrutam)");
  });
  test("a bare number, or a name, is the title", () => {
    expect(headerTitle("+91 95384 62381\nonline")).toBe("+91 95384 62381");
    expect(headerTitle("  Riya Sharma \n")).toBe("Riya Sharma");
  });
  test("only an initial: that is all there is", () => {
    expect(headerTitle("A")).toBe("A");
    expect(headerTitle("")).toBeNull();
  });
});
