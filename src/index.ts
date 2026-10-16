import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";
import { buildReplyItems } from "./format.js";
import { handleTurn } from "./turn.js";

// NOTE: the terminal TUI provider spawns a `tuichat` subprocess that dials
// back over 127.0.0.1 — if that fails in your environment (connection
// refused / no TTY), leave ENABLE_TERMINAL unset and use `yarn chat`
// (stdin/stdout REPL driving the same turn logic) for local dev instead.
const useTerminal = process.env.ENABLE_TERMINAL === "1";
const creds = { projectId: process.env.PROJECT_ID!, projectSecret: process.env.PROJECT_SECRET! };
const app = useTerminal
  ? await Spectrum({ ...creds, providers: [terminal.config(), imessage.config()] })
  : await Spectrum({ ...creds, providers: [imessage.config()] });

console.log("gungz online. LLM brain with TinyFish tools (search/fetch_content/run_web_automation).");
console.log(`[providers] active: ${useTerminal ? "terminal + imessage" : "imessage only (set ENABLE_TERMINAL=1 for the TUI)"}`);
for (const k of ["PROJECT_ID", "PROJECT_SECRET", "TINYFISH_API_KEY", "GEMINI_API_KEY"]) {
  console.log(`[env] ${k}: ${process.env[k] ? "set" : "MISSING (add it to .env, see .env.example)"}`);
}

// `app.messages` merges every provider. Each tick: [space, message].
for await (const [space, message] of app.messages) {
  try {
    if (message.direction === "outbound") continue;
    if (message.content.type !== "text") continue;
    const text = message.content.text.trim();
    if (!text) continue;

    // Instant ack (tapback may warn-and-skip on some providers — ignore).
    try {
      await message.react("👍");
    } catch {
      /* unsupported — continue */
    }

    await space.responding(async () => {
      const { reply, urls } = await handleTurn(message.platform, message.sender?.id ?? "anon", text);
      const items = buildReplyItems(reply, urls);
      let first = true;
      for (const item of items) {
        try {
          if (first) await message.reply(item);
          else await space.send(item);
        } catch {
          await space.send(item);
        }
        first = false;
      }
    });
  } catch (err) {
    console.error("[loop] error:", err instanceof Error ? err.message : err);
  }
}
