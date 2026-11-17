/**
 * The chat's name from WhatsApp Web's chat header text (its innerText). A
 * contact without a profile photo has a letter avatar ("A") as the header's
 * first line; read as the title, it made the lead's chat look like another
 * one, and the first call after saving a lead as a contact was never dialed
 * (17 Nov 2026). Kept import-free so it can be tested.
 */
export function headerTitle(text: string): string | null {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => !/^\p{L}{1,2}$/u.test(line)) ?? lines[0] ?? null;
}
