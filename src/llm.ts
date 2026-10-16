// LLM brain: Gemini Flash with generic TinyFish tools bound.
//
// The LLM decides what to call. Tools mirror TinyFish MCP schemas
// (search / fetch_content / run_web_automation) but execute as local
// functions wrapping TinyFish REST (see tools.ts).

import { GoogleGenAI, Type } from "@google/genai";
import { pageVerdict } from "./dates.js";
import { fetch_content, run_web_automation, search } from "./tools.js";
import type { Session } from "./session.js";

const MAX_STEPS = 5;

const SYSTEM = `You are a concise iMessage assistant that finds hackathons/tech events (or internships, tickets, gigs) via web tools.
STAGED PROTOCOL — one stage per turn, always wait for the user before advancing:
1. SEARCH: on a new request, call search (slot-fill city/dates/budget first with ONE clarifying question if missing; events can be online, so ask in-person vs online if unclear, and accept "any"). Present results as a NUMBERED list (max 5, short titles) and ask "Which one do you want to know more about? (reply with the number or name)".
2. DETAILS: when the user picks (number, name, or URL — resolve against the numbered options in context), call fetch_content on the picked URL(s) only. Present date/price/deadline/requirements briefly and ask "Want me to check the registration for this one?".
3. REG CHECK: on yes, call run_web_automation on the picked page (goal: read the registration section as JSON — fields, fee, deadline, manual registration URL). Report the fields to prepare + the manual link. Ask "Want me to fill it in for you?".
4. COLLECT: if yes AND the page needs no login/sign-in wall, ask for the field values in ONE message (list each field). If a login/OAuth wall is required, STOP: give the manual link + checklist instead, never ask for passwords.
5. CONFIRM: when values arrive, ECHO THEM ALL BACK and ask for explicit confirmation with the word SUBMIT. NEVER submit on the same turn the values arrive.
6. SUBMIT: only when the user replies SUBMIT (exact), call run_web_automation with the values embedded in the goal to fill and submit the form, then report success/failure honestly.
Rules:
- Registration values live only in this session (never stored elsewhere); never ask for or handle passwords or OTP codes.
- Upcoming events only: bias the query with "upcoming" + month/year terms and drop any event whose fetched date has passed. Respect dateCheck verdicts in tool results: never present or pick past-only pages unless the user explicitly asked for past ones; unknown pages are fine. Do NOT rely on after_date (it filters by page publish date and hides upcoming events on older pages — verified). Past/archived events only if the user explicitly asks for past ones.
- run_web_automation is read-only until stage 6 (explicit SUBMIT).
- Final texts stay under 700 characters. No markdown tables. Links are appended automatically — always number your options.
- Note: Event can be online so there could be no city but ask questions whether the event should be in-person or online. If the user says "any" or "doesn't matter", assume online is fine. 
- Events can also be online-only.`

const declarations = [
  {
    name: "search",
    description: "Search the web for ranked results (titles, snippets, URLs). Use before fetching.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: "Search keywords, e.g. 'AI hackathon San Francisco November 2026 under $50'" },
        location: { type: Type.STRING, description: "Country code, e.g. US" },
        language: { type: Type.STRING, description: "Language code, e.g. en" },
        purpose: { type: Type.STRING, description: "Why you are searching" },
        recency_minutes: { type: Type.NUMBER, description: "Freshness window in minutes" },
        after_date: { type: Type.STRING, description: "Earliest date YYYY-MM-DD. Unreliable for event discovery (keys off page publish date) — prefer upcoming-biased query terms and date-check fetched content" },
        before_date: { type: Type.STRING, description: "Latest date YYYY-MM-DD" },
        page: { type: Type.NUMBER, description: "0-indexed page 0-10" },
      },
      required: ["query"],
    },
  },
  {
    name: "fetch_content",
    description: "Extract full text/requirements/deadlines from up to 3 page URLs.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        urls: { type: Type.ARRAY, items: { type: Type.STRING }, description: "1-3 page URLs from search" },
        format: { type: Type.STRING, description: "markdown (default), html, or json" },
        purpose: { type: Type.STRING, description: "Why you are fetching" },
      },
      required: ["urls"],
    },
  },
  {
    name: "run_web_automation",
    description: "Multi-step web action: filter a listing page, read a registration section, or (only after the user's explicit SUBMIT confirmation, with field values embedded in the goal) fill and submit a registration form. Returns structured JSON (event_name/date/fee/deadline/registration_fields/registration_url). May return partial data with timedOut=true on slow pages — still summarize what you got.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: { type: Type.STRING, description: "Listing or event page URL" },
        goal: { type: Type.STRING, description: "Plain-English goal, e.g. 'Filter AI hackathons under $50 and extract name/date/price/registration fields as JSON'" },
      },
      required: ["url", "goal"],
    },
  },
];

