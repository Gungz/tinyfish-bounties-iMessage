// Generic TinyFish tools mirroring the MCP tool schemas.
//
// Tool names + params intentionally match TinyFish MCP
// (`search` / `fetch_content` / `run_web_automation` + `get_run`) so the
// agent can be narrated as "MCP-compatible" and swapped to a real MCP
// client later with a one-file change. At runtime these call TinyFish
// REST directly via @tiny-fish/sdk (no MCP transport overhead).
//
// Canonical endpoints:
//   search             -> GET  https://api.search.tinyfish.ai
//   fetch_content      -> POST https://api.fetch.tinyfish.ai
//   run_web_automation -> POST https://agent.tinyfish.ai/v1/automation/...

import { TinyFish } from "@tiny-fish/sdk";

const MAX_SNIPPET = 500;
const MAX_PAGE_CHARS = 4000;
const MAX_URLS_PER_FETCH = 3;

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…[truncated]";
}

function apiKey(): string {
  const k = process.env.TINYFISH_API_KEY;
  if (!k) throw new Error("Missing TINYFISH_API_KEY — put it in .env (see .env.example).");
  return k;
}

let client: TinyFish | undefined;
function getClient(): TinyFish {
  if (!client) {
    apiKey(); // validates presence; SDK reads TINYFISH_API_KEY from env
    client = new TinyFish();
  }
  return client;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchOutput {
  results: SearchHit[];
  elapsedMs: number;
}

export interface SearchArgs {
  query: string;
  location?: string;
  language?: string;
  purpose?: string;
  recency_minutes?: number;
  /** Earliest date YYYY-MM-DD (e.g. today for upcoming-only). */
  after_date?: string;
  /** Latest date YYYY-MM-DD. */
  before_date?: string;
  page?: number;
}

// search — mirrors MCP `search`.
export async function search(args: SearchArgs): Promise<SearchOutput> {
  const t0 = Date.now();
  const res = (await getClient().search.query({
    query: args.query,
    ...(args.location ? { location: args.location } : {}),
    ...(args.language ? { language: args.language } : {}),
    ...(args.purpose ? { purpose: args.purpose } : {}),
    ...(args.recency_minutes !== undefined ? { recency_minutes: args.recency_minutes } : {}),
    ...(args.after_date ? { after_date: args.after_date } : {}),
    ...(args.before_date ? { before_date: args.before_date } : {}),
    ...(args.page !== undefined ? { page: args.page } : {}),
  } as never)) as {
    results?: Array<{ title?: string; url?: string; snippet?: string }>;
  };
  const elapsedMs = Date.now() - t0;
  console.log(`[tool:search ${elapsedMs}ms] GET api.search.tinyfish.ai query=${JSON.stringify(args.query)}`);
  const results: SearchHit[] = (res.results ?? []).slice(0, 10).map((r) => ({
    title: String(r.title ?? ""),
    url: String(r.url ?? ""),
    snippet: truncate(String(r.snippet ?? ""), MAX_SNIPPET),
  }));
  return { results, elapsedMs };
}

export interface FetchPage {
  url: string;
  title: string;
  text: string;
}

export interface FetchContentOutput {
  pages: FetchPage[];
  errors: Array<{ url: string; error: string }>;
  elapsedMs: number;
}

export interface FetchContentArgs {
  urls: string[];
  format?: "markdown" | "html" | "json";
  links?: boolean;
  purpose?: string;
}

// fetch_content — mirrors MCP `fetch_content` (max 10 URLs per request;
// we cap at 3 per LLM call to bound tokens).
export async function fetch_content(args: FetchContentArgs): Promise<FetchContentOutput> {
  const t0 = Date.now();
  const urls = args.urls.slice(0, MAX_URLS_PER_FETCH);
  const res = (await getClient().fetch.getContents({
    urls,
    format: args.format ?? "markdown",
    ...(args.links !== undefined ? { links: args.links } : { links: true }),
    ...(args.purpose ? { purpose: args.purpose } : {}),
  } as never)) as {
    results?: Array<{ url?: string; title?: string; text?: string }>;
    errors?: Array<{ url?: string; error?: string }>;
  };
  const elapsedMs = Date.now() - t0;
  console.log(`[tool:fetch_content ${elapsedMs}ms] POST api.fetch.tinyfish.ai urls=${urls.length}`);
  return {
    pages: (res.results ?? []).map((p) => ({
      url: String(p.url ?? ""),
      title: String(p.title ?? ""),
      text: truncate(String((p as { text?: unknown }).text ?? ""), MAX_PAGE_CHARS),
    })),
    errors: (res.errors ?? []).map((e) => ({ url: String(e.url ?? ""), error: String(e.error ?? "fetch failed") })),
    elapsedMs,
  };
}

export interface RunAutomationOutput {
  runId: string;
  status: string;
  result: unknown;
  elapsedMs: number;
  /** True when our client deadline hit before a terminal status — result may be partial. */
  timedOut: boolean;
}

export interface RunAutomationArgs {
  url: string;
  goal: string;
  browser_profile?: "lite" | "stealth";
  /** Structured-output schema enforced server-side. Defaults to registration fields. */
  output_schema?: Record<string, unknown>;
  /** Client deadline override (ms). Defaults to AGENT_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** Default structured output: registration extraction with stable keys. */
export const REGISTRATION_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    event_name: { type: "string" },
    date: { type: "string" },
    fee: { type: "string" },
    deadline: { type: "string" },
    registration_fields: { type: "array", items: { type: "string" } },
    registration_url: { type: "string" },
  },
};

