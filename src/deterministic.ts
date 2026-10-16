// Level 3 fallback: zero-LLM deterministic chain.
//
// Fixed order — search → fetch_content → run_web_automation — with a
// code-template summary. No LLM tokens. Used when the Gemini free tier
// is exhausted (see isQuotaError / LLM_QUOTA_EXHAUSTED in llm.ts), so the
// demo still hits all three TinyFish endpoints for the 200-point tier.

import type { BrainResult } from "./llm.js";
import type { Session } from "./session.js";
import { pageVerdict } from "./dates.js";
import { fetch_content, run_web_automation, search } from "./tools.js";

const KNOWN_CITIES = [
  "San Francisco",
  "New York",
  "Los Angeles",
  "Chicago",
  "Seattle",
  "Austin",
  "Boston",
  "London",
  "Berlin",
  "Toronto",
  "Singapore",
  "Remote",
] as const;

const CITY_ALIASES: Record<string, string> = {
  SF: "San Francisco",
  NYC: "New York",
  LA: "Los Angeles",
};

export interface ParsedSlots {
  city?: string;
  dateWindow?: string;
  maxPrice?: string;
  wantsRegister?: boolean;
}

/** Regex slot parser (no LLM). Exported for smoke tests. */
export function parseSlots(text: string): ParsedSlots {
  const slots: ParsedSlots = {};

  for (const c of KNOWN_CITIES) {
    if (new RegExp(`\\b${c.replace(/ /g, "\\s+")}\\b`, "i").test(text)) {
      slots.city = c;
      break;
    }
  }
  if (!slots.city) {
    for (const [alias, full] of Object.entries(CITY_ALIASES)) {
      if (new RegExp(`\\b${alias}\\b`, "i").test(text)) {
        slots.city = full;
        break;
      }
    }
  }
  if (!slots.city) {
    const m = /\bin\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/.exec(text);
    if (m?.[1]) slots.city = m[1];
  }

  const date = /next month|this month|next weekend|this weekend|next week|this week|tomorrow|next \d+ days/i.exec(text)?.[0];
  if (date) slots.dateWindow = date.toLowerCase();

  const price = /under\s*\$?(\d+)/i.exec(text)?.[1];
  if (price) slots.maxPrice = `$${price}`;
  else if (/\bfree\b/i.test(text)) slots.maxPrice = "free";

  if (/regist|sign.?up|\bjoin\b|rsvp/i.test(text)) slots.wantsRegister = true;

  return slots;
}

function firstLine(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= n ? one : `${one.slice(0, n)}…`;
}

/** Structured registration summary. Reads output_schema keys first
 * (event_name/date/fee/deadline/registration_fields/registration_url),
 * falls back to best-effort regex for free-form results. Exported for tests. */
export function summarizeAutomation(result: unknown): string {
  const r = (result ?? {}) as Record<string, unknown>;
  const inner = (r.result as Record<string, unknown> | undefined) ?? r;
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const fields = Array.isArray(inner.registration_fields)
    ? inner.registration_fields.map(String).filter(Boolean)
    : [];
  const bits: string[] = [];
  const name = str(inner.event_name);
  if (name) bits.push(name);
  const date = str(inner.date);
  if (date) bits.push(date);
  if (fields.length > 0) bits.push(`${fields.length} form fields`);
  const fee = str(inner.fee);
  if (fee) bits.push(`fee: ${fee}`);
  const deadline = str(inner.deadline);
  if (deadline) bits.push(`deadline: ${deadline}`);
  if (bits.length > 0) {
    return `Registration: ${bits.join(", ")}`;
  }
  // Legacy fallback: regex over stringified free-form JSON.
  const s = JSON.stringify(result ?? {});
  const feeRx = /"?(?:fee|price|cost|ticket price)"?\s*[:=]\s*"?([^",}]{1,40})/i.exec(s)?.[1]?.trim();
  const dlRx = /"?(?:deadline|registration.?deadline|closes|apply by)"?\s*[:=]\s*"?([^",}]{1,40})/i.exec(s)?.[1]?.trim();
  const parts: string[] = ["Registration page checked"];
  if (feeRx) parts.push(`fee: ${feeRx}`);
  if (dlRx) parts.push(`deadline: ${dlRx}`);
  return parts.length > 1 ? parts.join(", ") : "Registration page checked — open the link for the form.";
}

