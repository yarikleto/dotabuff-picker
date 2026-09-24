/**
 * The README's generated parts: the badge row under the banner and the table
 * of what the data covers. Pure — scripts/readme.mjs reads the files, fetches
 * the patch list and writes the README.
 *
 * The data patch is worked out from the windows the files record, never from
 * the day they were written: four weeks of STRATZ rows collected two days into
 * 7.41f are mostly 7.41e, and a badge that said "7.41f" would be wrong about
 * the one thing it exists to say.
 */

const DAY = 86_400_000;

export const COLORS = {
  onePatch: "38b45f",
  letterPatches: "c9a227",
  majorPatches: "e8833a",
  behind: "e0483d",
  neutral: "3b4654",
};

/** Valve's patch list, oldest first, as `{ name, at }` with `at` in ms. */
export function readPatches(feed) {
  const list = Array.isArray(feed?.patches) ? feed.patches : [];
  return list
    .map((p) => ({
      name: String(p?.patch_number ?? p?.patch_name ?? ""),
      at: Number(p?.patch_timestamp) * 1000,
    }))
    .filter((p) => p.name && Number.isFinite(p.at))
    .sort((a, b) => a.at - b.at);
}

/** The patch in force at `at`: a patch counts from the second it ships. */
export function patchAt(patches, at) {
  let current = null;
  for (const patch of patches) {
    if (patch.at > at) break;
    current = patch;
  }
  return current;
}

/** Every patch that was live at some point in `[from, to]`, oldest first. */
export function patchesBetween(patches, from, to) {
  const first = patchAt(patches, from);
  const later = patches.filter((p) => p.at > from && p.at <= to);
  return first ? [first, ...later] : later;
}

/** "7.41f" -> "7.41": letter patches are balance passes on one major version. */
export const majorOf = (name) => name.replace(/[a-z]+$/i, "");

export function formatSpan(span) {
  if (!span.length) return "unknown";
  const first = span[0].name;
  const last = span[span.length - 1].name;
  return first === last ? first : `${first} – ${last}`;
}

/**
 * Green when every window sits inside one patch, gold across letter patches of
 * one version, orange across a major patch, and red once a newer patch than
 * the data's last one was out when the README was written.
 */
export function spanColor(span, latest) {
  if (!span.length) return COLORS.neutral;
  const last = span[span.length - 1];
  if (latest && latest.name !== last.name && latest.at > last.at) return COLORS.behind;
  if (span.length === 1) return COLORS.onePatch;
  return new Set(span.map((p) => majorOf(p.name))).size === 1
    ? COLORS.letterPatches
    : COLORS.majorPatches;
}

/**
 * STRATZ periods are whole weeks written as inclusive UTC dates, so the last
 * day runs to its final millisecond.
 */
export function periodWindow(period) {
  if (!Array.isArray(period) || period.length !== 2) return null;
  const from = Date.parse(`${period[0]}T00:00:00Z`);
  const to = Date.parse(`${period[1]}T00:00:00Z`) + DAY - 1;
  return Number.isFinite(from) && Number.isFinite(to) && from <= to ? { from, to } : null;
}

const count = (n) => Math.round(n).toLocaleString("en-US");

/** 589508 -> "589,508"; 12752274 -> "12.8 million". */
export function amount(n) {
  if (!Number.isFinite(n)) return "unknown";
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} million` : count(n);
}

export const formatDay = (at) =>
  new Date(at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

/** "Aug 20 – Sep 16, 2026", with the year once when both ends share it. */
export function formatWindow({ from, to }) {
  const a = new Date(from);
  const b = new Date(to);
  if (a.getUTCFullYear() !== b.getUTCFullYear()) return `${formatDay(from)} – ${formatDay(to)}`;
  const short = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${short(a)} – ${short(b)}, ${b.getUTCFullYear()}`;
}

const sumCells = (table) =>
  Object.values(table ?? {}).reduce((n, row) => n + Object.keys(row ?? {}).length, 0);

/** The key `sampleWindows` is looked up by: an OpenDota file's match id range. */
export const rangeKey = (range) =>
  Array.isArray(range) && range.length === 2 ? `${range[0]}-${range[1]}` : null;

/**
 * One row per data set, in the order the picker leans on them. `files` holds
 * each parsed file or null. The OpenDota files record a match id range rather
 * than dates, so `sampleWindows` maps each range (see `rangeKey`) to the start
 * times of its first and last match.
 */