export interface BrainResult {
  text: string;
  urls: string[];
  toolsUsed: string[];
  /** Numbered options presented this turn (for pick resolution next turn). */
  options: Array<{ title: string; url: string }>;
}

// --- Level 1 fallback: quota detection + retry + model rotation ---

export const LLM_QUOTA_EXHAUSTED = "LLM_QUOTA_EXHAUSTED";
export const LLM_UNAVAILABLE = "LLM_UNAVAILABLE";

/** True for rate-limit / free-tier-exhausted errors (retryable via backoff or model rotation). */
export function isQuotaError(err: unknown): boolean {
  const status =
    (err as { status?: unknown })?.status ?? (err as { code?: unknown })?.code;
  if (status === 429 || status === "RESOURCE_EXHAUSTED") return true;
  const msg =
    err instanceof Error
      ? `${err.message} ${String((err as { code?: unknown }).code ?? "")}`
      : String(err);
  return /resource.exhausted|quota|rate.?limit|exhausted|too many requests|\b429\b/i.test(msg);
}

/** True for transient server-side failures worth retrying (overload, 5xx, timeouts). */
export function isTransientError(err: unknown): boolean {
  const status =
    (err as { status?: unknown })?.status ?? (err as { code?: unknown })?.code;
  if (status === 500 || status === 503 || status === "UNAVAILABLE" || status === "INTERNAL") return true;
  const msg =
    err instanceof Error
      ? `${err.message} ${String((err as { code?: unknown }).code ?? "")}`
      : String(err);
  return /unavailable|internal error|high demand|overloaded|try again later|timeout|timed out|fetch failed|socket hang up|econnreset|\b50[03]\b/i.test(msg);
}

/** Any brain failure the deterministic chain can cover: quota, transient, or coded exhaustion. */
export function isFallbackError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === LLM_QUOTA_EXHAUSTED || code === LLM_UNAVAILABLE || isQuotaError(err) || isTransientError(err);
}

/** Primary model first, then fallback (quotas are per-model, so rotation often works). */
function modelsToTry(): string[] {
  const primary = process.env.GEMINI_MODEL ?? "gemini-2.0-flash";
  const fallback =
    process.env.GEMINI_FALLBACK_MODEL ??
    (primary === "gemini-2.0-flash" ? "gemini-2.5-flash-lite" : "gemini-2.0-flash");
  return [...new Set([primary, fallback])];
}

function quotaExhaustedError(models: string[], lastErr: unknown, sawQuota: boolean): Error {
  const detail = lastErr instanceof Error ? lastErr.message : String(lastErr);
  const e = new Error(
    sawQuota
      ? `LLM quota exhausted on ${models.join(", ")} (${detail.slice(0, 200)}). Deterministic fallback available.`
      : `LLM unavailable on ${models.join(", ")} (${detail.slice(0, 200)}). Deterministic fallback available.`,
  );
  (e as { code?: string }).code = sawQuota ? LLM_QUOTA_EXHAUSTED : LLM_UNAVAILABLE;
  return e;
}