export async function runDeterministic(session: Session, userText: string): Promise<BrainResult> {
  const parsed = parseSlots(userText);
  if (parsed.city) session.slots.city = parsed.city;
  if (parsed.dateWindow) session.slots.dateWindow = parsed.dateWindow;
  if (parsed.maxPrice) session.slots.maxPrice = parsed.maxPrice;
  if (parsed.wantsRegister) session.slots.wantsRegister = true;

  const { city, dateWindow, maxPrice } = session.slots;
  if (!city) {
    return { text: "Which city should I search? (e.g. SF, New York, Remote)", urls: [], toolsUsed: [], options: [] };
  }

  const datePart = dateWindow ?? "next month";
  const pricePart = maxPrice ? ` ${maxPrice}` : "";
  // Upcoming-biased phrasing (no Agent needed — date filtering is data-level).
  // NOTE: no after_date — server-side date filtering keys off page publish
  // date and empties results (verified: 10 hits → 0), hiding upcoming events
  // on older pages. Past-event requests are honored by phrasing instead.
  const wantsPast = /past|previous|archive|last year/i.test(userText);
  const query = `AI hackathon ${city} ${datePart}${pricePart} ${wantsPast ? "past" : "upcoming"}`.trim();
  console.log(`[deterministic] no-LLM chain, query=${JSON.stringify(query)}`);

  const s = await search({
    query,
    location: "US",
    purpose: "Find hackathons/events to join (deterministic fallback)",
  });
  let hits = s.results.filter((r) => r.url.startsWith("http")).slice(0, 5);
  if (hits.length === 0) {
    return { text: `No results for "${query}" — try another city or broader dates.`, urls: [], toolsUsed: ["search"], options: [] };
  }

  const f = await fetch_content({
    urls: hits.map((h) => h.url),
    purpose: "Extract dates, fees, deadlines (deterministic fallback)",
  });
  const toolsUsed = ["search", "fetch_content"];

  // Code-enforced date gate: drop past-only pages unless past was requested.
  // "unknown" pages are kept — never exclude on missing dates.
  if (!wantsPast) {
    const before = hits.length;
    hits = hits.filter((h) => {
      const page = f.pages.find((p) => p.url === h.url);
      const verdict = pageVerdict(`${h.title} ${h.snippet} ${page?.text ?? ""}`);
      return verdict !== "past-only";
    }).slice(0, 3);
    console.log(`[dates] deterministic: kept ${hits.length}/${before} (dropped past-only)`);
    if (hits.length === 0) {
      return {
        text: `Everything I found for "${query}" looks like past editions. Try broader dates or ask for past events explicitly.`,
        urls: [],
        toolsUsed,
        options: [],
      };
    }
  } else {
    hits = hits.slice(0, 3);
  }

  let regNote = "Registration check skipped (no listing page).";
  const firstUrl = hits[0]?.url;
  if (firstUrl) {
    try {
      const a = await run_web_automation({
        url: firstUrl,
        goal: `Extract event name, date, price/fee and registration form fields with deadline as JSON. Read-only; do not submit. Context: ${query}.`,
      });
      toolsUsed.push("run_web_automation");
      regNote = summarizeAutomation(a.result);
      if (a.timedOut) regNote = `Checked what I could in time — ${regNote.charAt(0).toLowerCase()}${regNote.slice(1)}`;
    } catch (err) {
      regNote = `Registration check was blocked (${err instanceof Error ? firstLine(err.message, 80) : "error"}) — details below are from event pages.`;
    }
  }

  const lines = hits.map((h, i) => {
    const page = f.pages.find((p) => p.url === h.url);
    const detail = page ? firstLine(page.text, 110) : firstLine(h.snippet, 110);
    return `${i + 1}. ${firstLine(h.title || h.url, 80)}\n${detail}`;
  });
  const text = `Top ${hits.length} in ${city} (${datePart}${pricePart}):\n${lines.join("\n")}\n${regNote} Reply YES to draft registration.`;
  const options = hits.map((h) => ({ title: h.title || h.url, url: h.url }));
  return { text, urls: hits.map((h) => h.url), toolsUsed, options };
}
