import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HeroPortrait } from "./HeroPortrait";
import { PositionFilter } from "./PositionPicker";
import { formatSigned, scoreParts } from "../lib/scoring";
import { fromYourSide } from "../lib/perspective";
import { POSITIONS, POSITION_LABEL, positionFit } from "../lib/roles";
import { TARGET_EARLY_COVER } from "../lib/timing";
import type {
  Counter,
  DraftImpact,
  Hero,
  Partner,
  Position,
  ScoreMode,
  ScoreTerm,
  Settings,
  Slot,
  Suggestion,
} from "../types";

const ATTR_LABEL: Record<string, string> = {
  str: "Strength",
  agi: "Agility",
  int: "Intelligence",
  uni: "Universal",
};

const SLOT_LABEL: Record<Slot, string> = {
  mine: "On your team",
  enemy: "On the enemy team",
  banned: "Banned",
};

/** Long enough that sweeping the cursor across the grid stays quiet. */
const OPEN_DELAY = 90;
/** Short enough to feel closed, long enough to reach the card with the mouse. */
const CLOSE_DELAY = 160;

const GAP = 10;

export interface HoverCard {
  slug: string;
  /** The icon the card hangs off — kept live so scrolling can reposition it. */
  el: HTMLElement;
  /** Clicked open, so it survives the mouse leaving. */
  pinned: boolean;
}

/**
 * One card for the whole grid, opened by whichever tile the cursor is on.
 *
 * Hovering opens after a beat and closes after a slightly longer one, so the
 * pointer can travel from the icon into the card without it vanishing en route;
 * clicking pins the card open for reading and selecting.
 */
export function useHoverCard() {
  const [card, setCard] = useState<HoverCard | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const clear = useCallback(() => {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  const show = useCallback(
    (slug: string, el: HTMLElement) => {
      clear();
      timer.current = window.setTimeout(
        () => setCard((c) => (c?.pinned ? c : { slug, el, pinned: false })),
        OPEN_DELAY,
      );
    },
    [clear],
  );

  const hide = useCallback(() => {
    clear();
    timer.current = window.setTimeout(() => setCard((c) => (c?.pinned ? c : null)), CLOSE_DELAY);
  }, [clear]);

  const toggle = useCallback(
    (slug: string, el: HTMLElement) => {
      clear();
      setCard((c) => (c?.slug === slug && c.pinned ? null : { slug, el, pinned: true }));
    },
    [clear],
  );

  const close = useCallback(() => {
    clear();
    setCard(null);
  }, [clear]);

  useEffect(() => clear, [clear]);

  return { card, show, hide, keep: clear, toggle, close };
}

/**
 * Places the card beside its icon in viewport coordinates.
 *
 * The grid scrolls inside a clipped column, so the card is portalled to the
 * body and positioned by hand: to the right of the icon when there is room, to
 * the left when there is not, and always inside the viewport.
 */
function useCardPosition(anchor: HTMLElement, node: HTMLElement | null) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!node) return;

    const place = () => {
      const a = anchor.getBoundingClientRect();
      const { offsetWidth: w, offsetHeight: h } = node;
      const { innerWidth: vw, innerHeight: vh } = window;

      let left = a.right + GAP;
      if (left + w > vw - GAP) left = a.left - GAP - w;
      left = Math.max(GAP, Math.min(left, vw - GAP - w));

      const top = Math.max(GAP, Math.min(a.top - 6, vh - GAP - h));
      setPos({ top, left });
    };

    place();
    // Capture phase: the grid's own scroll container is what actually moves.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    const observer = new ResizeObserver(place);
    observer.observe(node);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      observer.disconnect();
    };
  }, [anchor, node]);

  return pos;
}

interface HeroCardLayerProps {
  anchor: HTMLElement;
  pinned: boolean;
  onClose: () => void;
  /** Cancels the pending close when the pointer lands on the card itself. */
  onKeep: () => void;
  onLeave: () => void;
  children: React.ReactNode;
}