function gemini(): { ai: GoogleGenAI; models: string[] } {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY — put it in .env (see .env.example). Get one at https://aistudio.google.com/app/apikey");
  return { ai: new GoogleGenAI({ apiKey }), models: modelsToTry() };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function llmTimeoutMs(): number {
  return Number(process.env.LLM_TIMEOUT_MS ?? 60_000);
}

/** Race a promise against a timeout so a hanging model fails fast (e.g. bad GEMINI_MODEL). */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms (check GEMINI_MODEL)`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

interface GenResult {
  text?: string;
  functionCalls?: Array<{ name?: string; args?: Record<string, unknown> }>;
  candidates?: Array<{ content?: { parts?: Array<Record<string, unknown>> } }>;
}

/** Build the model-turn parts by echoing the raw candidate parts verbatim.
// Thinking models attach `thoughtSignature` to functionCall parts and the API
// rejects the next turn (400 INVALID_ARGUMENT) if it is missing —
// reconstructing {functionCall:{name,args}} by hand drops it. Falls back to
// reconstruction only when raw parts are absent. */
export function modelTurnParts(
  res: GenResult,
  calls: NonNullable<GenResult["functionCalls"]>,
): Array<Record<string, unknown>> {
  const raw = res.candidates?.[0]?.content?.parts;
  if (raw && raw.length > 0) return raw;
  return calls.map((c) => ({ functionCall: { name: c.name, args: c.args ?? {} } }));
}

/** One generateContent call with timeout, backoff retries + fallback-model rotation. */
async function generateWithFallback(
  ai: GoogleGenAI,
  models: string[],
  contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>,
  config: Record<string, unknown>,
): Promise<GenResult> {
  const timeoutMs = llmTimeoutMs();
  let lastErr: unknown = null;
  let sawQuota = false;
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const req = ai.models.generateContent({
          model,
          contents: contents as never,
          config: config as never,
        } as never) as unknown as Promise<GenResult>;
        return await withTimeout(req, timeoutMs, `generateContent ${model}`);
      } catch (err) {
        const quota = isQuotaError(err);
        if (!quota && !isTransientError(err)) throw err;
        if (quota) sawQuota = true;
        lastErr = err;
        const wait = 1000 * (attempt + 1);
        const kind = quota ? "quota hit" : "transient error";
        console.log(`[llm] ${kind} on ${model} (attempt ${attempt + 1}/2), retrying in ${wait}ms...`);
        await sleep(wait);
      }
    }
    console.log(`[llm] ${model} still failing, falling back...`);
  }
  throw quotaExhaustedError(models, lastErr, sawQuota);
}

/** B-roll log: how the date gate classified each result. */
function logVerdicts(tool: string, checks: Array<{ url: string; verdict: string }>): void {
  const past = checks.filter((c) => c.verdict === "past-only").length;
  const future = checks.filter((c) => c.verdict === "future").length;
  console.log(`[dates] ${tool}: ${future} future, ${past} past-only, ${checks.length - future - past} unknown`);
}

async function executeTool(name: string, args: Record<string, unknown>): Promise<{ result: unknown; urls: string[] }> {  if (name === "search") {
    const out = await search({
      query: String(args.query ?? ""),
      location: args.location as string | undefined,
      language: args.language as string | undefined,
      purpose: args.purpose as string | undefined,
      recency_minutes: args.recency_minutes as number | undefined,
      after_date: args.after_date as string | undefined,
      before_date: args.before_date as string | undefined,
    });
    const dateCheck = out.results.map((r) => ({ url: r.url, verdict: pageVerdict(`${r.title} ${r.snippet}`) }));
    logVerdicts("search", dateCheck);
    return { result: { ...out, dateCheck }, urls: out.results.map((r) => r.url) };
  }
  if (name === "fetch_content") {
    const out = await fetch_content({
      urls: (Array.isArray(args.urls) ? args.urls : []).map(String),
      format: (args.format as "markdown" | "html" | "json" | undefined) ?? "markdown",
      purpose: args.purpose as string | undefined,
    });
    const dateCheck = out.pages.map((p) => ({ url: p.url, verdict: pageVerdict(`${p.title} ${p.text}`) }));
    logVerdicts("fetch_content", dateCheck);
    return { result: { ...out, dateCheck }, urls: out.pages.map((p) => p.url) };
  }
  if (name === "run_web_automation") {
    const out = await run_web_automation({
      url: String(args.url ?? ""),
      goal: String(args.goal ?? "Extract event details and registration fields as JSON. Read-only; do not submit."),
    });
    // tools.ts already polls to a terminal status or our client deadline.
    const result = { runId: out.runId, status: out.status, timedOut: out.timedOut, result: out.result };
    if (out.timedOut) {
      console.log(`[llm] automation hit client deadline — summarizing partial status=${out.status}`);
    }
    return { result, urls: [String(args.url ?? "")] };
  }
  throw new Error(`Unknown tool: ${name}`);
}

export async function runBrain(session: Session, userText: string): Promise<BrainResult> {
  // Test hook: simulate free-tier exhaustion WITHOUT burning real quota.
  // Only active when SIMULATE_QUOTA_EXHAUSTION=1 is explicitly set (dev only).
  if (process.env.SIMULATE_QUOTA_EXHAUSTION === "1") {
    console.log("[llm] SIMULATE_QUOTA_EXHAUSTION=1 — synthetic quota error, no API called");
    throw quotaExhaustedError(modelsToTry(), new Error("Simulated 429 RESOURCE_EXHAUSTED (no real quota consumed)"), true);
  }
  const { ai, models } = gemini();
  const toolsUsed: string[] = [];
  const linkPool: string[] = [];
  const optionPool = new Map<string, string>(); // url -> title
  const trackOptions = (items: Array<{ title?: string; url?: string }>): void => {
    for (const it of items.slice(0, 5)) {
      const url = String(it.url ?? "");
      if (url.startsWith("http") && !optionPool.has(url)) {
        optionPool.set(url, String(it.title ?? url).trim() || url);
      }
    }
  };
  const optionsOf = (): Array<{ title: string; url: string }> =>
    [...optionPool.entries()].slice(0, 5).map(([url, title]) => ({ title, url }));

  // Ground pick resolution ("2", names) in this session's known options/slots.
  const today = new Date().toISOString().slice(0, 10);
  const ctx: string[] = [`Today is ${today}.`];
  if (session.slots.city ?? session.slots.dateWindow ?? session.slots.maxPrice) {
    ctx.push(
      `Known slots: city=${session.slots.city ?? "-"} dates=${session.slots.dateWindow ?? "-"} budget=${session.slots.maxPrice ?? "-"} picked=${session.slots.pickedUrl ?? "-"}`,
    );
  }
  ctx.push(`Pipeline stage: ${session.stage}`);
  if (session.lastOptions.length > 0) {
    ctx.push(`Numbered options from last turn:\n${session.lastOptions.map((o, i) => `${i + 1}. ${o.title} — ${o.url}`).join("\n")}`);
  }
  const regKeys = Object.keys(session.regValues);
  if (regKeys.length > 0) ctx.push(`Registration values already collected: ${regKeys.join(", ")}`);
  const config = {
    systemInstruction: `${SYSTEM}\n\n[Session context]\n${ctx.join("\n")}`,
    tools: [{ functionDeclarations: declarations as never }],
  };

  const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];
  for (const h of session.history.slice(-8)) {
    contents.push({ role: h.role === "assistant" ? "model" : "user", parts: [{ text: h.text }] });
  }
  contents.push({ role: "user", parts: [{ text: userText }] });

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await generateWithFallback(ai, models, contents, config);

    const calls = res.functionCalls ?? [];
    if (calls.length === 0) {
      const text = (res.text ?? "").trim() || "Sorry — I didn't catch that. Which city and dates should I search?";
      return { text, urls: [...new Set(linkPool)].slice(0, 3), toolsUsed, options: optionsOf() };
    }

    // Reflect the model's tool-call turn verbatim (keeps thoughtSignature),
    // then append each tool result.
    contents.push({ role: "model", parts: modelTurnParts(res, calls) });
    for (const c of calls) {
      const name = String(c.name ?? "");
      toolsUsed.push(name);
      console.log(`[llm] calling ${name} (step ${step + 1})`);
      try {
        const { result, urls } = await executeTool(name, c.args ?? {});
        for (const u of urls) if (u.startsWith("http")) linkPool.push(u);
        if (name === "search") {
          trackOptions(((result as { results?: Array<{ title?: string; url?: string }> }).results ?? []) as Array<{ title?: string; url?: string }>);
        }
        if (name === "fetch_content") {
          trackOptions(((result as { pages?: Array<{ title?: string; url?: string }> }).pages ?? []) as Array<{ title?: string; url?: string }>);
        }
        contents.push({ role: "user", parts: [{ functionResponse: { name, response: { result: result as object } } }] });
      } catch (err) {
        contents.push({
          role: "user",
          parts: [{ functionResponse: { name, response: { error: err instanceof Error ? err.message : String(err) } } }],
        });
      }
    }
  }

  return {
    text: "I ran out of steps — try narrowing by city and budget (e.g. 'SF next month under $50').",
    urls: [...new Set(linkPool)].slice(0, 3),
    toolsUsed,
    options: optionsOf(),
  };
}
