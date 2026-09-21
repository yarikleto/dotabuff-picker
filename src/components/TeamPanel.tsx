import { HeroPortrait } from "./HeroPortrait";
import { PositionPicker } from "./PositionPicker";
import { POSITION_LABEL, missingPositions } from "../lib/roles";
import type { Ban, BanSide, DraftPick, Hero, Position, Slot } from "../types";

interface TeamPanelProps {
  title: string;
  slot: Slot;
  picks: DraftPick[];
  size: number;
  bySlug: Map<string, Hero>;
  active: boolean;
  onActivate: (slot: Slot) => void;
  onRemove: (slug: string) => void;
  onClear: (slot: Slot) => void;
  onSetPosition: (slug: string, position: Position | null) => void;
  hint?: string;
}

/** A team's five slots, each carrying the position you have that hero down for. */
export function TeamPanel({
  title,
  slot,
  picks,
  size,
  bySlug,
  active,
  onActivate,
  onRemove,
  onClear,
  onSetPosition,
  hint,
}: TeamPanelProps) {
  const empties = Math.max(0, size - picks.length);
  const taken = new Set(picks.map((p) => p.position).filter(Boolean) as Position[]);
  const missing = missingPositions(picks).slice(0, empties);

  // Show the positions in draft order rather than click order.
  const ordered = [...picks].sort((a, b) => (a.position ?? 9) - (b.position ?? 9));

  return (
    <section className={`team team-${slot} ${active ? "team-active" : ""}`}>
      <header className="team-header">
        <button
          type="button"
          className="team-title"
          onClick={() => onActivate(slot)}
          title={`Click heroes to add them here${hint ? ` (${hint})` : ""}`}
        >
          <span className={`dot dot-${slot}`} aria-hidden />
          {title}
          <span className="muted">
            {picks.length}/{size}
          </span>
        </button>
        {picks.length > 0 && (
          <button type="button" className="link-btn" onClick={() => onClear(slot)}>
            clear
          </button>
        )}
      </header>

      <ul className="team-list">
        {ordered.map((pick) => {
          const hero = bySlug.get(pick.slug);
          if (!hero) return null;
          return (
            <li key={pick.slug} className="team-row">
              <PositionPicker
                hero={hero}
                value={pick.position}
                taken={taken}
                onChange={(position) => onSetPosition(pick.slug, position)}
              />
              <button
                type="button"
                className="chip"
                onClick={() => onRemove(pick.slug)}
                title={`Remove ${hero.name}`}
              >
                <HeroPortrait hero={hero} className="portrait-sm" />
                <span className="chip-name">{hero.name}</span>
                <span className="chip-x" aria-hidden>
                  ×
                </span>
              </button>
            </li>
          );
        })}

        {Array.from({ length: empties }, (_, i) => (
          <li key={`empty-${i}`} className="team-row">
            <span className={`position-ghost ${missing[i] ? `pos-${missing[i]}` : ""}`}>
              {missing[i] ?? "–"}
            </span>
            <div className="chip chip-empty">
              {missing[i] && <span className="muted">{POSITION_LABEL[missing[i]!]}</span>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

const SIDE_LABEL: Record<BanSide, string> = { mine: "I banned", enemy: "They banned" };

/**
 * What each half of the list is *for*, which is not the same thing on both
 * sides and is the whole reason they are drawn apart.
 */
const SIDE_HINT: Record<BanSide, string> = {
  mine: "Heroes you took off the board. They change what is available and nothing else.",
  enemy:
    "Heroes they took off the board — the only statement of intent a draft makes out loud. " +
    "Two of these landing on one hero's counter list is what the read below is built from.",
};

/**
 * One side's bans, and the click target for adding to them.
 *
 * A whole sub-panel per side rather than a marker per chip, because the side is
 * not a decoration on a ban — it is the thing that decides whether the ban is
 * evidence. Splitting them makes the enemy's column readable as a group, which
 * is how it has to be read: the signal is in what several of their bans have in
 * common, and that is invisible in a mixed list sorted by click order.
 */
function BanSideList({
  side,
  bans,
  bySlug,
  active,
  onActivate,
  onRemove,
  onFlip,
}: {
  side: BanSide;
  bans: Ban[];
  bySlug: Map<string, Hero>;
  active: boolean;
  onActivate: (side: BanSide) => void;
  onRemove: (slug: string) => void;
  onFlip: (slug: string, to: BanSide) => void;
}) {
  const other: BanSide = side === "mine" ? "enemy" : "mine";
  return (
    <div className={`ban-side ban-side-${side} ${active ? "ban-side-active" : ""}`}>
      <button
        type="button"
        className="ban-side-title"
        onClick={() => onActivate(side)}
        aria-pressed={active}
        title={`${SIDE_HINT[side]}\n\nClick to send the next ban here.`}
      >
        <span className={`dot dot-ban-${side}`} aria-hidden />
        {SIDE_LABEL[side]}
        <span className="muted">{bans.length}</span>
      </button>

      {bans.length === 0 ? (
        <p className="ban-empty muted">{active ? "next ban lands here" : "—"}</p>
      ) : (
        <ul className="team-list ban-list">
          {bans.map((ban) => {
            const hero = bySlug.get(ban.slug);
            if (!hero) return null;
            return (
              <li key={ban.slug} className="ban-row">
                <button
                  type="button"
                  className="chip"
                  onClick={() => onRemove(ban.slug)}
                  title={`Unban ${hero.name}`}
                >
                  <HeroPortrait hero={hero} className="portrait-sm" />
                  <span className="chip-name">{hero.name}</span>
                  <span className="chip-x" aria-hidden>
                    ×
                  </span>
                </button>
                {/*
                 * Re-attributing a ban has to be one click and reachable after
                 * the fact. Bans go in fast while a draft is running and the
                 * side is the easiest thing to get wrong; making the fix cost a
                 * remove and a re-add would mean the mistake usually just stays.
                 */}
                <button
                  type="button"
                  className="ban-flip"
                  onClick={() => onFlip(ban.slug, other)}
                  aria-label={`Move ${hero.name} to "${SIDE_LABEL[other]}"`}
                  title={`This was ${SIDE_LABEL[other].toLowerCase()} — move it`}
                >
                  ⇄
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Bans have no positions, so they get a simpler list — but two of them.
 *
 * Unattributed bans (every one restored from a draft saved before sides
 * existed) get a third strip below, rather than being quietly filed under one
 * side. They still remove their heroes from the pool; they simply say nothing
 * about anyone's plan, and the panel says so instead of guessing.
 */
export function BanPanel({
  bans,
  bySlug,
  active,
  side,
  onActivate,
  onRemove,
  onClear,
  onSetSide,
  hint,
}: {
  bans: Ban[];
  bySlug: Map<string, Hero>;
  active: boolean;
  /** Which side the next ban is credited to. */
  side: BanSide;
  onActivate: (slot: Slot, side: BanSide) => void;
  onRemove: (slug: string) => void;
  onClear: (slot: Slot) => void;
  onSetSide: (slug: string, side: BanSide | null) => void;
  hint?: string;
}) {
  const mine = bans.filter((b) => b.by === "mine");
  const theirs = bans.filter((b) => b.by === "enemy");
  const loose = bans.filter((b) => b.by === null);

  const activate = (next: BanSide) => onActivate("banned", next);

  return (
    <section className={`team team-banned ${active ? "team-active" : ""}`}>
      <header className="team-header">
        <span className="team-title team-title-static">
          <span className="dot dot-banned" aria-hidden />
          Banned
          <span className="muted">{bans.length}</span>
        </span>
        {bans.length > 0 && (
          <button type="button" className="link-btn" onClick={() => onClear("banned")}>
            clear
          </button>
        )}
      </header>

      <div className="ban-sides">
        <BanSideList
          side="mine"
          bans={mine}
          bySlug={bySlug}
          active={active && side === "mine"}
          onActivate={activate}
          onRemove={onRemove}
          onFlip={onSetSide}
        />
        <BanSideList
          side="enemy"
          bans={theirs}
          bySlug={bySlug}
          active={active && side === "enemy"}
          onActivate={activate}
          onRemove={onRemove}
          onFlip={onSetSide}
        />
      </div>

      {loose.length > 0 && (
        <div className="ban-loose">
          <p className="muted ban-loose-head">
            {loose.length} ban{loose.length === 1 ? "" : "s"} with no side — restored from an older
            draft. Say whose they were to let them count as evidence.
          </p>
          <ul className="team-list ban-list">
            {loose.map((ban) => {
              const hero = bySlug.get(ban.slug);
              if (!hero) return null;
              return (
                <li key={ban.slug} className="ban-row">
                  <button
                    type="button"
                    className="chip"
                    onClick={() => onRemove(ban.slug)}
                    title={`Unban ${hero.name}`}
                  >
                    <HeroPortrait hero={hero} className="portrait-sm" />
                    <span className="chip-name">{hero.name}</span>
                    <span className="chip-x" aria-hidden>
                      ×
                    </span>
                  </button>
                  <span className="ban-claim">
                    <button
                      type="button"
                      className="ban-claim-btn ban-claim-mine"
                      onClick={() => onSetSide(ban.slug, "mine")}
                      title={`${hero.name} was my ban`}
                    >
                      me
                    </button>
                    <button
                      type="button"
                      className="ban-claim-btn ban-claim-enemy"
                      onClick={() => onSetSide(ban.slug, "enemy")}
                      title={`${hero.name} was their ban`}
                    >
                      them
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {bans.length === 0 && (
        <p className="team-placeholder muted">
          Shift+click a hero to ban them{hint ? ` (${hint})` : ""} · Shift+Alt+click bans for the
          other side
        </p>
      )}
    </section>
  );
}
