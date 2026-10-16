// Chunk long replies into iMessage-friendly bubbles (≤3 messages).

import { richlink } from "spectrum-ts";

export const MAX_BUBBLES = 3;
export const MAX_CHARS_PER_BUBBLE = 900;

export function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > 0 && chunks.length < MAX_BUBBLES) {
    if (rest.length <= MAX_CHARS_PER_BUBBLE) {
      chunks.push(rest);
      break;
    }
    if (chunks.length === MAX_BUBBLES - 1) {
      // Last bubble: hard-cap so no single iMessage exceeds the limit.
      chunks.push(`${rest.slice(0, MAX_CHARS_PER_BUBBLE - 32).trimEnd()}…[continued on linked pages]`);
      break;
    }
    const cut = rest.lastIndexOf("\n", MAX_CHARS_PER_BUBBLE);
    const at = cut > 200 ? cut : MAX_CHARS_PER_BUBBLE;
    chunks.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  return chunks;
}

/** Build sendable items: text bubbles + one richlink per URL (deduped). Send sequentially. */
export function buildReplyItems(summary: string, urls: string[]): Array<string | ReturnType<typeof richlink>> {
  const items: Array<string | ReturnType<typeof richlink>> = [];
  for (const c of chunkText(summary)) items.push(c);
  const seen = new Set<string>();
  for (const u of urls) {
    if (!u.startsWith("http") || seen.has(u)) continue;
    seen.add(u);
    if (items.length >= MAX_BUBBLES + 3) break; // cap links
    items.push(richlink(u));
  }
  return items;
}