export function describeData(files, { sampleWindows = {} } = {}) {
  const { matchups, positions, lanes, synergies, timings, calibration } = files;
  const read = (file) => (file?.generatedAt ? Date.parse(file.generatedAt) : null);
  const rows = [];

  rows.push({
    key: "counters",
    what: "Counters",
    source: "Dotabuff",
    file: matchups,
    window: null,
    read: read(matchups),
    sample: matchups ? `${count(sumCells(matchups.matchups))} hero pairs` : null,
  });

  let rankedMatches = 0;
  for (const bands of Object.values(positions?.heroes ?? {})) {
    for (const cell of bands?.all ?? []) rankedMatches += Array.isArray(cell) ? Number(cell[0]) || 0 : 0;
  }
  rows.push({
    key: "positions",
    what: "Positions by rank",
    source: "STRATZ",
    file: positions,
    window: periodWindow(positions?.period),
    read: read(positions),
    // Ten heroes a match, so hero-games over ten is matches.
    sample: positions ? `${amount(rankedMatches / 10)} ranked matches` : null,
  });

  let lanePairs = 0;
  for (const byPosition of Object.values(lanes?.against ?? {})) {
    for (const table of Object.values(byPosition ?? {})) lanePairs += Object.keys(table ?? {}).length;
  }
  rows.push({
    key: "lanes",
    what: "Lanes by seat",
    source: "STRATZ",
    file: lanes,
    window: periodWindow(lanes?.period),
    read: read(lanes),
    sample: lanes ? `${count(lanePairs)} lane pairings` : null,
  });

  const sampleWindow = (file) => sampleWindows[rangeKey(file?.matchIdRange)] ?? null;

  rows.push({
    key: "synergies",
    what: "Synergies",
    source: "OpenDota",
    file: synergies,
    window: sampleWindow(synergies),
    read: read(synergies),
    sample: synergies ? `${amount(synergies.matches)} matches` : null,
  });
  rows.push({
    key: "timings",
    what: "Game length",
    source: "OpenDota",
    file: timings,
    window: sampleWindow(timings),
    read: read(timings),
    sample: timings ? `${amount(timings.matches)} matches` : null,
  });
  // Fitted from games older than the two samples above, so it is dated the same way.
  rows.push({
    key: "calibration",
    what: "Win model",
    source: "OpenDota",
    file: calibration,
    window: sampleWindow(calibration),
    read: read(calibration),
    sample: calibration ? `${amount(calibration.matches)} matches` : null,
  });

  return rows;
}

/** Counters record no window, so they never widen the span. */
export function dataPatch(rows, patches, now) {
  const windows = rows.filter((r) => r.file && r.window).map((r) => r.window);
  const latest = patchAt(patches, now);
  if (!windows.length || !patches.length) {
    return { span: [], label: "unknown", color: COLORS.neutral, latest };
  }
  const from = Math.min(...windows.map((w) => w.from));
  const to = Math.max(...windows.map((w) => w.to));
  const span = patchesBetween(patches, from, to);
  return { span, label: formatSpan(span), color: spanColor(span, latest), latest };
}

/** Shields' static-badge path: `-` and `_` are separators, so they are doubled. */
export function badgePart(text) {
  return encodeURIComponent(String(text).replace(/-/g, "--").replace(/_/g, "__").replace(/ /g, "_"));
}

export function badge({ label, message, color, logo, link, alt }) {
  const query = new URLSearchParams({ style: "flat-square" });
  if (logo) {
    query.set("logo", logo);
    query.set("logoColor", "white");
  }
  const src = `https://img.shields.io/badge/${badgePart(label)}-${badgePart(message)}-${color}?${query}`;
  const img = `<img alt="${escapeHtml(alt ?? `${label}: ${message}`)}" src="${escapeHtml(src)}">`;
  return link ? `<a href="${escapeHtml(link)}">${img}</a>` : img;
}

const escapeHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const PATCH_FEED = "https://www.dota2.com/datafeed/patchnoteslist?language=english";

/**
 * Read by shields.io on every view, so it moves the day Valve ships a patch —
 * next to the data patch, that is what shows the numbers have fallen behind.
 */
export function latestPatchBadge() {
  const query = new URLSearchParams({
    url: PATCH_FEED,
    query: "$.patches[-1:].patch_number",
    label: "latest Dota patch",
    color: COLORS.neutral,
    style: "flat-square",
    logo: "dota2",
    logoColor: "white",
    cacheSeconds: "3600",
  });
  const src = `https://img.shields.io/badge/dynamic/json?${query}`;
  return `<a href="https://www.dota2.com/patches"><img alt="Latest Dota 2 patch" src="${escapeHtml(src)}"></a>`;
}

