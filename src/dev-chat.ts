// Dev REPL: stdin/stdout chat driving the SAME turn logic as production
// (handleTurn in turn.ts). Use when the terminal TUI provider can't run
// (tuichat needs 127.0.0.1 loopback + a TTY). Run: `yarn chat`
// Simulate quota exhaustion with: `SIMULATE_QUOTA_EXHAUSTION=1 yarn chat`

import readline from "node:readline";
import { chunkText } from "./format.js";
import { handleTurn } from "./turn.js";

for (const k of ["TINYFISH_API_KEY", "GEMINI_API_KEY"]) {
  console.log(`[env] ${k}: ${process.env[k] ? "set" : "MISSING (add it to .env, see .env.example)"}`);
}
console.log('gungz dev-chat. Type messages as the user, ":quit" to exit.\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let rlClosed = false;
rl.on("close", () => {
  rlClosed = true;
});
const ask = (q: string): Promise<string> => new Promise((res) => rl.question(q, res));

for (;;) {
  if (rlClosed) break;
  let line: string;
  try {
    line = (await ask("you> ")).trim();
  } catch {
    break; // stdin EOF (e.g. piped input) — exit cleanly
  }
  if (!line || line === ":quit") break;
  try {
    const { reply, urls } = await handleTurn("devchat", "local", line);
    for (const b of chunkText(reply)) console.log(`\nagent> ${b}`);
    for (const u of urls) console.log(`agent> 🔗 ${u}`);
    console.log("");
  } catch (err) {
    console.error("[chat] error:", err instanceof Error ? err.message : err);
  }
}
rl.close();