const POLL_MS = 10_000;

function agentLimits(): { timeoutMs: number; maxSteps: number; maxDurationSeconds: number } {
  return {
    timeoutMs: Number(process.env.AGENT_TIMEOUT_MS ?? 90_000),
    maxSteps: Number(process.env.AGENT_MAX_STEPS ?? 12),
    maxDurationSeconds: Number(process.env.AGENT_MAX_DURATION_SECONDS ?? 75),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

// run_web_automation — mirrors MCP `run_web_automation`.
// Async queue + poll with a client deadline (bounds the 285s-style hangs),
// server-side caps via agent_config, structured JSON via output_schema.
// NOTE: `session_id` exists only on the MCP tool; the SDK wire schema is
// strict and rejects it, so it is intentionally NOT sent here.
export async function run_web_automation(args: RunAutomationArgs): Promise<RunAutomationOutput> {
  const t0 = Date.now();
  const { timeoutMs, maxSteps, maxDurationSeconds } = agentLimits();
  const deadline = t0 + (args.timeoutMs ?? timeoutMs);
  const queued = (await getClient().agent.queue({
    url: args.url,
    goal: args.goal,
    agent_config: { max_steps: maxSteps, max_duration_seconds: maxDurationSeconds },
    output_schema: args.output_schema ?? REGISTRATION_OUTPUT_SCHEMA,
    ...(args.browser_profile ? { browser_profile: args.browser_profile } : {}),
  } as never)) as { run_id?: string; id?: string };
  const runId = String(queued.run_id ?? queued.id ?? "unknown");
  console.log(`[tool:run_web_automation queued] POST agent.tinyfish.ai run_id=${runId} (cap: ${maxSteps} steps/${maxDurationSeconds}s server, ${Math.round((args.timeoutMs ?? timeoutMs) / 1000)}s client)`);

  let status = "PENDING";
  let result: unknown = null;
  for (;;) {
    try {
      const polled = await get_run({ id: runId });
      status = polled.status;
      result = polled.result;
    } catch (err) {
      console.log(`[tool:run_web_automation poll] get_run failed: ${err instanceof Error ? err.message : err}`);
    }
    if (TERMINAL_STATUSES.has(status.toUpperCase())) {
      const elapsedMs = Date.now() - t0;
      console.log(`[tool:run_web_automation ${elapsedMs}ms] run_id=${runId} status=${status}`);
      return { runId, status, result, elapsedMs, timedOut: false };
    }
    if (Date.now() >= deadline) {
      const elapsedMs = Date.now() - t0;
      console.log(`[tool:run_web_automation ${elapsedMs}ms] run_id=${runId} CLIENT DEADLINE — keeping partial status=${status}`);
      return { runId, status, result, elapsedMs, timedOut: true };
    }
    await sleep(POLL_MS);
  }
}

export interface GetRunOutput {
  status: string;
  result: unknown;
}

// get_run — mirrors MCP `get_run` (for async runs).
export async function get_run(args: { id: string }): Promise<GetRunOutput> {
  const run = (await getClient().runs.get(args.id)) as { status?: string; result?: unknown; result_json?: unknown };
  const status = String(run.status ?? "UNKNOWN");
  console.log(`[tool:get_run] id=${args.id} status=${status}`);
  return { status, result: run.result_json ?? run.result ?? null };
}
