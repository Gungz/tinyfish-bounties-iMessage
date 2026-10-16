// Minimal per-sender session: slot-filling across step-by-step turns.
//
// Best-practices note: memory is scoped per person (sender id + platform),
// conversation is per space. For the hackathon MVP this is an in-memory Map
// (no pg-boss / DB). Follows the same resourceId convention so it can be
// persisted later without changing callers.

export interface Slots {
  city?: string;
  dateWindow?: string;
  maxPrice?: string;
  wantsRegister?: boolean;
  /** URL the user picked from the last options list. */
  pickedUrl?: string;
}

/** Staged pipeline position (heuristic, maintained by handleTurn). */
export type Stage = "idle" | "searched" | "detailed" | "reg_checked" | "collecting";

export interface Session {
  slots: Slots;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  updatedAt: number;
  stage: Stage;
  /** Last presented options (numbered) so picks like "2" resolve. */
  lastOptions: Array<{ title: string; url: string }>;
  /** Registration field values the user dictated (in-memory only, TTL-expired). */
  regValues: Record<string, string>;
}

const sessions = new Map<string, Session>();
const TTL_MS = 30 * 60 * 1000; // 30 min
const MAX_HISTORY = 10;

export function sessionKey(platform: string, senderId: string): string {
  return `${platform}:${senderId}`;
}

export function getSession(key: string): Session {
  const existing = sessions.get(key);
  if (existing && Date.now() - existing.updatedAt < TTL_MS) return existing;
  const fresh: Session = { slots: {}, history: [], updatedAt: Date.now(), stage: "idle", lastOptions: [], regValues: {} };
  sessions.set(key, fresh);
  return fresh;
}

export function saveSession(key: string, session: Session): void {
  session.updatedAt = Date.now();
  session.history = session.history.slice(-MAX_HISTORY);
  sessions.set(key, session);
}
