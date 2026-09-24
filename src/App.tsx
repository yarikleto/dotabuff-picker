import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DraftAnalysis } from "./components/DraftAnalysis";
import { EnemyIntent } from "./components/EnemyIntent";
import { HeroGrid } from "./components/HeroGrid";
import { PositionFilter } from "./components/PositionPicker";
import { RankFilter } from "./components/RankFilter";
import { Rebalance } from "./components/Rebalance";
import { Suggestions } from "./components/Suggestions";
import { BanPanel, TeamPanel } from "./components/TeamPanel";
import { emptyDataset, loadDataset } from "./lib/dataset";
import { withRankBand } from "./lib/positions";
import { buildSearchIndex, searchHeroes } from "./lib/search";
import { POSITION_LABEL, guessPosition, missingPositions } from "./lib/roles";
import { analyseDraft, pickImpact } from "./lib/analysis";
import { rebalance, rebalanceReadiness } from "./lib/rebalance";
import { buttonLabel, buttonTitle, describeOption } from "./lib/rebalanceCopy";
import type { RebalanceOption } from "./lib/rebalance";
import type { AppliedArrangement } from "./components/Rebalance";
import {
  counters,
  explain,
  formatSigned,
  heroDetail,
  partners,
  rankAll,
  offRolePicks,
  robustPicks,
  suggestBans,
  suggestPicks,
} from "./lib/scoring";
import { intentScores, readIntent, readNearMisses } from "./lib/intent";
import { bansBy } from "./lib/bans";
import { TEAM_SIZE, useDraft } from "./state/draft";
import { useSettings } from "./state/settings";
import type { BanSide, Dataset, Position, Slot, SortMode, Suggestion } from "./types";

const SLOT_LABEL: Record<Slot, string> = {
  mine: "My pick",
  enemy: "Enemy pick",
  banned: "Ban",
};

/** The ban mode names whose ban it is, because that is now half of what it means. */
const BAN_SIDE_LABEL: Record<BanSide, string> = { mine: "My ban", enemy: "Their ban" };

const SORT_LABEL: Record<SortMode, string> = {
  attr: "Attribute",
  pick: "Best to pick",
  ban: "Best to ban",
};

/**
 * Days after which a data file is worth a warning.
 *
 * Roughly the cadence Valve ships a gameplay patch on. Below it the table is
 * describing the game being played; much above it and the confident decimals
 * are describing a previous one.
 */
const STALE_DAYS = 30;

const SORT_HINT: Record<SortMode, string> = {
  attr: "Group by primary attribute, in Dotabuff's order",
  pick: "Order the whole pool by the same score as the pick suggestions",
  ban: "Order the whole pool by the same score as the ban suggestions",
};

/** The underline each sort wears when chosen: the colour of the slot it arms. */
const SORT_TONE: Record<SortMode, string> = {
  attr: "",
  pick: "tone-mine",
  ban: "tone-banned",
};

function shortDate(iso: string): string {
  const date = new Date(iso);
  const thisYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(
    undefined,
    thisYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" },
  );
}

