// One turn of the agent: shared by the Spectrum loop (index.ts) and the
// stdin/stdout dev REPL (dev-chat.ts) so the walkthrough exercises the
// exact production path (LLM brain → quota fallback → reply + links).

import { runDeterministic } from "./deterministic.js";
import { isFallbackError, isQuotaError, LLM_QUOTA_EXHAUSTED, runBrain } from "./llm.js";
import type { Stage } from "./session.js";
import { getSession, saveSession, sessionKey } from "./session.js";

export interface TurnResult {
  reply: string;
  urls: string[];
}

export async function handleTurn(platform: string, senderId: string, text: string): Promise<TurnResult> {
  const key = sessionKey(platform, senderId);
  const session = getSession(key);
  session.history.push({ role: "user", text });

  let reply: string;
  let urls: string[] = [];
  // Heuristic stage: what this turn accomplished (guides next turn's prompt).
  const advance = (tools: string[]): void => {
    let next: Stage = session.stage;
    if (tools.includes("run_web_automation")) next = "reg_checked";
    else if (tools.includes("fetch_content")) next = "detailed";
    else if (tools.includes("search")) next = "searched";
    if (Object.keys(session.regValues).length > 0 && next !== "reg_checked") next = "collecting";
    if (next !== session.stage) {
      session.stage = next;
      console.log(`[turn] stage → ${next}`);
    }
  };
  try {
    const out = await runBrain(session, text);
    reply = out.text;
    urls = out.urls;
    if (out.options.length > 0) session.lastOptions = out.options;
    advance(out.toolsUsed);
    console.log(`[turn] tools used: ${out.toolsUsed.join(" → ") || "(none — clarifying question)"}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isFallbackError(err)) {
      // Level 3 fallback: zero-LLM deterministic chain, still hits all
      // three TinyFish endpoints so the demo/video keeps working.
      const quota = (err as { code?: string })?.code === LLM_QUOTA_EXHAUSTED || isQuotaError(err);
      console.log(`[turn] LLM ${quota ? "quota exhausted" : "unavailable"} → deterministic fallback (zero LLM)`);
      try {
        const fb = await runDeterministic(session, text);
        const notice = quota ? "AI summary quota hit" : "AI is overloaded right now";
        reply = `${notice} — showing direct results 🔎\n${fb.text}`;
        urls = fb.urls;
        if (fb.options.length > 0) session.lastOptions = fb.options;
        advance(fb.toolsUsed);
        console.log(`[turn] fallback tools used: ${fb.toolsUsed.join(" → ") || "(none — clarifying question)"}`);
      } catch (fbErr) {
        const fbMsg = fbErr instanceof Error ? fbErr.message : String(fbErr);
        console.error(`[turn] fallback error: ${fbMsg}`);
        reply = `AI quota hit and the backup lookup failed (${fbMsg}). Try again in a minute, e.g. "AI hackathons SF next month under $50".`;
      }
    } else if (msg.includes("TINYFISH_API_KEY") || msg.includes("GEMINI_API_KEY")) {
      console.error(`[turn] brain error: ${msg}`);
      reply =
        `Setup needed: ${msg}\n\nPut keys in the .env file at the project root (copy from .env.example):\n- TINYFISH_API_KEY from https://agent.tinyfish.ai/api-keys\n- GEMINI_API_KEY from https://aistudio.google.com/app/apikey\nNever commit .env.`;
    } else {
      console.error(`[turn] brain error: ${msg}`);
      reply = `Sorry — that run failed (${msg}). Try again with city + dates + budget, e.g. "AI hackathons SF next month under $50".`;
    }
  }

  session.history.push({ role: "assistant", text: reply });
  saveSession(key, session);
  return { reply, urls };
}