/** `repository` in any form npm accepts: `github:o/r`, an https or ssh URL, or `{ url }`. */
export function projectLinks(pkg) {
  const raw = typeof pkg?.repository === "string" ? pkg.repository : pkg?.repository?.url;
  const match = String(raw ?? "").match(/github(?:\.com[/:]|:)([^/\s]+)\/([^/\s#]+?)(?:\.git)?$/);
  const slug = match ? `${match[1]}/${match[2]}` : null;
  return {
    site: pkg?.homepage ?? null,
    slug,
    repo: slug ? `https://github.com/${slug}` : null,
    license: typeof pkg?.license === "string" ? pkg.license : null,
  };
}

/** Heroes with counters, or the roster's size before there are any. */
export const countHeroes = (matchups, rosterSize) =>
  Object.keys(matchups?.matchups ?? {}).length || rosterSize;

function oldestRead(rows) {
  const reads = rows.filter((r) => r.file && r.read).map((r) => r.read);
  return reads.length ? Math.min(...reads) : null;
}

const collectedAlt = (oldest) => (oldest ? `Data collected ${formatDay(oldest)}` : "No data collected yet");

/** The Covers cell, or null for an OpenDota sample nobody has dated yet. */
function coversText(row) {
  if (!row.file) return "not collected yet";
  if (row.window) return formatWindow(row.window);
  if (row.key === "counters" && row.read) return `read ${formatDay(row.read)}`;
  return null;
}

export function badgeBlock({ rows, patch, heroes, links }) {
  const oldest = oldestRead(rows);

  const top = [
    badge({
      label: "data patch",
      message: patch.label,
      color: patch.color,
      logo: "dota2",
      alt: `Data patch: ${patch.label}`,
    }),
    latestPatchBadge(),
    badge({
      label: "collected",
      message: oldest ? formatDay(oldest) : "not yet",
      color: COLORS.neutral,
      alt: collectedAlt(oldest),
    }),
    badge({ label: "heroes", message: String(heroes), color: COLORS.neutral }),
  ];
  const bottom = [
    badge({
      label: "data",
      message: "Dotabuff · STRATZ · OpenDota",
      color: COLORS.neutral,
      link: "#the-data",
      alt: "Data from Dotabuff, STRATZ and OpenDota",
    }),
  ];
  // "code" in the label: the data beside it is not the project's to license.
  if (links.license) {
    bottom.push(
      badge({
        label: "code license",
        message: links.license,
        color: COLORS.neutral,
        link: "#license",
        alt: `Code license: ${links.license}`,
      }),
    );
  }
  if (links.slug) {
    const status = new URLSearchParams({ branch: "main", label: "site", style: "flat-square", logo: "github" });
    bottom.push(
      `<a href="${links.repo}/actions/workflows/pages.yml"><img alt="Site deploy status" src="${escapeHtml(
        `https://img.shields.io/github/actions/workflow/status/${links.slug}/pages.yml?${status}`,
      )}"></a>`,
    );
  }

  const lines = ["<p>", ...top.map((b) => `  ${b}`), "  <br>", ...bottom.map((b) => `  ${b}`), "</p>"];
  if (links.site) {
    lines.push("", `<h3><a href="${escapeHtml(links.site)}">Open the picker →</a></h3>`);
  }
  return lines.join("\n");
}

export function dataTable(rows, patches) {
  const lines = ["| Data | Source | Covers | Sample | Patch |", "| --- | --- | --- | --- | --- |"];
  for (const row of rows) {
    if (!row.file) {
      lines.push(`| ${row.what} | ${row.source} | ${coversText(row)} | | |`);
      continue;
    }
    // Non-breaking spaces keep "7.41e – 7.41f" on one line in a narrow column.
    const patch = row.window
      ? formatSpan(patchesBetween(patches, row.window.from, row.window.to)).replace(/ /g, "\u00a0")
      : "—";
    lines.push(`| ${row.what} | ${row.source} | ${coversText(row) ?? "unknown"} | ${row.sample ?? ""} | ${patch} |`);
  }
  return lines.join("\n");
}

/**
 * Where the README's generated blocks disagree with the data files, on the
 * facts that need neither the network nor the clock: the collection date, the
 * hero count, every row's sample, and the windows the files record. Patch
 * labels are left out — they depend on Valve's list and on the day they were
 * written, and a patch shipping must not fail a build.
 */
export function readmeDrift(readme, { files, heroes }) {
  const rows = describeData(files);
  const drift = [];

  const collected = collectedAlt(oldestRead(rows));
  if (!readme.includes(`alt="${escapeHtml(collected)}"`)) drift.push(`the collected badge should say "${collected}"`);
  if (!readme.includes(`alt="heroes: ${heroes}"`)) drift.push(`the heroes badge should say ${heroes}`);

  const table = readme.match(/<!-- data:start[^>]*-->([\s\S]*?)<!-- data:end -->/)?.[1] ?? "";
  for (const row of rows) {
    const line = table.split("\n").find((l) => l.startsWith(`| ${row.what} | ${row.source} |`));
    if (!line) {
      drift.push(`the data table has no ${row.what} row`);
      continue;
    }
    const [, , , covers, sample] = line.split("|").map((cell) => cell.trim());
    const wantSample = row.file ? (row.sample ?? "") : "";
    if (sample !== wantSample) drift.push(`${row.what}: the table says "${sample}", the file "${wantSample}"`);
    const wantCovers = coversText(row);
    if (wantCovers !== null && covers !== wantCovers) {
      drift.push(`${row.what}: the table says "${covers}", the file "${wantCovers}"`);
    }
  }
  return drift;
}

/**
 * Swap what sits between `<!-- name:start … -->` and `<!-- name:end -->`,
 * leaving both markers and everything outside them alone.
 */
export function replaceBlock(text, name, body) {
  const pattern = new RegExp(`(<!-- ${name}:start[^>]*-->)[\\s\\S]*?(<!-- ${name}:end -->)`);
  if (!pattern.test(text)) throw new Error(`README.md has no <!-- ${name}:start --> … <!-- ${name}:end --> block`);
  return text.replace(pattern, (_, start, end) => `${start}\n${body}\n${end}`);
}
