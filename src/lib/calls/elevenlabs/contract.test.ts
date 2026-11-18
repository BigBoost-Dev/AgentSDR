import { describe, expect, test } from "bun:test";
import { accentFlag, elevenLabsVoiceLabel } from "./contract";

describe("accentFlag", () => {
  test("a known accent gets its country's flag, case-insensitively", () => {
    expect(accentFlag("indian")).toBe("🇮🇳");
    expect(accentFlag("British")).toBe("🇬🇧");
  });
  test("no accent, or one not listed: a globe", () => {
    expect(accentFlag(null)).toBe("🌐");
    expect(accentFlag("martian")).toBe("🌐");
  });
});

test("elevenLabsVoiceLabel: flag, name, details", () => {
  expect(elevenLabsVoiceLabel({ id: "x", name: "Monika", detail: "female · young", previewUrl: null, accent: "indian" })).toBe("🇮🇳 Monika · female · young");
  expect(elevenLabsVoiceLabel({ id: "x", name: "Sam", detail: "", previewUrl: null, accent: null })).toBe("🌐 Sam");
});