export function HeroCardLayer({
  anchor,
  pinned,
  onClose,
  onKeep,
  onLeave,
  children,
}: HeroCardLayerProps) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const pos = useCardPosition(anchor, node);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!pinned) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!node?.contains(target) && !anchor.contains(target)) onClose();
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [pinned, node, anchor, onClose]);

  return createPortal(
    <div
      ref={setNode}
      className="herocard"
      role="tooltip"
      style={{
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        // Hidden for the single frame between mounting and measuring.
        visibility: pos ? "visible" : "hidden",
      }}
      onMouseEnter={onKeep}
      onMouseLeave={onLeave}
    >
      {children}
    </div>,
    document.body,
  );
}

interface HeroCardProps {
  detail: Suggestion;
  mode: ScoreMode;
  /** Where the hero already sits in the draft, if anywhere. */
  slot: Slot | undefined;
  /** The position they were drafted at — null until drafted and seated. */
  seat: Position | null;
  settings: Settings;
  /** How many heroes the score was measured against, and on which side. */
  opponentCount: number;
  allyCount: number;
  hasSynergies: boolean;
  /** What taking this hero would do to the whole draft, if it can be read. */
  impact?: DraftImpact | null;
  /**
   * The heroes who beat this one, worst first — board-independent, and asked
   * per role so the card's filter can re-rank the field rather than thin it.
   */
  countersFor?: (slug: string, position: Position | null) => Counter[];
  /**
   * The heroes this one belongs beside, best first. `ownPosition` is `seat`, so
   * a drafted hero's filtered row reads each pair in the two seats asked about.
   */
  partnersFor?: (
    slug: string,
    position: Position | null,
    ownPosition: Position | null,
  ) => Partner[];
  /** Where any hero sits in the draft, so the face rows can show as taken. */
  slotOf: (slug: string) => Slot | undefined;
  /** Sends a counter to the ban list, or takes it back off. */
  onBan: (slug: string) => void;
  /** Sends a partner to your line-up, or takes them back off. */
  onPick: (slug: string) => void;
}

/**
 * The headline moving, and the lane that moves most with it.
 *
 * The score above says what the hero is worth on average; this says what the
 * board looks like afterwards, which is the thing being decided. The two can
 * disagree honestly — an average pick that fixes the lane you are losing is
 * often the right one — and where they do, this is the half a captain acts on.
 */
function Impact({ impact, mode }: { impact: DraftImpact; mode: ScoreMode }) {
  const chance = impact.unit === "chance";
  const move = impact.after - (impact.before ?? 0);
  const shownMove = chance ? Math.round(impact.after) - Math.round(impact.before ?? 0) : move;
  // Past the calibrated range the ends print as bounds, and a move between
  // two figures the card will not print is no more honest than they are.
  const showMove = !chance || (impact.shown?.inRange ?? true);
  const arrow = mode === "ban" ? "if they take them" : "if you take them";
  const label = chance ? "win chance " : "draft ";
  const figure = (n: number) => (chance ? `${Math.round(n)}%` : formatSigned(n, 1));
  // The headline's own text where there is one; colour stays on the raw figure.
  const before = impact.shown?.before ?? (impact.before === null ? null : figure(impact.before));
  const after = impact.shown?.after ?? figure(impact.after);
  const good = (n: number) => (chance ? n >= 50 : n >= 0);
  return (
    <section className="hc-section hc-impact">
      <h4>The board afterwards</h4>
      <p className="hc-impact-line">
        {before === null ? (
          <>
            <span className="muted">{label}</span>
            <strong className={good(impact.after) ? "good" : "bad"}>{after}</strong>
          </>
        ) : (
          <>
            <span className="muted">{label}</span>
            <span className="hc-impact-from">{before}</span>
            <span className="muted" aria-label="becomes">
              {" → "}
            </span>
            <strong className={good(impact.after) ? "good" : "bad"}>{after}</strong>
            {showMove && (
              <span className={`hc-impact-move ${shownMove >= 0 ? "good" : "bad"}`}>
                {`(${formatSigned(shownMove, chance ? 0 : 1)})`}
              </span>
            )}
          </>
        )}
        <span className="muted"> {arrow}</span>
      </p>
      {impact.lane && (
        <p className="hc-impact-lane muted">
          {`${impact.lane.label} ${formatSigned(impact.lane.delta, 1)} → ${formatSigned(
            impact.lane.after,
            1,
          )}`}
          {" · the front this pick moves most"}
        </p>
      )}
    </section>
  );
}

