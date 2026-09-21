/**
 * When a saved OpenDota collection may be continued.
 *
 * Progress files exist so an interrupted run picks up where it stopped. A run
 * that already finished is not that, and nor is one left lying for days:
 * continuing either re-publishes the same old matches under a new date, which
 * is how a month-old timings.json passed `npm run refresh` as fresh.
 */

export const RESUME_WINDOW_HOURS = 24;

/**
 * Why `saved` must not be resumed, or null when it may be. A missing
 * `savedAt` means the file predates dated progress, so its age is unknown.
 */
export function staleProgress(saved, { target, now = Date.now() }) {
  if (!saved) return null;
  if (Number(saved.matches) >= target) return "the previous run finished";
  const savedAt = Date.parse(saved.savedAt);
  if (!Number.isFinite(savedAt)) return "the saved run carries no date";
  const hours = (now - savedAt) / 3_600_000;
  if (hours > RESUME_WINDOW_HOURS) return `the saved run is ${Math.round(hours)} hours old`;
  return null;
}
