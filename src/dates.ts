// Date gate: code-enforced upcoming/past verdicts for event pages.
//
// Prompt rules alone proved unreliable (past events still presented), so tool
// results are annotated with a verdict the model must respect, and the
// deterministic chain drops past-only pages outright. Conservative by design:
// "unknown" (no parseable date) is NEVER excluded.

const MONTHS: Record<string, number> = {
  january: 0, jan: 0,
  february: 1, feb: 1,
  march: 2, mar: 2,
  april: 3, apr: 3,
  may: 4,
  june: 5, jun: 5,
  july: 6, jul: 6,
  august: 7, aug: 7,
  september: 8, sept: 8, sep: 8,
  october: 9, oct: 9,
  november: 10, nov: 10,
  december: 11, dec: 11,
};

const MONTH_RE = "January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec";

function pushDate(dates: Date[], y: number, m: number, d: number): void {
  if (y < 2000 || y > 2100 || m < 0 || m > 11 || d < 1 || d > 31) return;
  const dt = new Date(Date.UTC(y, m, d));
  if (!isNaN(dt.getTime())) dates.push(dt);
}

/** Extract all absolute calendar dates mentioned in free text. Exported for tests. */
export function extractDates(text: string): Date[] {
  const dates: Date[] = [];
  // Month DD[-DD], YYYY — range end wins ("Nov 15-16, 2026" → Nov 16)
  const re1 = new RegExp(`\\b(${MONTH_RE})\\s+(\\d{1,2})(?:\\s*[–-]\\s*(\\d{1,2}))?,?\\s+(\\d{4})`, "gi");
  for (let m = re1.exec(text); m; m = re1.exec(text)) {
    const month = MONTHS[m[1]!.toLowerCase().replace(".", "")];
    const day = Number(m[3] ?? m[2]);
    if (month !== undefined) pushDate(dates, Number(m[4]), month, day);
  }
  // DD Month YYYY ("12 November 2026")
  const re2 = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_RE})\\s+(\\d{4})`, "gi");
  for (let m = re2.exec(text); m; m = re2.exec(text)) {
    const month = MONTHS[m[2]!.toLowerCase().replace(".", "")];
    if (month !== undefined) pushDate(dates, Number(m[3]), month, Number(m[1]));
  }
  // ISO YYYY-MM-DD
  const re3 = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  for (let m = re3.exec(text); m; m = re3.exec(text)) {
    pushDate(dates, Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  // Month YYYY ("November 2026" → first of month)
  const re4 = new RegExp(`\\b(${MONTH_RE})\\s+(\\d{4})`, "gi");
  for (let m = re4.exec(text); m; m = re4.exec(text)) {
    const month = MONTHS[m[1]!.toLowerCase().replace(".", "")];
    if (month !== undefined) pushDate(dates, Number(m[2]), month, 1);
  }
  return dates;
}

export type Verdict = "future" | "past-only" | "unknown";

/** Classify a page/snippet: future event, only-past event, or unknown. Exported for tests. */
export function pageVerdict(text: string, now: Date = new Date()): Verdict {
  const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const curYear = now.getUTCFullYear();
  const dates = extractDates(text);
  if (dates.length > 0) {
    const latest = Math.max(...dates.map((d) => d.getTime()));
    return latest < todayUTC ? "past-only" : "future";
  }
  // No full dates: past-edition signals, e.g. "Hackathon 2024 winners".
  const yearNearEvent = new RegExp(
    `\\b(19\\d{2}|20\\d{2})\\b[^.]{0,60}?\\b(hackathon|hack day|edition)\\b|\\b(hackathon|edition)\\b[^.]{0,60}?\\b(19\\d{2}|20\\d{2})\\b`,
    "i",
  ).exec(text);
  if (yearNearEvent) {
    const year = Number(yearNearEvent[1] ?? yearNearEvent[4]);
    if (year < curYear) return "past-only";
    if (year > curYear) return "future";
  }
  if (/concluded|has ended|event (has )?ended|already (held|concluded|ended|took place)|was held in \d{4}/i.test(text)) {
    return "past-only";
  }
  return "unknown";
}