export default function App() {
  const [loadedDataset, setLoadedDataset] = useState<Dataset>(() => emptyDataset());
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [activeSlot, setActiveSlot] = useState<Slot>("mine");
  /**
   * Which side the next ban is credited to.
   *
   * Kept out of `Slot` deliberately. A ban puts a hero in one place whoever
   * spent it, so making "my ban" and "their ban" two slots would have doubled
   * every slot-shaped thing in the app — the mode selector, the tile overlay
   * buttons, the card labels — to express one bit that only the ban panel and
   * one reading care about. It rides alongside instead.
   */
  const [banSide, setBanSide] = useState<BanSide>("mine");
  const [showSettings, setShowSettings] = useState(false);
  /**
   * The draft read-out, opened from the Draft analysis button. Closed by
   * default: mid-draft the suggestion lists are what you want on screen, and
   * this is for the pause afterwards when someone has to explain the plan.
   */
  const [showAnalysis, setShowAnalysis] = useState(false);
  /**
   * The reshuffle panel. Closed by default and opened from a button that only
   * lights up when there is actually something to move — a panel that is
   * permanently on screen saying "nothing to fix" is the same as no panel, and
   * the moment this matters is a specific one: they just answered your hero.
   */
  const [showRebalance, setShowRebalance] = useState(false);
  /**
   * The pick list follows the first position my team is still missing. Picking
   * a different one from the filter overrides that until the next hero goes in,
   * at which point it re-arms on the new first gap — which is what you want
   * mid-draft, while still letting "Any" mean "show me everything".
   */
  const [pickOverride, setPickOverride] = useState<{
    position: Position | null;
    atCount: number;
  } | null>(null);
  const [banPosition, setBanPosition] = useState<Position | null>(null);
  /**
   * The grid asks its own question. The suggestion panels are lists of ten
   * heroes for one slot, so a position there is the whole point; the grid is
   * the entire pool, and having it silently re-rank because you glanced at
   * position 4 in a side panel was surprising. So it keeps a separate filter,
   * starting at "Any" and moving only when you move it.
   */
  const [gridPosition, setGridPosition] = useState<Position | null>(null);
  const [sort, setSort] = useState<SortMode>("attr");
  const searchRef = useRef<HTMLInputElement>(null);

  const {
    draft,
    slotOf,
    banSideOf,
    assign,
    setBanSide: setBanSideOf,
    setPosition,
    reorder,
    setLanePlan,
    remove,
    clearSlot,
    swapTeams,
    reset,
    total,
  } = useDraft();
  const { settings, update, reset: resetSettings } = useSettings();
  // Everything below reads this, so switching rank bands re-ranks the whole app at once.
  const dataset = useMemo(
    () => withRankBand(loadedDataset, settings.rankBand),
    [loadedDataset, settings.rankBand],
  );

  useEffect(() => {
    const controller = new AbortController();
    loadDataset(controller.signal)
      .then(setLoadedDataset)
      .catch((err) => {
        if ((err as Error)?.name !== "AbortError") setLoadedDataset(emptyDataset(String(err)));
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  // Type anywhere to search; Escape clears.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.tagName === "SELECT";
      if (e.key === "Escape") {
        setQuery("");
        searchRef.current?.blur();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey) return;
      if (e.altKey && ["1", "2", "3"].includes(e.key)) {
        e.preventDefault();
        setActiveSlot((["mine", "enemy", "banned"] as Slot[])[Number(e.key) - 1]!);
        return;
      }
      if (/^[a-zA-Z]$/.test(e.key) || e.key === "/") {
        searchRef.current?.focus();
        if (e.key === "/") e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const index = useMemo(() => buildSearchIndex(dataset.heroes), [dataset.heroes]);
  const visibleHeroes = useMemo(() => searchHeroes(index, query), [index, query]);

  const myGaps = useMemo(() => missingPositions(draft.mine), [draft.mine]);
  const enemyGaps = useMemo(() => missingPositions(draft.enemy), [draft.enemy]);

  /** The position suggestions are actually being made for. */
  const effectivePickPosition =
    pickOverride && pickOverride.atCount === draft.mine.length
      ? pickOverride.position
      : dataset.hasPositions
        ? myGaps[0] ?? null
        : null;

  const setPickPosition = useCallback(
    (position: Position | null) => setPickOverride({ position, atCount: draft.mine.length }),
    [draft.mine.length],
  );

  /**
   * What the enemy's own bans say about their next pick.
   *
   * Computed once here and handed to everything that needs it — the panel that
   * names the heroes, the ban ranking that scores them, the badges on the grid.
   * Two reasons, and the second is the important one: it is a full pass over
   * the matchup table, and a panel that named one hero while the list beside it
   * had quietly scored a different one would be worse than no panel.
   */
  const intent = useMemo(
    () => (dataset.hasData ? readIntent(dataset, draft, settings) : []),
    [dataset, draft, settings],
  );
  const intentMap = useMemo(
    () => (dataset.hasData ? intentScores(dataset, draft, settings) : new Map<string, number>()),
    [dataset, draft, settings],
  );
  const nearMisses = useMemo(
    () => (dataset.hasData ? readNearMisses(dataset, draft, settings) : []),
    [dataset, draft, settings],
  );
  const theirBanCount = useMemo(() => bansBy(draft.banned, "enemy").length, [draft.banned]);

  const picks = useMemo(
    () =>
      dataset.hasData ? suggestPicks(dataset, draft, settings, effectivePickPosition, 10) : [],
    [dataset, draft, settings, effectivePickPosition],
  );
  const bans = useMemo(
    () => (dataset.hasData ? suggestBans(dataset, draft, settings, banPosition, 10, intentMap) : []),
    [dataset, draft, settings, banPosition, intentMap],
  );
  /**
   * The counter-picks the role threshold hides. Empty on most boards, which is
   * the point — it appears when the enemy has taken somebody a strange seat
   * has a measured answer to.
   */
  const offRole = useMemo(
    () =>
      dataset.hasData ? offRolePicks(dataset, draft, settings, effectivePickPosition) : [],
    [dataset, draft, settings, effectivePickPosition],
  );

  /**
   * Which suggestions are conclusions rather than settings.
   *
   * Re-ranks at six plausible weightings and keeps the heroes that never leave
   * the top five, so the panel can mark them. Deliberately memoised alongside
   * the lists themselves: it is the same ranking run a few more times, and it
   * must move exactly when the board does.
   */
  const robustPickSlugs = useMemo(
    () =>
      dataset.hasData
        ? robustPicks(dataset, draft, settings, effectivePickPosition, "pick")
        : new Set<string>(),
    [dataset, draft, settings, effectivePickPosition],
  );
  const robustBanSlugs = useMemo(
    () =>
      dataset.hasData
        ? robustPicks(dataset, draft, settings, banPosition, "ban", 5, intentMap)
        : new Set<string>(),
    [dataset, draft, settings, banPosition, intentMap],
  );

  /**
   * What each hero is worth against the enemy line-up *and* beside your own,
   * for the tile badges. Both halves in one number, and scored for the grid's
   * own position filter, so a badge never disagrees with the tile it sits on.
   */
  const advantage = useMemo(() => {
    const map = new Map<string, number>();
    if (!dataset.hasData || (!draft.enemy.length && !draft.mine.length)) return map;
    for (const hero of dataset.heroes) {
      if (slotOf.has(hero.slug)) continue;
      const { mean, contributions, synergyMean, synergyContributions } = explain(
        dataset,
        hero.slug,
        gridPosition,
        draft.enemy,
        settings,
        draft.mine,
        draft.lanePlan,
      );
      if (contributions.length || synergyContributions.length) {
        map.set(hero.slug, mean + settings.synergyWeight * synergyMean);
      }
    }
    return map;
  }, [dataset, draft.enemy, draft.mine, draft.lanePlan, slotOf, settings, gridPosition]);

  /**
   * The full read-out behind the headline number. Worked out whenever both
   * sides have a hero, whether or not the panel is open — it is the source of
   * the figure on its button as well, so the two can never say different things.
   */
  const analysis = useMemo(
    () => (dataset.hasData ? analyseDraft(dataset, draft, settings, TEAM_SIZE) : null),
    [dataset, draft, settings],
  );

  // The panel takes focus when it mounts, so it must only ever mount from a
  // click — not reappear on its own when the next enemy hero goes in.
  const hasAnalysis = analysis !== null;
  useEffect(() => {
    if (!hasAnalysis) setShowAnalysis(false);
  }, [hasAnalysis]);

  /**
   * Whether a rearrangement is even a question yet, and if not, why not.
   *
   * Cheap, pure, and deliberately computed apart from the search: it is what the
   * disabled button says, and asking for it must not cost 240 board evaluations
   * to discover there was nothing to evaluate. It is also the gate on the search
   * below — a complete, fully-seated five is what makes those evaluations
   * comparable to each other in the first place.
   */
  const rebalanceReady = useMemo(() => rebalanceReadiness(draft), [draft]);

  /**
   * Whether the five heroes already picked would be worth more in different
   * seats — worked out on every board change rather than on demand, so the
   * button can warn about a fix nobody thought to look for. That is the whole
   * point of it: you go looking for a reshuffle only if you already suspect
   * one, and the case this exists for is the one you have not spotted.
   *
   * 239 arrangements, each a `draftBalance` over 25 pairings, plus a lane read
   * for the handful that could plausibly rescue a lane and for those that reach
   * the screen. Memoised on the same inputs as everything else so it can never
   * describe a board that has moved on, and skipped outright until the line-up
   * is complete — which is most of a draft.
   */
  const rebalanceReport = useMemo(
    () => (dataset.hasData && rebalanceReady.ready ? rebalance(dataset, draft, settings) : null),
    [dataset, draft, settings, rebalanceReady.ready],
  );

  /**
   * The arrangement applied from the panel, and the board it replaced.
   *
   * Applying rewrites five positions in one move and nothing else in the app can
   * put them back: `setPosition` is exclusive, so undoing a three-way rotation
   * by hand knocks a hero off their seat at every step and ends with two of them
   * on nothing. Keeping the previous booking is the only honest way to offer a
   * suggestion this destructive.
   */
  const [appliedRebalance, setAppliedRebalance] = useState<AppliedArrangement | null>(null);

  const applyRebalance = useCallback(
    (option: RebalanceOption) => {
      setAppliedRebalance({
        label: describeOption(option),
        restore: { picks: draft.mine.map((p) => ({ ...p })), lanePlan: draft.lanePlan },
      });
      reorder(option.picks, option.lanePlan);
    },
    [draft.mine, draft.lanePlan, reorder],
  );

  const undoRebalance = useCallback(() => {
    if (!appliedRebalance) return;
    reorder(appliedRebalance.restore.picks, appliedRebalance.restore.lanePlan);
    setAppliedRebalance(null);
  }, [appliedRebalance, reorder]);

  /** Focus goes back where it came from when a panel closes. */
  const rebalanceButton = useRef<HTMLButtonElement>(null);
  const analysisButton = useRef<HTMLButtonElement>(null);

  const closeRebalance = useCallback(() => {
    setShowRebalance(false);
    setAppliedRebalance(null);
    rebalanceButton.current?.focus();
  }, []);

  const closeAnalysis = useCallback(() => {
    setShowAnalysis(false);
    analysisButton.current?.focus();
  }, []);

  /**
   * A hero joining or leaving my side makes the stored board stale — it
   * describes a line-up that no longer exists, and its label names a move
   * nobody can check any more.
   */
  const myTeam = draft.mine.map((p) => p.slug).join(",");
  useEffect(() => {
    setAppliedRebalance(null);
  }, [myTeam]);

  /** The whole pool ranked for the active sort. Empty while sorting by attribute. */
  const gridRanking = useMemo(
    () =>
      sort === "attr" || !dataset.hasData
        ? []
        : rankAll(dataset, draft, settings, gridPosition, sort, intentMap),
    [dataset, draft, settings, sort, gridPosition, intentMap],
  );

  const gridScores = useMemo(
    () => new Map(gridRanking.map((s) => [s.hero.slug, s.score])),
    [gridRanking],
  );

  /**
   * Where each hero places in that ranking, 1-based.
   *
   * Kept beside the scores rather than counted off the tiles as they render:
   * the grid marks its leaders with an ordinal, and that number has to mean a
   * place in the whole pool — the same thing the suggestion panel's numbering
   * means — and not a place in whatever the search box happened to leave on
   * screen. The two are only the same when nothing is filtered, and the moment
   * they part the grid appears to contradict the panel beside it.
   */
  const gridRanks = useMemo(
    () => new Map(gridRanking.map((s, i) => [s.hero.slug, i + 1])),
    [gridRanking],
  );

  /**
   * The whole story behind one tile, worked out only when its card opens.
   * Scored for whatever the grid is currently sorting for, so the card and the
   * badge above it can never disagree.
   */
  const detailsFor = useCallback(
    (slug: string) =>
      dataset.hasData
        ? heroDetail(
            dataset,
            draft,
            settings,
            slug,
            gridPosition,
            sort === "ban" ? "ban" : "pick",
            intentMap,
          )
        : null,
    [dataset, draft, settings, gridPosition, sort, intentMap],
  );

  /**
   * What the board becomes if this hero goes on it — the score says what a
   * hero is worth, this says what it does. Ban mode asks the same question
   * from the enemy's seat, because that is the pick you are trying to prevent.
   */
  const impactFor = useCallback(
    (slug: string, position: Position | null) =>
      dataset.hasData
        ? pickImpact(
            dataset,
            draft,
            settings,
            slug,
            position,
            sort === "ban" ? "enemy" : "mine",
            TEAM_SIZE,
          )
        : null,
    [dataset, draft, settings, sort],
  );

  /**
   * The heroes who beat this one, whatever is on the board.
   *
   * Deliberately not scored against the draft: this is the question you ask
   * *before* committing to a hero — what the enemy still has as an answer — and
   * the whole point is that it can be asked with an empty board, which is
   * exactly when a ban is still cheap.
   *
   * `position` is the card's own role filter: the same question asked of one
   * seat rather than of the whole pool.
   */
  const countersFor = useCallback(
    (slug: string, position: Position | null = null) =>
      dataset.hasData ? counters(dataset, slug, settings, 5, position) : [],
    [dataset, settings],
  );

  /**
   * And the other half of the same question: who this hero belongs beside.
   *
   * The pick list can tell you a hero is the best thing on the board and still
   * leave you with no plan for the next four slots. This is the plan, and like
   * the counters it can be read before anything has been taken. `ownPosition`
   * is the hero's seat once drafted, which lets a role-filtered row quote the
   * same figure the pick list scores that pair on — see `partners`.
   */
  const partnersFor = useCallback(
    (slug: string, position: Position | null = null, ownPosition: Position | null = null) =>
      dataset.hasSynergies ? partners(dataset, slug, settings, 5, position, ownPosition) : [],
    [dataset, settings],
  );

  const seatOf = useMemo(
    () => new Map([...draft.mine, ...draft.enemy].map((p) => [p.slug, p.position])),
    [draft.mine, draft.enemy],
  );

  const sortedHeroes = useMemo(() => {
    if (!gridRanking.length) return visibleHeroes;
    const order = new Map(gridRanking.map((s, i) => [s.hero.slug, i]));
    // Heroes the ranking left out — already drafted, or below the role and
    // win-rate thresholds — sink to the bottom instead of vanishing, keeping
    // their search order among themselves.
    const last = order.size;
    return [...visibleHeroes].sort(
      (a, b) => (order.get(a.slug) ?? last) - (order.get(b.slug) ?? last),
    );
  }, [gridRanking, visibleHeroes]);

  /** Sorting by a mode also arms the matching click target — the usual next move. */
  const changeSort = useCallback((next: SortMode) => {
    setSort(next);
    if (next === "pick") setActiveSlot("mine");
    if (next === "ban") setActiveSlot("banned");
  }, []);

  /**
   * Adding a hero to a team also books them into a position: their most-played
   * one among the slots that team still needs. Always overridable.
   */
  /**
   * `side` overrides the active ban side for one click — what Shift+Alt does on
   * a tile, and what the grid's ban button uses. Ignored outside the ban slot.
   */
  const assignHero = useCallback(
    (slug: string, slot: Slot, position?: Position | null, side?: BanSide) => {
      if (slot === "banned") return assign(slug, "banned", null, side ?? banSide);
      const team = slot === "mine" ? draft.mine : draft.enemy;
      const guess = position ?? guessPosition(dataset.bySlug.get(slug), team);
      assign(slug, slot, guess);
    },
    [assign, banSide, dataset.bySlug, draft.enemy, draft.mine],
  );

  /** The ban panel's two headers arm the slot and the side in one click. */
  const activateBanSide = useCallback((slot: Slot, side: BanSide) => {
    setActiveSlot(slot);
    setBanSide(side);
  }, []);

  const applySuggestion = useCallback(
    (suggestion: Suggestion, slot: Slot) =>
      assignHero(suggestion.hero.slug, slot, suggestion.position ?? undefined),
    [assignHero],
  );

  const onSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Enter") return;
      const top = visibleHeroes[0];
      if (!top) return;
      assignHero(top.slug, e.shiftKey ? "banned" : activeSlot);
      setQuery("");
    },
    [assignHero, activeSlot, visibleHeroes],
  );

  const freshness = dataset.generatedAt ? shortDate(dataset.generatedAt) : null;

  /** Where every figure comes from, for the one status chip that stands for all of them. */
  const dataSources = [
    `${Object.keys(dataset.matchups).length} heroes · matchups from Dotabuff` +
      (dataset.generatedAt
        ? `, ${new Date(dataset.generatedAt).toLocaleDateString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
          })}`
        : ""),
    dataset.hasPositions ? "Positions and win rates by rank from STRATZ" : null,
    dataset.laneOutcomes
      ? `Lane outcomes from STRATZ, ${dataset.laneOutcomes.weeks.length} weeks`
      : null,
    dataset.hasSynergies
      ? `Synergies from ${dataset.synergyMatches.toLocaleString()} OpenDota matches`
      : null,
    dataset.hasTimings
      ? `Game length from ${dataset.timingMatches.toLocaleString()} OpenDota matches`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  /**
   * How old the data is, in days.
   *
   * Dota changes under these numbers. A patch reshapes the matchup table
   * overnight and nothing in the app would say so — the figures keep their
   * decimals and their confident colours while describing a game that no
   * longer exists. Age is the only staleness signal available without knowing
   * the patch calendar, and it is enough to prompt a re-scrape.
   */
  const ageInDays = (iso: string | null | undefined) =>
    iso ? (Date.now() - new Date(iso).getTime()) / 86_400_000 : null;

  const staleness = useMemo(() => {
    const parts: Array<{ label: string; days: number }> = [];
    for (const [label, iso] of [
      ["matchups", dataset.generatedAt],
      ["synergies", dataset.synergyGeneratedAt],
      ["timings", dataset.timingGeneratedAt],
      ["positions", dataset.positionsGeneratedAt],
      ["lanes", dataset.lanesGeneratedAt],
    ] as const) {
      const days = ageInDays(iso);
      if (days !== null && Number.isFinite(days) && days >= STALE_DAYS) {
        parts.push({ label, days: Math.round(days) });
      }
    }
    return parts;
  }, [
    dataset.generatedAt,
    dataset.synergyGeneratedAt,
    dataset.timingGeneratedAt,
    dataset.positionsGeneratedAt,
    dataset.lanesGeneratedAt,
  ]);

  return (
    /*
     * Opening the read-out turns the app from a fixed-viewport board into an
     * ordinary scrolling page. The panel is meant to be read whole, and a
     * scrollbar inside a scrollbar is the worst of both: the board loses half
     * its height *and* the panel still has to be scrolled.
     */
    <div
      className={`app ${
        (showAnalysis && analysis) || (showRebalance && rebalanceReport) ? "app-page" : ""
      }`}
    >
      <header className="topbar">
        <h1 className="brand">Draft Picker</h1>

        <RankFilter
          value={dataset.rankBand ?? settings.rankBand}
          available={dataset.positionBands ?? []}
          onChange={(band) => update("rankBand", band)}
        />

        <div className="topbar-status">
          {loading ? (
            <span className="tag">loading…</span>
          ) : dataset.hasData ? (
            <span className="tag tag-good" title={dataSources}>
              {freshness ? `data from ${freshness}` : "data loaded"}
            </span>
          ) : (
            <span className="tag tag-bad">no matchup data</span>
          )}
          {dataset.hasData && !dataset.hasPositions && (
            <span className="tag tag-bad" title="Rerun the scraper without --no-lanes">
              no position data
            </span>
          )}
          {staleness.length > 0 && (
            <span
              className="tag tag-warn"
              title={
                staleness.map((s) => `${s.label}: ${s.days} days old`).join(" · ") +
                " — Dota patches move these numbers. Rerun the collectors to refresh."
              }
            >
              {`${staleness[0]!.days}d old data`}
            </span>
          )}
          {dataset.hasData && !dataset.hasSynergies && (
            <span className="tag tag-warn" title="Run “npm run synergy” to add team synergy data">
              no synergy data
            </span>
          )}
        </div>

        <div className="topbar-actions">
          <div className="topbar-group" role="group" aria-label="Panels">
            {/*
              Always rendered, even before there is a draft to read: a control
              that appears only once both teams have a hero is one nobody finds.
              `aria-disabled` rather than `disabled` for the reason given on
              Rebalance below.
            */}
            <button
              type="button"
              ref={analysisButton}
              className="btn btn-primary"
              onClick={() => {
                if (!analysis) return;
                return showAnalysis ? closeAnalysis() : setShowAnalysis(true);
              }}
              aria-disabled={!analysis}
              aria-expanded={showAnalysis && !!analysis}
              title={
                analysis
                  ? `${analysis.verdict.label} — matchups ${formatSigned(analysis.counter, 1)}, ` +
                    `cohesion ${formatSigned(analysis.synergyEdge, 1)}. ` +
                    "Opens the game plan, the matchup map and the full breakdown."
                  : "Put a hero on each team to analyse the draft"
              }
            >
              Draft analysis
              {analysis && (
                <span
                  className={`num-chip ${
                    analysis.verdict.side === "even"
                      ? ""
                      : analysis.verdict.side === "mine"
                        ? "good"
                        : "bad"
                  }`}
                >
                  {formatSigned(analysis.advantage, 1)}
                </span>
              )}
            </button>
            {/*
              The one button in this bar that is about the heroes already spent
              rather than the next one. It carries its own headline because the
              case it exists for is the case you would not think to click it in:
              the enemy answers your first pick, and the fix is a seat away.
            */}
            {/*
              Every word and figure on this button comes from `rebalanceCopy`, the
              same module the panel reads. They used to phrase it separately and
              disagreed about both the number and what it was a number of.
            */}
            <button
              type="button"
              ref={rebalanceButton}
              className={`btn ${rebalanceReport?.best ? "btn-alert" : ""}`}
              onClick={() => {
                if (!rebalanceReady.ready) return;
                return showRebalance ? closeRebalance() : setShowRebalance(true);
              }}
              /*
                `aria-disabled` rather than `disabled`, because the whole value of
                the unavailable state here is the sentence explaining it — and a
                genuinely disabled button fires no mouse events, so its `title`
                never appears and the reader is left with a greyed-out control and
                no idea what it wants from them.
              */
              aria-disabled={!rebalanceReady.ready}
              aria-expanded={showRebalance && !!rebalanceReport}
              title={buttonTitle(rebalanceReport, rebalanceReady)}
            >
              {buttonLabel(rebalanceReport)}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setShowSettings((v) => !v)}
              aria-expanded={showSettings}
            >
              Tuning
            </button>
          </div>
          <div className="topbar-group" role="group" aria-label="Draft">
            <button type="button" className="btn" onClick={swapTeams} disabled={!total}>
              Swap sides
            </button>
            <button type="button" className="btn btn-danger" onClick={reset} disabled={!total}>
              Reset
            </button>
          </div>
        </div>
      </header>

      {showSettings && (
        <div className="settings">
          <label>
            <span>
              Meta weight <strong>{settings.metaWeight.toFixed(2)}</strong>
            </span>
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={settings.metaWeight}
              onChange={(e) => update("metaWeight", Number(e.target.value))}
            />
            <small>
              How much a hero's win rate counts next to the head-to-head numbers. 0 = pure
              counter-picking.
            </small>
          </label>

          <label>
            <span>
              Synergy weight <strong>{settings.synergyWeight.toFixed(2)}</strong>
            </span>
            <input
              type="range"
              min={0}
              max={3}
              step={0.05}
              value={settings.synergyWeight}
              onChange={(e) => update("synergyWeight", Number(e.target.value))}
              disabled={!dataset.hasSynergies}
            />
            <small>
              How much your own line-up counts next to countering theirs. At 1 a point of synergy is
              worth a point of matchup advantage; 0 goes back to pure counter-picking.
            </small>
          </label>

          <label>
            <span>
              Lane weight <strong>{settings.laneWeight.toFixed(2)}</strong>
            </span>
            <input
              type="range"
              min={0}
              max={3}
              step={0.1}
              value={settings.laneWeight}
              onChange={(e) => update("laneWeight", Number(e.target.value))}
            />
            <small>
              Extra weight on enemies you would share a lane with. 0 treats the whole enemy team
              equally; 1 counts your lane opponents double.
            </small>
          </label>

          <label>
            <span>
              Early weight <strong>{settings.earlyWeight.toFixed(2)}</strong>
            </span>
            <input
              type="range"
              min={0}
              max={5}
              step={0.25}
              value={settings.earlyWeight}
              onChange={(e) => update("earlyWeight", Number(e.target.value))}
            />
            <small>
              What a line-up is charged for having nobody who works before the median game. Only
              bites once you have stacked scaling heroes — the first two are free. 0 ignores when a
              draft wins entirely.
            </small>
          </label>

          <label>
            <span>
              Role threshold <strong>{Math.round(settings.minRoleFit * 100)}%</strong>
            </span>
            <input
              type="range"
              min={0}
              max={0.4}
              step={0.01}
              value={settings.minRoleFit}
              onChange={(e) => update("minRoleFit", Number(e.target.value))}
            />
            <small>
              A hero is only offered for a position if they play it at least this often. Raise it to
              see only dedicated heroes.
            </small>
          </label>

          <label>
            <span>
              Min. sample <strong>{settings.minMatches.toLocaleString()}</strong>
            </span>
            <input
              type="range"
              min={0}
              max={20000}
              step={250}
              value={settings.minMatches}
              onChange={(e) => update("minMatches", Number(e.target.value))}
            />
            <small>Ignore matchups Dotabuff has seen fewer times than this.</small>
          </label>

          <label>
            <span>
              Min. synergy sample <strong>{settings.minSynergyMatches.toLocaleString()}</strong>
            </span>
            <input
              type="range"
              min={0}
              max={5000}
              step={50}
              value={settings.minSynergyMatches}
              onChange={(e) => update("minSynergyMatches", Number(e.target.value))}
              disabled={!dataset.hasSynergies}
            />
            <small>
              Ignore pairings seen fewer times than this. Rare pairs are already shrunk towards zero,
              so this is a second safety net rather than the main one.
            </small>
          </label>

          <label>
            <span>
              Min. win rate <strong>{settings.minWinRate ? `${settings.minWinRate}%` : "off"}</strong>
            </span>
            <input
              type="range"
              min={0}
              max={54}
              step={0.5}
              value={settings.minWinRate}
              onChange={(e) => update("minWinRate", Number(e.target.value))}
            />
            <small>Drop heroes with a poor win rate out of the suggestions.</small>
          </label>

          <button type="button" className="btn" onClick={resetSettings}>
            Restore defaults
          </button>
        </div>
      )}

      {showRebalance && rebalanceReport && (
        <Rebalance
          report={rebalanceReport}
          bySlug={dataset.bySlug}
          lanePlan={draft.lanePlan}
          applied={appliedRebalance}
          onApply={applyRebalance}
          onUndo={undoRebalance}
          onLanePlan={setLanePlan}
          onClose={closeRebalance}
        />
      )}

      {showAnalysis && analysis && (
        <DraftAnalysis
          analysis={analysis}
          data={dataset}
          hasTimings={dataset.hasTimings}
          onClose={closeAnalysis}
        />
      )}

      {!loading && !dataset.hasData && (
        <div className="notice">
          <strong>Matchup data missing.</strong> The board works, but nothing can be recommended
          yet. Run <code>npm run scrape</code> once to build{" "}
          <code>public/data/matchups.json</code> from Dotabuff, then reload.
          {dataset.error && <div className="muted">{dataset.error}</div>}
        </div>
      )}

      <main className="layout">
        <aside className="col col-left">
          <TeamPanel
            title="My team"
            slot="mine"
            picks={draft.mine}
            size={TEAM_SIZE}
            bySlug={dataset.bySlug}
            active={activeSlot === "mine"}
            onActivate={setActiveSlot}
            onRemove={remove}
            onClear={clearSlot}
            onSetPosition={setPosition}
            hint="Alt+1"
          />
          <TeamPanel
            title="Enemy team"
            slot="enemy"
            picks={draft.enemy}
            size={TEAM_SIZE}
            bySlug={dataset.bySlug}
            active={activeSlot === "enemy"}
            onActivate={setActiveSlot}
            onRemove={remove}
            onClear={clearSlot}
            onSetPosition={setPosition}
            hint="Alt+2"
          />
          <BanPanel
            bans={draft.banned}
            bySlug={dataset.bySlug}
            active={activeSlot === "banned"}
            side={banSide}
            onActivate={activateBanSide}
            onRemove={remove}
            onClear={clearSlot}
            onSetSide={setBanSideOf}
            hint="Alt+3"
          />
        </aside>

        <section className="col col-center">
          <div className="controls">
            <input
              ref={searchRef}
              className="search"
              type="search"
              value={query}
              placeholder="Search heroes — try “pa”, “kotl”, “nevermore”…"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKeyDown}
              autoComplete="off"
              spellCheck={false}
            />
            <div className="seg" role="group" aria-label="What a click does">
              {(["mine", "enemy"] as Slot[]).map((slot) => (
                <button
                  key={slot}
                  type="button"
                  className={`seg-btn tone-${slot}`}
                  aria-pressed={activeSlot === slot}
                  onClick={() => setActiveSlot(slot)}
                >
                  <span className={`dot dot-${slot}`} aria-hidden />
                  {SLOT_LABEL[slot]}
                </button>
              ))}
              {/*
               * Two ban buttons rather than one, because "ban" is no longer a
               * complete instruction: the same click removes the same hero
               * either way, and which of the two it was is the only thing on
               * the board that says anything about the enemy's plan. A single
               * button would have to be followed by a correction in the panel
               * every other time, and the correction is the step people skip.
               */}
              {(["mine", "enemy"] as BanSide[]).map((side) => (
                <button
                  key={side}
                  type="button"
                  className={`seg-btn tone-ban-${side}`}
                  aria-pressed={activeSlot === "banned" && banSide === side}
                  onClick={() => activateBanSide("banned", side)}
                  title={
                    side === "enemy"
                      ? "Their bans are the ones the picker reads as a statement of intent"
                      : "Your own bans change what is available and nothing else"
                  }
                >
                  <span className={`dot dot-ban-${side}`} aria-hidden />
                  {BAN_SIDE_LABEL[side]}
                </button>
              ))}
            </div>
          </div>

          <div className="sortbar">
            <span className="sortbar-label muted">Sort</span>
            <div className="seg" role="group" aria-label="Sort the hero grid">
              {(["attr", "pick", "ban"] as SortMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`seg-btn ${SORT_TONE[mode]}`}
                  onClick={() => changeSort(mode)}
                  disabled={mode !== "attr" && !dataset.hasData}
                  title={SORT_HINT[mode]}
                  aria-pressed={sort === mode}
                >
                  {SORT_LABEL[mode]}
                </button>
              ))}
            </div>
            <span className="sortbar-label muted">Position</span>
            <PositionFilter
              className="position-filter-inline"
              label="Filter the hero grid by position"
              value={gridPosition}
              onChange={setGridPosition}
              needed={sort === "ban" ? enemyGaps : myGaps}
              disabled={!dataset.hasPositions}
              title={(p) =>
                p
                  ? `Score and rank the grid for ${POSITION_LABEL[p].toLowerCase()} — the suggestion panels keep their own filters`
                  : "Score the grid for no position in particular"
              }
            />
          </div>

          <p className="hints muted">
            Click a hero to add them as{" "}
            <strong>
              {(activeSlot === "banned"
                ? BAN_SIDE_LABEL[banSide]
                : SLOT_LABEL[activeSlot]
              ).toLowerCase()}
            </strong>{" "}
            — tiles glow{" "}
            <span className={`hint-slot hint-slot-${activeSlot}`}>
              {activeSlot === "mine" ? "green" : activeSlot === "enemy" ? "red" : "grey"}
            </span>{" "}
            to say so · <kbd>Shift</kbd>+click bans for {banSide === "mine" ? "you" : "them"} ·{" "}
            <kbd>Shift</kbd>+<kbd>Alt</kbd>+click bans for the other side · <kbd>Alt</kbd>+click
            sends to the other team · right-click removes · <kbd>Enter</kbd> takes the top search
            hit · hover the <span className="hint-info">i</span> on a tile for the full breakdown
            {dataset.hasPositions && (
              <span> · positions are guessed on pick and editable in the team panels</span>
            )}
          </p>

          <div className="grid-scroll">
            <HeroGrid
              heroes={sortedHeroes}
              grouped={!query && sort === "attr"}
              slotOf={slotOf}
              seatOf={seatOf}
              activeSlot={activeSlot}
              advantage={advantage}
              highlightPosition={gridPosition}
              minRoleFit={settings.minRoleFit}
              sort={sort}
              scores={gridScores}
              ranks={gridRanks}
              onAssign={assignHero}
              onRemove={remove}
              detailsFor={detailsFor}
              impactFor={impactFor}
              countersFor={countersFor}
              partnersFor={partnersFor}
              settings={settings}
              enemyCount={draft.enemy.length}
              myCount={draft.mine.length}
              hasSynergies={dataset.hasSynergies}
              banSideOf={banSideOf}
              banSide={banSide}
              intent={intentMap}
            />
          </div>
        </section>

        <aside className="col col-right">
          <Suggestions
            title="Pick these"
            subtitle={
              draft.enemy.length || (draft.mine.length && dataset.hasSynergies)
                ? [
                    draft.enemy.length
                      ? `Beats ${draft.enemy.length} enemy hero${draft.enemy.length > 1 ? "es" : ""}`
                      : null,
                    draft.mine.length && dataset.hasSynergies
                      ? `fits your ${draft.mine.length}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(", ")
                : "Strongest heroes right now — add picks to counter and combine"
            }
            mode="pick"
            suggestions={picks}
            position={effectivePickPosition}
            onPositionChange={setPickPosition}
            needed={myGaps}
            positionsAvailable={dataset.hasPositions}
            rankBand={dataset.rankBand}
            offRole={offRole}
            robust={robustPickSlugs}
            onApply={(s) => applySuggestion(s, "mine")}
            emptyMessage={
              dataset.hasData
                ? "No hero clears the role threshold for that position."
                : "Run the scraper to get recommendations."
            }
          />
          <Suggestions
            title="Ban these"
            subtitle={
              draft.mine.length || (draft.enemy.length && dataset.hasSynergies)
                ? `The enemy's best next pick${
                    draft.mine.length
                      ? ` against your ${draft.mine.length} hero${draft.mine.length > 1 ? "es" : ""}`
                      : ""
                  }${draft.enemy.length && dataset.hasSynergies ? ` and beside their ${draft.enemy.length}` : ""}`
                : "Most dangerous heroes overall — add picks to see targeted threats"
            }
            mode="ban"
            suggestions={bans}
            position={banPosition}
            onPositionChange={setBanPosition}
            needed={enemyGaps}
            positionsAvailable={dataset.hasPositions}
            rankBand={dataset.rankBand}
            robust={robustBanSlugs}
            onApply={(s) => applySuggestion(s, "banned")}
            emptyMessage={
              dataset.hasData
                ? "No hero clears the role threshold for that position."
                : "Run the scraper to get recommendations."
            }
          />

          {/*
           * Below the ban list rather than above it, and only once they have
           * spent bans. The ban list answers the question a captain asks every
           * turn; this answers one they ask occasionally and only after looking
           * at what the enemy has been doing, which is the order they should be
           * read in.
           */}
          {dataset.hasData && draft.banned.length > 0 && (
            <EnemyIntent
              reading={intent}
              nearMisses={nearMisses}
              banCount={theirBanCount}
              unattributed={theirBanCount === 0 && draft.banned.some((b) => b.by === null)}
              onBan={(slug) => assignHero(slug, "banned")}
              onPick={(slug) => assignHero(slug, "mine")}
            />
          )}

          {dataset.hasPositions && myGaps.length > 0 && draft.mine.length > 0 && (
            <p className="composition muted">
              {`Your team still needs ${myGaps
                .map((p) => `${p} ${POSITION_LABEL[p].toLowerCase()}`)
                .join(", ")}.`}
            </p>
          )}
        </aside>
      </main>
    </div>
  );
}
