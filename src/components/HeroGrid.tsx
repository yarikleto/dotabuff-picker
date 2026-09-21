import { memo, useCallback } from "react";
import { HeroCard, HeroCardLayer, useHoverCard } from "./HeroCard";
import { HeroPortrait } from "./HeroPortrait";
import { formatSigned } from "../lib/scoring";
import { fromYourSide } from "../lib/perspective";
import { POSITION_LABEL, canPlay, positionSummary } from "../lib/roles";
import type {
  BanSide,
  Counter,
  DraftImpact,
  Hero,
  HeroAttr,
  Partner,
  Position,
  Settings,
  Slot,
  SortMode,
  Suggestion,
} from "../types";

const ATTR_LABEL: Record<HeroAttr, string> = {
  str: "Strength",
  agi: "Agility",
  int: "Intelligence",
  uni: "Universal",
};

const ATTR_ORDER: HeroAttr[] = ["str", "agi", "int", "uni"];

const SLOT_ORDER: Slot[] = ["mine", "enemy", "banned"];

/** Reads as the tail of "add X to …" / "remove X from …". */
const SLOT_PLACE: Record<Slot, string> = {
  mine: "your team",
  enemy: "the enemy team",
  banned: "the ban list",
};

/**
 * Colour is what tells these three apart — the same green, red and grey as the
 * click-target selector and the team panels — so the glyph only has to say
 * whether the click adds or takes away.
 */
const SLOT_GLYPH: Record<Slot, string> = { mine: "+", enemy: "+", banned: "✕" };

export interface HeroGridProps {
  heroes: Hero[];
  grouped: boolean;
  slotOf: Map<string, Slot>;
  /** The position each drafted hero was given, for the card's partner row. */
  seatOf: Map<string, Position | null>;
  activeSlot: Slot;
  /**
   * What each hero is worth to the draft, in percentage points: their matchups
   * against the enemy plus their synergy with your own picks.
   */
  advantage: Map<string, number>;
  /** When set, heroes who do not play this position are dimmed. */
  highlightPosition: Position | null;
  minRoleFit: number;
  /** How the list is ordered — decides what the tile badge shows. */
  sort: SortMode;
  /** Ranking score per hero for the active sort, when not sorting by attribute. */
  scores: Map<string, number>;
  /**
   * Where each hero places in that ranking, 1-based.
   *
   * Passed in rather than counted off the tiles, because those are two
   * different numbers the moment anything is filtered — see `tileRank`.
   */
  ranks: Map<string, number>;
  onAssign: (slug: string, slot: Slot, position?: Position | null, side?: BanSide) => void;
  onRemove: (slug: string) => void;
  /** Full breakdown for one hero, computed on demand when a card opens. */
  detailsFor: (slug: string) => Suggestion | null;
  /** What the draft becomes if this hero is taken — also on demand. */
  impactFor: (slug: string, position: Position | null) => DraftImpact | null;
  /**
   * The heroes who beat this one, whatever is on the board — also on demand,
   * and narrowable to a single position by the card's own role filter.
   */
  countersFor: (slug: string, position: Position | null) => Counter[];
  /**
   * The heroes this one belongs beside. Asked with the hero's own seat once
   * drafted, so both positions can be read as the pick list reads them.
   */
  partnersFor: (
    slug: string,
    position: Position | null,
    ownPosition: Position | null,
  ) => Partner[];
  settings: Settings;
  /** Sizes of the two line-ups, so the card can say "2 of 3 enemy picks". */
  enemyCount: number;
  myCount: number;
  hasSynergies: boolean;
  /** Whose ban a banned hero was, for the strike-through colour. */
  banSideOf: Map<string, BanSide>;
  /** Which side a ban click credits. */
  banSide: BanSide;
  /**
   * Counter-play the enemy's own bans cleared, per hero — see `readIntent`.
   * Tiles carrying a reading get a mark, so the signal is visible while
   * browsing the pool and not only in the panel that spells it out.
   */
  intent: Map<string, number>;
}

const otherTeam = (slot: Slot): Slot => (slot === "enemy" ? "mine" : "enemy");
const otherSide = (side: BanSide): BanSide => (side === "mine" ? "enemy" : "mine");