/** One face in a row: a hero, the figure under them, and what it means. */
interface Face {
  hero: Hero;
  /** The number printed under the portrait, already read from your side. */
  value: number;
  /** The right-hand half of the read-out's first line. */
  note: string;
  /** The read-out's second line, before the draft state is appended. */
  detail: string;
}

const STATE_NOTE: Record<Slot, string> = {
  banned: " · already banned",
  enemy: " · already on the enemy team",
  mine: " · already on your team",
};

/**
 * A row of hero faces with one action behind them.
 *
 * Every other list on this card is about the board as it stands. The two rows
 * built from this are about the board that has not happened yet — the answers
 * the enemy still has to a hero you are considering, and the heroes that hero
 * belongs beside. That makes them the only parts of the card worth reading
 * before a single hero is picked, which is exactly when a ban is cheap and a
 * plan is still possible.
 *
 * Faces rather than another table, because the action each row feeds is aimed
 * at a portrait: you ban Axe, you do not ban a row in a list. The numbers are
 * all on screen at once rather than hidden behind the hover, because five
 * unlabelled faces is a ranking you can only trust and five with figures under
 * them is one you can disagree with. Hovering adds the part that will not fit —
 * the win rate and the sample it rests on — in a line below, which stays inside
 * the card rather than opening a second popover over the one being read.
 */
function FaceRow({
  title,
  hint,
  faces,
  subject,
  slotOf,
  onClick,
  action,
  empty,
}: {
  title: string;
  hint: string;
  faces: Face[];
  /** The hero the card is about — only used to reset the hover between tiles. */
  subject: Hero;
  slotOf: (slug: string) => Slot | undefined;
  onClick: (slug: string) => void;
  /** Where a click sends the hero, which also decides what a click cannot do. */
  action: "banned" | "mine";
  /**
   * What to say when there is nothing to show. Absent means say nothing at all
   * and drop the section, which is right for a hero with no counters — but wrong
   * the moment a role filter is on, because a row that vanishes looks like a bug
   * and leaves the reader no chips to click their way back out with.
   */
  empty?: string;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  // The card layer is reused as the pointer moves between tiles, so the hover
  // has to be dropped when the hero underneath it changes.
  useEffect(() => setHovered(null), [subject.slug]);

  const header = (
    <h4>
      {title}
      <span className="hc-face-hint">{hint}</span>
    </h4>
  );

  if (!faces.length) {
    if (!empty) return null;
    return (
      <section className={`hc-section hc-faces hc-faces-${action}`}>
        {header}
        <p className="hc-none muted">{empty}</p>
      </section>
    );
  }

  const shown = faces.find((f) => f.hero.slug === hovered) ?? faces[0]!;
  const shownSlot = slotOf(shown.hero.slug);
  const verb = action === "banned" ? "ban" : "add to your team";

  return (
    <section className={`hc-section hc-faces hc-faces-${action}`}>
      {header}

      <div className="hc-face-row">
        {faces.map((f) => {
          const slot = slotOf(f.hero.slug);
          /**
           * What this click must refuse to do.
           *
           * A ban cannot reach into a line-up, and a pick cannot reach into the
           * enemy's or the ban list — either would be a far larger edit than a
           * click on a small portrait looks like it is making. A hero already
           * where the click would send them is left clickable, because there
           * `assign` simply undoes it.
           */
          const locked =
            action === "banned"
              ? slot === "mine" || slot === "enemy"
              : slot === "enemy" || slot === "banned";
          return (
            <button
              key={f.hero.slug}
              type="button"
              className={`hc-face ${slot ? `hc-face-${slot}` : ""}`}
              disabled={locked}
              onMouseEnter={() => setHovered(f.hero.slug)}
              onFocus={() => setHovered(f.hero.slug)}
              onMouseLeave={() => setHovered((h) => (h === f.hero.slug ? null : h))}
              onBlur={() => setHovered((h) => (h === f.hero.slug ? null : h))}
              onClick={() => onClick(f.hero.slug)}
              aria-label={
                `${f.hero.name} — ${f.note}, ${f.detail}` +
                (locked
                  ? `; already ${slot === "banned" ? "banned" : "drafted"}`
                  : slot === action
                    ? "; click to undo"
                    : `; click to ${verb}`)
              }
            >
              <HeroPortrait hero={f.hero} />
              <span className={`hc-face-value ${f.value >= 0 ? "good" : "bad"}`}>
                {formatSigned(f.value, 1)}
              </span>
              {slot === "banned" && <span className="hc-face-mark" aria-hidden />}
            </button>
          );
        })}
      </div>

      {/*
       * Both figures, because either alone misleads in both directions. Pudge
       * takes 54.9% off Timbersaw and it is still his worst matchup in the
       * game; Io and Drow are the best pairing Io has and the two of them win
       * 47.6% together. A win rate without the edge reads as a hero doing fine,
       * and an edge without the win rate reads as a hero winning.
       */}
      <p className="hc-face-readout">
        <span className="hc-face-readout-head">
          <strong>{shown.hero.name}</strong>
          <span className="muted">{shown.note}</span>
        </span>
        <span className="muted">
          {shown.detail}
          {shownSlot ? STATE_NOTE[shownSlot] : ""}
        </span>
      </p>
    </section>
  );
}

/**
 * D2PT's `role` values, limited to ones seen in a real D2PT URL. Positions
 * without an entry link to the builds unfiltered, and D2PT opens those on the
 * hero's most popular role.
 */
const D2PT_ROLE: Partial<Record<Position, string>> = { 1: "carry" };

/** D2PT addresses heroes by display name, e.g. `/hero/Nature's%20Prophet`. */
function d2ptBuildsUrl(hero: Hero, role: string | undefined): string {
  const url = `https://dota2protracker.com/hero/${encodeURIComponent(hero.name)}?section=builds`;
  return role ? `${url}&role=${role}` : url;
}

/** The usual box-and-arrow, drawn small enough to sit beside the hero's name. */
function ExternalLinkIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      <path d="M9.5 2.5H13.5V6.5" />
      <path d="M13.5 2.5 7.5 8.5" />
      <path d="M12.5 9.5v3a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1h3" />
    </svg>
  );
}

/**
 * The prose half of one score row. The number half comes from `scoreParts`, so
 * this table only has to say what a term *means* — it can neither invent a term
 * the score does not have nor forget one it does.
 */
interface PartCopy {
  label: string;
  detail?: string;
  /** Rows that would read "0.00" on an ordinary hero are dropped instead. */
  hideBelow?: number;
}

/**
 * Everything behind a tile's badge: the parts the score is made of, and every
 * pairing that fed them.
 *
 * The suggestion panels only have room for the two or three strongest chips;
 * this is the same data with nothing dropped, for the hero you are actually
 * looking at.
 */
export function HeroCard({
  detail,
  mode,
  slot,
  seat,
  settings,
  opponentCount,
  allyCount,
  hasSynergies,
  impact,
  countersFor = () => [],
  partnersFor = () => [],
  slotOf,
  onBan,
  onPick,
}: HeroCardProps) {
  const { hero } = detail;

  /**
   * Which seat the two face rows are being asked about.
   *
   * Kept beside the slug it was chosen for rather than reset by an effect: the
   * card layer is one component reused as the pointer sweeps the grid, so an
   * effect would leave one frame in which last hero's filter is applied to this
   * hero's rows — and the rows are exactly what the reader is looking at. Held
   * per-hero rather than globally because a filter that survives the card is a
   * setting, and this is a question ("who answers them from pos 4?") that the
   * next hero has not been asked.
   */
  const [role, setRole] = useState<{ slug: string; position: Position | null }>({
    slug: hero.slug,
    position: null,
  });
  const rolePosition = role.slug === hero.slug ? role.position : null;
  const setRolePosition = useCallback(
    (position: Position | null) => setRole({ slug: hero.slug, position }),
    [hero.slug],
  );

  const counters = useMemo(
    () => countersFor(hero.slug, rolePosition),
    [countersFor, hero.slug, rolePosition],
  );
  const partners = useMemo(
    () => partnersFor(hero.slug, rolePosition, seat),
    [partnersFor, hero.slug, rolePosition, seat],
  );

  /**
   * How much of a filtered hero's games are actually spent in the seat asked
   * about, appended to their read-out while the filter is on.
   *
   * The floor is `minRoleFit`, which is deliberately loose — 8% of games — so
   * the row can answer "who is the pos 5 that beats them" for a hero whose fifth
   * position is a real but uncommon build. Slark spends 17% of his games in the
   * safe-lane support slot and belongs in that row; without the figure beside him
   * he reads as a pos 5 the way Lion is one, and the two claims are not the same
   * size.
   */
  const roleShare = (candidate: Hero) =>
    rolePosition && candidate.positions
      ? ` · ${Math.round(positionFit(candidate, rolePosition) * 100)}% pos ${rolePosition}`
      : "";

  /**
   * The app's one rule: every number is what it does to *your* draft. Ban
   * candidates are scored from the enemy's seat, so their numbers are flipped
   * here — a hero who is +6 for them is −6 for you. See `fromYourSide`.
   */
  const { mine, tone } = fromYourSide(mode);

  // Which side of the board each half of the score looks at, from your seat.
  const facing = mode === "ban" ? "your line-up" : "their line-up";
  const beside = mode === "ban" ? "their line-up" : "your line-up";

  // A hero already on one of the teams cannot be measured against themselves,
  // so they do not count towards the pairings on their own side.
  const opponents = opponentCount - (slot === (mode === "ban" ? "mine" : "enemy") ? 1 : 0);
  const allies = allyCount - (slot === (mode === "ban" ? "enemy" : "mine") ? 1 : 0);

  /**
   * What the Meta win rate actually describes.
   *
   * Dotabuff only lists a hero in the lanes they turn up in, so asking for a
   * position they never play falls back to their overall figure — Lich has no
   * mid-lane row at all, and reading his 52.6% under a `pos 2` filter as a mid
   * win rate would be wrong. Say which number is on screen rather than letting
   * the position filter imply it.
   */
  const winRateBasis =
    detail.position === null
      ? "win rate"
      : hero.positionWinRate?.[detail.position] !== undefined
        ? `win rate as pos ${detail.position}`
        : `win rate overall · no pos ${detail.position} data`;

  /** How many of the pairings were read off a core/support cell. */
  const positionalPairs = detail.synergyContributions.filter((c) => c.positional).length;

  /**
   * What each term of the score means, in the order a captain reads them.
   *
   * Only the words live here. The numbers come from `scoreParts`, the same list
   * `evaluate` adds up to get the headline, so the rows below cannot fail to
   * account for it. They used to be built by hand from the same fields, which
   * is how the `intent` term came to be in the headline and in no row at all —
   * on a hero the enemy had been clearing the way for, the card showed rows
   * summing to +0.18 beneath a headline of +4.83.
   */
  const copy: Record<ScoreTerm, PartCopy> = {
    matchups: {
      label: "Matchups",
      detail: detail.covered
        ? `${detail.covered} of ${opponents} in ${facing} · lane counts double`
        : opponents
          ? "no pairing above the sample floor"
          : `nothing in ${facing} to measure against yet`,
    },
    synergy: {
      label: "Synergy",
      detail: detail.synergyContributions.length
        ? `${detail.synergyContributions.length} of ${allies} in ${beside}` +
          // Most pairings read the same however they are played. Where one does
          // not, the number on screen is the one for these two positions, and
          // that is worth saying — it is why the same pair can score differently
          // at pos 2 and pos 4.
          (positionalPairs
            ? ` · ${positionalPairs === detail.synergyContributions.length ? "by" : `${positionalPairs} by`} role`
            : "") +
          ` · ×${settings.synergyWeight.toFixed(2)}`
        : !hasSynergies
          ? "no synergy data loaded"
          : allies
            ? "no pairing above the sample floor"
            : `nothing in ${beside} to pair with yet`,
    },
    meta: {
      label: "Meta",
      detail:
        `${detail.winRate.toFixed(1)}% ${winRateBasis}` +
        (mode === "ban" && hero.pickRate ? ` · ${hero.pickRate.toFixed(1)}% picked` : "") +
        ` · ×${settings.metaWeight.toFixed(2)}`,
    },
    /**
     * The only term that is about the *opponent* rather than about the hero.
     *
     * Ban mode only, and zero unless the enemy's own bans have been clearing
     * this hero's answers off the board — see `readIntent`. It is the loudest
     * term the score has when it fires at all, which is exactly why leaving it
     * off the card was the worst of the missing rows: the card was silent about
     * the single largest reason the hero was at the top of the list.
     */
    intent: {
      label: "Their plan",
      detail:
        `their bans cleared ${detail.intentScore.toFixed(1)} points of counter-play ` +
        `from this hero's path · ×${settings.intentWeight.toFixed(2)}`,
      hideBelow: 0.01,
    },
    /**
     * The only row on this card that is not about the hero.
     *
     * Every other part answers "what are they worth"; this one answers "what does
     * the side look like once they are on it", and it is the only way the card
     * can say the thing no per-hero figure can — that a fifth scaling hero is a
     * fine pick and a bad draft. Shown only when it is actually charging
     * something, because a row reading "0.00" on every ordinary suggestion is
     * noise that trains the reader to stop looking at the list.
     */
    early: {
      label: "Early game",
      detail:
        detail.teamEarlyCover !== null
          ? `this side would field ${detail.teamEarlyCover.toFixed(1)} of ${TARGET_EARLY_COVER} heroes ` +
            `who work before the median game` +
            (detail.earlyCover !== null ? ` · they are ${detail.earlyCover.toFixed(2)} of one` : "")
          : undefined,
      hideBelow: 0.01,
    },
  };

  /**
   * The rows that earned their place.
   *
   * A term with a `hideBelow` is dropped while it is doing nothing, so the card
   * stays four rows on an ordinary hero — but only ever below the threshold,
   * which is small enough that what is dropped could not have moved the
   * headline by a visible amount. The three standing terms are never dropped:
   * "no pairing above the sample floor" is itself an answer.
   */
  const parts = scoreParts(detail, settings)
    .map((part) => ({ ...part, ...copy[part.term] }))
    .filter((part) => part.hideBelow === undefined || Math.abs(part.value) >= part.hideBelow);

  const played = POSITIONS.map((p) => ({ position: p, share: hero.positions?.[p] ?? 0 }))
    .filter((p) => p.share >= 0.03)
    .sort((a, b) => b.share - a.share);

  const d2ptRole = detail.position ? D2PT_ROLE[detail.position] : undefined;

  return (
    <>
      <header className="hc-head">
        <HeroPortrait hero={hero} className="hc-portrait" />
        <div className="hc-title">
          <strong>{hero.name}</strong>
          <span className="muted">
            {ATTR_LABEL[hero.attr] ?? hero.attr}
            {hero.tier ? ` · tier ${hero.tier}` : ""}
            {hero.banRate !== undefined ? ` · banned in ${hero.banRate.toFixed(1)}% of games` : ""}
          </span>
        </div>
        {/*
         * Out to the sources: Dotabuff for the full hero page, D2PT for
         * high-MMR builds, in this card's seat where `D2PT_ROLE` knows it. New
         * tab, because losing a half-made draft to a click on a small icon
         * would be a poor trade.
         */}
        <span className="hc-links">
          <a
            className="hc-link"
            href={`https://www.dotabuff.com/heroes/${hero.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            title={`Open ${hero.name} on Dotabuff`}
            aria-label={`Open ${hero.name} on Dotabuff in a new tab`}
          >
            <ExternalLinkIcon />
          </a>
          <a
            className="hc-link hc-link-d2pt"
            href={d2ptBuildsUrl(hero, d2ptRole)}
            target="_blank"
            rel="noopener noreferrer"
            title={
              d2ptRole
                ? `Open ${hero.name} pos ${detail.position} builds on Dota2ProTracker`
                : `Open ${hero.name} builds on Dota2ProTracker · their most popular role`
            }
            aria-label={`Open ${hero.name} builds on Dota2ProTracker in a new tab`}
          >
            D2PT
          </a>
        </span>
      </header>

      {slot && <p className={`hc-slot hc-slot-${slot}`}>{SLOT_LABEL[slot]}</p>}

      <div className="hc-score">
        <span className={`hc-score-value score ${tone(detail.score)}`}>
          {formatSigned(mine(detail.score))}
        </span>
        {/*
         * Which question this number answers, spelled out.
         *
         * The card is scored for whatever the *grid* is sorting and filtering
         * for, and the suggestion panel beside it is scored for its own seat.
         * So the same hero can honestly read −0.5 here and +2.3 there — one is
         * what he is worth to the enemy at any position, the other what he is
         * worth to you at pos 3 — and with only "off your draft score" written
         * under it there was no way to tell that from a contradiction. Naming
         * the seat costs four words and settles it.
         */}
        <span className="muted">
          {slot
            ? "worth to your draft, scored where the board stands"
            : mode === "ban"
              ? "off your draft score if the enemy takes them"
              : "on your draft score if you pick them"}
          {detail.position
            ? ` as pos ${detail.position}`
            : " · scored for any position"}
        </span>
      </div>

      <ul className="hc-parts">
        {parts.map((part) => (
          <li key={part.term}>
            <span className="hc-part-label">{part.label}</span>
            <span className={`hc-part-value ${tone(part.value)}`}>
              {formatSigned(mine(part.value), 2)}
            </span>
            {part.detail && <span className="hc-part-detail muted">{part.detail}</span>}
          </li>
        ))}
      </ul>

      {impact && <Impact impact={impact} mode={mode} />}

      {played.length > 0 && (
        <section className="hc-section">
          <h4>Positions played</h4>
          <div className="hc-chips">
            {played.map(({ position, share }) => {
              const wr = hero.positionWinRate?.[position];
              return (
                <span
                  key={position}
                  className={`tag pos-${position} ${position === detail.position ? "hc-chip-on" : ""}`}
                  title={`${POSITION_LABEL[position]} · ${
                    wr ? `${wr.toFixed(1)}% win rate there` : "no separate win rate"
                  }`}
                >
                  pos {position} · {Math.round(share * 100)}%
                </span>
              );
            })}
          </div>
        </section>
      )}

      {/*
       * One filter for both rows below.
       *
       * The five hardest answers to a hero are usually five cores, and a captain
       * filling the 4 slot cannot use them: the row is right about the pool and
       * wrong about the seat. The chips ask the same two questions of one
       * position at a time — the five pos 4s who beat this hero, the five pos 4s
       * who want to stand beside them — which is the form the question is
       * actually in during a draft.
       *
       * It governs the two rows directly below only. Everything below them is
       * about heroes already on the board, where the position is not a filter but
       * a fact.
       *
       * Hidden when there is nothing to filter, so a hero with no answers and no
       * pairings does not get a row of dead chips.
       */}
      {(counters.length > 0 || partners.length > 0 || rolePosition !== null) && (
        <section className="hc-section hc-rolefilter">
          <h4>
            Filter both rows
            <span className="hc-face-hint">
              {rolePosition
                ? `pos ${rolePosition} · ${POSITION_LABEL[rolePosition].toLowerCase()}`
                : "any position"}
            </span>
          </h4>
          <PositionFilter
            value={rolePosition}
            onChange={setRolePosition}
            className="position-filter-card"
            label={`Position filter for the counter and partner rows of ${hero.name}`}
            title={(position) =>
              position
                ? `Only heroes who play pos ${position} — ${POSITION_LABEL[position]}`
                : "Any position"
            }
          />
        </section>
      )}

      <FaceRow
        title="Countered by"
        hint={mode === "ban" ? "beat them with these" : "worth a ban"}
        subject={hero}
        slotOf={slotOf}
        onClick={onBan}
        action="banned"
        empty={
          rolePosition
            ? `No pos ${rolePosition} hero beats ${hero.name} by enough to be worth a ban.`
            : undefined
        }
        faces={counters.map((c) => ({
          hero: c.hero,
          value: mine(-c.advantage),
          note: `${c.advantage.toFixed(1)} below par${roleShare(c.hero)}`,
          detail:
            c.winRate !== null
              ? `${hero.name} wins ${c.winRate.toFixed(1)}% of ${c.matches.toLocaleString()} games`
              : `over ${c.matches.toLocaleString()} games`,
        }))}
      />

      {/*
       * Pairing strength and nothing else — no win rate, no role fit — so the
       * hint says so. "Pick these" adds the rest, and a hero this row leads with
       * can honestly sit sixth there.
       */}
      <FaceRow
        title="Best with"
        hint={mode === "ban" ? "their strongest pairings" : "by synergy alone"}
        subject={hero}
        slotOf={slotOf}
        onClick={onPick}
        action="mine"
        empty={
          rolePosition
            ? hasSynergies
              ? `No pos ${rolePosition} hero pairs with ${hero.name}` +
                (seat ? ` at pos ${seat}` : "") +
                " above the sample floor."
              : "Run `npm run synergy` to add pairing data."
            : undefined
        }
        faces={partners.map((p) => ({
          hero: p.hero,
          value: mine(p.synergy),
          note:
            `${p.synergy.toFixed(2)} ${p.positional ? "in these roles" : "as a pair"}` +
            roleShare(p.hero),
          detail:
            p.positional && seat && rolePosition
              ? `${p.matches.toLocaleString()} games with ${hero.name} at pos ${seat} ` +
                `and ${p.hero.name} at pos ${rolePosition}`
              : `together they win ${p.winRate.toFixed(1)}% of ${p.matches.toLocaleString()} games`,
        }))}
      />

      <section className="hc-section">
        <h4>{mode === "ban" ? "Against your picks" : "Against their picks"}</h4>
        {detail.contributions.length === 0 ? (
          <p className="hc-none muted">
            {opponents
              ? "Nothing above the sample floor."
              : mode === "ban"
                ? "Add your own picks to see what this hero beats."
                : "Add enemy picks to see the matchups."}
          </p>
        ) : (
          <ul className="hc-rows">
            {detail.contributions.map((c) => (
              <li key={c.slug}>
                <span className="hc-row-name">
                  {c.sameLane && (
                    <span className="hc-lane" title="Shares a lane — counted double">
                      ⚔
                    </span>
                  )}
                  {c.name}
                  {/*
                   * The one figure in this list that is not Dotabuff's. A lane
                   * confrontation is the only place the app knows what happened
                   * to the games of a hero standing in *this* seat against this
                   * opponent, so where that row exists it is added to the
                   * whole-game advantage — and named, because the two are
                   * different measurements and the reader is owed the split.
                   */}
                  {c.laneEdge !== undefined && Math.abs(c.laneEdge) >= 0.005 && (
                    <span
                      className={`hc-seat ${tone(c.laneEdge)}`}
                      title={
                        // Direction spelled out rather than left to the sign,
                        // for the same reason `matchupTitle` spells it out: the
                        // figure is flipped to your side in ban mode, and a
                        // sentence that names a hero has to name whose games
                        // went which way or it contradicts its own number.
                        `${formatSigned(mine(c.laneEdge), 2)} of this is the seat: from pos ` +
                        `${detail.position} against ${mode === "ban" ? `your ${c.name}` : c.name} ` +
                        `in lane, ${mode === "ban" ? "their" : "these"} games went ` +
                        `${Math.abs(c.laneEdge).toFixed(2)} points ` +
                        `${c.laneEdge >= 0 ? "better" : "worse"} than the whole-game matchup says, ` +
                        `over ${(c.laneLanes ?? 0).toLocaleString()} lanes (STRATZ). Lanes drafted ` +
                        `by people choosing to counter-pick, so part of the edge is the player ` +
                        `rather than the hero.`
                      }
                    >
                      seat {formatSigned(mine(c.laneEdge), 2)}
                    </span>
                  )}
                </span>
                <span className="muted hc-row-n">{c.matches.toLocaleString()}</span>
                <span className={`hc-row-value ${tone(c.advantage)}`}>
                  {formatSigned(mine(c.advantage), 2)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="hc-section">
        <h4>{mode === "ban" ? "Beside their picks" : "Beside your picks"}</h4>
        {detail.synergyContributions.length === 0 ? (
          <p className="hc-none muted">
            {hasSynergies
              ? allies
                ? "Nothing above the sample floor."
                : `Add ${mode === "ban" ? "enemy" : "your"} picks to see pairings.`
              : "Run `npm run synergy` to add pairing data."}
          </p>
        ) : (
          <ul className="hc-rows">
            {detail.synergyContributions.map((c) => (
              <li key={c.slug}>
                <span className="hc-row-name">{c.name}</span>
                <span className="muted hc-row-n">{c.matches.toLocaleString()}</span>
                <span className={`hc-row-value ${tone(c.synergy)}`}>
                  {formatSigned(mine(c.synergy), 2)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="hc-foot muted">
        Numbers are percentage points of win rate, from your side · click the icon to pin
      </p>
    </>
  );
}