const HeroTile = memo(function HeroTile({
  hero,
  slot,
  bannedBy,
  advantage,
  ranked,
  score,
  cleared,
  rank,
  activeSlot,
  banSide,
  offRole,
  onAssign,
  onRemove,
  onInfoEnter,
  onInfoLeave,
  onInfoClick,
  infoOpen,
}: {
  hero: Hero;
  slot: Slot | undefined;
  /** Whose ban took them off the board, when the slot is `banned`. */
  bannedBy: BanSide | undefined;
  advantage: number | undefined;
  /** Whether the grid is ordered by a score at all, or just browsing by attribute. */
  ranked: boolean;
  /** Ranking score for the active sort; undefined when sorting by attribute. */
  score: number | undefined;
  /** Counter-play the enemy's bans cleared for this hero; 0 when they said nothing. */
  cleared: number;
  /** 1-based place in the whole ranking, for the top few — not the tile's row. */
  rank: number | undefined;
  activeSlot: Slot;
  banSide: BanSide;
  offRole: boolean;
  onAssign: HeroGridProps["onAssign"];
  onRemove: HeroGridProps["onRemove"];
  onInfoEnter: (slug: string, el: HTMLElement) => void;
  onInfoLeave: () => void;
  onInfoClick: (slug: string, el: HTMLElement) => void;
  infoOpen: boolean;
}) {
  const handleClick = (e: React.MouseEvent) => {
    // Shift bans; Shift+Alt bans for the other side. Alt keeps meaning "the
    // other one" in both cases, which is the only thing that has to be
    // remembered — for a team that is the other team, for a ban the other bench.
    if (e.shiftKey) {
      return onAssign(hero.slug, "banned", null, e.altKey ? otherSide(banSide) : banSide);
    }
    if (e.altKey) return onAssign(hero.slug, otherTeam(activeSlot));
    onAssign(hero.slug, activeSlot, null, banSide);
  };

  const positions = positionSummary(hero);
  const title = [
    hero.name,
    hero.topPositions?.length
      ? `pos ${hero.topPositions.map((p) => `${p} ${POSITION_LABEL[p]}`).join(", ")}`
      : null,
    hero.winRate ? `${hero.winRate.toFixed(2)}% win rate` : null,
    hero.tier ? `tier ${hero.tier}` : null,
    advantage !== undefined ? `${formatSigned(advantage)} against their draft and beside yours` : null,
    score !== undefined ? `draft score ${formatSigned(score)}` : null,
    slot === "banned" && bannedBy
      ? bannedBy === "enemy"
        ? "banned by them"
        : "banned by you"
      : null,
    cleared > 0
      ? `their bans cleared ${cleared.toFixed(1)} points of counter-play from this hero's path`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  /**
   * The score badge takes over from the head-to-head one while sorting by it,
   * so a tile never carries two numbers that mean different things.
   *
   * And no fallback between the two, which is where that promise used to break.
   * `score` is absent for a hero the ranking dropped — off-role under the
   * grid's position filter, or under the win-rate floor — and filling the hole
   * with `advantage` put a different quantity in the same corner: matchups plus
   * synergy only, no meta, no off-role charge, and in ban mode not even flipped
   * to your side. Sorting the pool for pos 1 then showed Silencer at "+1.4"
   * sitting *below* Sven at "−0.6", which is not a sort anybody can read. A
   * hero who is not a candidate for this seat now shows no number, which is the
   * true answer; the tooltip still carries their head-to-head figure, labelled.
   */
  const badge = ranked ? score : advantage;

  return (
    // The overlay buttons sit *beside* the tile rather than inside it: a button
    // cannot nest in a button, and the tile is one.
    //
    // The wrapper carries the active slot so the hover state can be tinted with
    // it. A click on the tile means whatever the selector at the top of the
    // board is set to, and that is easy to forget between drafts; colouring the
    // hover green, red or grey says what this click is about to do before it
    // happens, rather than after.
    <div className={`tile-wrap tile-wrap-${activeSlot}`}>
      <button
        type="button"
        className={`tile ${slot ? `tile-${slot}` : ""} ${offRole ? "tile-offrole" : ""}`}
        onClick={handleClick}
        onContextMenu={(e) => {
          e.preventDefault();
          onRemove(hero.slug);
        }}
        title={title}
        aria-pressed={Boolean(slot)}
        data-slug={hero.slug}
      >
        <HeroPortrait hero={hero} />
        <span className="tile-name">{hero.name}</span>
        {positions && !slot && <span className="tile-pos">{positions}</span>}
        {rank !== undefined && !slot && (
          <span
            className="tile-rank"
            title={`${rank} in the whole pool for this sort — not in what the search left on screen`}
          >
            {rank}
          </span>
        )}
        {badge !== undefined && !slot && (
          <span className={`tile-badge ${badge >= 0 ? "good" : "bad"}`}>
            {formatSigned(badge, 1)}
          </span>
        )}
        {/*
         * A hero the enemy has been clearing the way for, marked on the tile
         * itself. The panel spells the reading out, but the moment it is useful
         * is while scanning the pool — and a captain scanning the pool is not
         * looking at the right-hand column.
         */}
        {cleared > 0 && !slot && (
          <span className="tile-intent" aria-hidden>
            ⌖
          </span>
        )}
        {slot === "banned" && (
          <span className={`tile-ban-mark tile-ban-${bannedBy ?? "loose"}`} aria-hidden />
        )}
      </button>

      {/*
       * The two slots the click target is *not* set to.
       *
       * Only two, because the third is what the tile itself already does — a
       * button that repeats the click underneath it is a button that has to be
       * read before it can be ignored. Shift and Alt do the same job for anyone
       * who knows they exist; this is the same three moves without the reading.
       */}
      <div className="tile-actions">
        {SLOT_ORDER.filter((s) => s !== activeSlot).map((s) => {
          const here = slot === s;
          const label = here
            ? `Remove ${hero.name} from ${SLOT_PLACE[s]}`
            : `Add ${hero.name} to ${SLOT_PLACE[s]}`;
          return (
            <button
              key={s}
              type="button"
              className={`tile-act tile-act-${s} ${here ? "tile-act-on" : ""}`}
              aria-label={label}
              title={label}
              onClick={(e) => {
                e.stopPropagation();
                onAssign(hero.slug, s);
              }}
            >
              {here ? "−" : SLOT_GLYPH[s]}
            </button>
          );
        })}

        <button
          type="button"
          className={`tile-info ${infoOpen ? "tile-info-on" : ""}`}
          aria-label={`Full breakdown for ${hero.name}`}
          aria-expanded={infoOpen}
          onMouseEnter={(e) => onInfoEnter(hero.slug, e.currentTarget)}
          onMouseLeave={onInfoLeave}
          onFocus={(e) => onInfoEnter(hero.slug, e.currentTarget)}
          onBlur={onInfoLeave}
          onClick={(e) => {
            e.stopPropagation();
            onInfoClick(hero.slug, e.currentTarget);
          }}
        >
          i
        </button>
      </div>
    </div>
  );
});

/** How many of the *ranking's* leading heroes get an ordinal, as an eye-anchor. */
const RANKED_TILES = 3;

export function HeroGrid({
  heroes,
  grouped,
  slotOf,
  seatOf,
  activeSlot,
  advantage,
  highlightPosition,
  minRoleFit,
  sort,
  scores,
  ranks,
  onAssign,
  onRemove,
  detailsFor,
  impactFor,
  countersFor,
  partnersFor,
  settings,
  enemyCount,
  myCount,
  hasSynergies,
  banSideOf,
  banSide,
  intent,
}: HeroGridProps) {
  const { card, show, hide, keep, toggle, close } = useHoverCard();

  const ranked = sort !== "attr";

  /** Cards read the grid's own question: what the current sort is ranking for. */
  const mode = sort === "ban" ? "ban" : "pick";
  const detail = card ? detailsFor(card.slug) : null;
  // A hero already on the board has no "what if" left to answer.
  const impact =
    card && detail && !slotOf.get(card.slug) ? impactFor(card.slug, detail.position) : null;
  const slotFor = useCallback((slug: string) => slotOf.get(slug), [slotOf]);
  const ban = useCallback(
    (slug: string) => onAssign(slug, "banned", null, banSide),
    [onAssign, banSide],
  );
  /**
   * Always *my* team, never the active slot.
   *
   * The row is titled "best with" and read while deciding what to take next, so
   * the click has to mean the same thing whatever the click-target selector at
   * the top of the board happens to be set to. Inheriting the active slot would
   * make the same button add to the enemy team half the time.
   */
  const pick = useCallback((slug: string) => onAssign(slug, "mine"), [onAssign]);

  const layer = card && detail && (
    <HeroCardLayer
      anchor={card.el}
      pinned={card.pinned}
      onClose={close}
      onKeep={keep}
      onLeave={hide}
    >
      <HeroCard
        detail={detail}
        mode={mode}
        slot={slotOf.get(card.slug)}
        seat={seatOf.get(card.slug) ?? null}
        settings={settings}
        opponentCount={mode === "ban" ? myCount : enemyCount}
        allyCount={mode === "ban" ? enemyCount : myCount}
        hasSynergies={hasSynergies}
        impact={impact}
        // Passed as functions rather than rows: the card owns the role filter,
        // so it is the only thing that knows which rows to ask for.
        countersFor={countersFor}
        partnersFor={partnersFor}
        slotOf={slotFor}
        onBan={ban}
        onPick={pick}
      />
    </HeroCardLayer>
  );

  /**
   * Ban scores are measured from the enemy's side — how hard the hero beats
   * *your* line-up — so they are read back to your seat here, by the same rule
   * the suggestion panel and the hover card use. See `fromYourSide`.
   */
  const { mine } = fromYourSide(mode);
  const badgeScore = (slug: string) => {
    const score = scores.get(slug);
    return score === undefined ? undefined : mine(score);
  };

  /**
   * The ordinal on a tile, taken from the ranking rather than from where the
   * tile happens to have landed on screen.
   *
   * These used to be the first three tiles rendered, which is the same thing
   * only when nothing is filtered. Type "en" into the search and the grid
   * stamped a "1" on Sven — the best pick among heroes with an "en" in their
   * name — while the panel beside it, ranking the whole pool, led with Slark.
   * Two lists, one set of arithmetic, and a badge asserting they disagreed.
   *
   * Reading the place out of `ranks` makes the number mean "third best there
   * is", which is the claim the panel's own numbering makes, so the two can
   * only ever agree. The cost is that a search which hides the real top three
   * shows no ordinals at all — which is the honest outcome, because there is no
   * first place among the heroes with an "en" in their name worth marking.
   */
  const tileRank = (slug: string) => {
    const place = ranks.get(slug);
    return place !== undefined && place <= RANKED_TILES ? place : undefined;
  };

  const tile = (hero: Hero) => (
    <HeroTile
      key={hero.slug}
      hero={hero}
      slot={slotOf.get(hero.slug)}
      bannedBy={banSideOf.get(hero.slug)}
      advantage={advantage.get(hero.slug)}
      ranked={ranked}
      score={ranked ? badgeScore(hero.slug) : undefined}
      cleared={intent.get(hero.slug) ?? 0}
      rank={ranked ? tileRank(hero.slug) : undefined}
      activeSlot={activeSlot}
      banSide={banSide}
      offRole={Boolean(highlightPosition) && !canPlay(hero, highlightPosition, minRoleFit)}
      onAssign={onAssign}
      onRemove={onRemove}
      onInfoEnter={show}
      onInfoLeave={hide}
      onInfoClick={toggle}
      infoOpen={card?.slug === hero.slug}
    />
  );

  if (!heroes.length) {
    return <p className="empty">No heroes match that search.</p>;
  }

  if (!grouped) {
    return (
      <div className="grid-section">
        <h3 className="grid-heading">
          {ranked ? (sort === "ban" ? "Best to ban" : "Best to pick") : "Results"}{" "}
          <span className="muted">{heroes.length}</span>
        </h3>
        <div className="grid">{heroes.map(tile)}</div>
        {layer}
      </div>
    );
  }

  return (
    <>
      {ATTR_ORDER.map((attr) => {
        const group = heroes.filter((h) => h.attr === attr);
        if (!group.length) return null;
        return (
          <div className="grid-section" key={attr}>
            <h3 className={`grid-heading attr-text-${attr}`}>
              {ATTR_LABEL[attr]} <span className="muted">{group.length}</span>
            </h3>
            <div className="grid">{group.map(tile)}</div>
          </div>
        );
      })}
      {layer}
    </>
  );
}
