import { HeroPortrait } from "./HeroPortrait";
import { POSITION_LABEL } from "../lib/roles";
import { poolSize, type RolePools } from "../lib/rolePools";
import type { ClearedPools } from "../state/rolePools";
import type { Hero, Position, Slot } from "../types";

const STATUS: Record<Slot, string> = {
  mine: "already on your team",
  enemy: "taken by the enemy",
  banned: "banned",
};

interface PoolSlotProps {
  position: Position;
  pools: RolePools;
  bySlug: Map<string, Hero>;
  slotOf: Map<string, Slot>;
  editing: Position | null;
  onEdit: (position: Position | null) => void;
  onPick: (slug: string, position: Position) => void;
  onRemove: (position: Position, slug: string) => void;
}

/**
 * One open seat on my team, with that role's pool in small faces under the role
 * name. The seat still reads as empty: the pool is a suggestion, and any hero
 * can go there. Only open seats show a pool, because a filled role's pool has
 * nothing left to offer this game and the column has no height to spare.
 */
export function PoolSlot({
  position,
  pools,
  bySlug,
  slotOf,
  editing,
  onEdit,
  onPick,
  onRemove,
}: PoolSlotProps) {
  const slugs = pools[position];
  const open = editing === position;
  const role = POSITION_LABEL[position].toLowerCase();

  const faces = slugs.map((slug) => {
    const hero = bySlug.get(slug);
    if (!hero) return null;
    const slot = slotOf.get(slug);
    if (open) {
      return (
        <button
          key={slug}
          type="button"
          className={`pool-hero ${slot ? `pool-hero-${slot}` : ""}`}
          onClick={() => onRemove(position, slug)}
          title={`Remove ${hero.name} from the pos ${position} pool`}
          aria-label={`Remove ${hero.name} from the pos ${position} pool`}
        >
          <HeroPortrait hero={hero} className="portrait-pool" />
          <span className="pool-hero-x" aria-hidden>
            ×
          </span>
        </button>
      );
    }
    return (
      <button
        key={slug}
        type="button"
        className={`pool-hero ${slot ? `pool-hero-${slot}` : ""}`}
        disabled={Boolean(slot)}
        onClick={() => onPick(slug, position)}
        title={slot ? `${hero.name} — ${STATUS[slot]}` : `Pick ${hero.name} as ${role}`}
        aria-label={slot ? `${hero.name}, ${STATUS[slot]}` : `Pick ${hero.name} as ${role}`}
      >
        <HeroPortrait hero={hero} className="portrait-pool" />
      </button>
    );
  });

  return (
    <div className={`chip chip-empty pool-slot ${open ? `pool-slot-open pool-tone-${position}` : ""}`}>
      <span className="pool-slot-body">
        <span className="pool-slot-role muted">
          {open && !slugs.length ? "Click heroes in the grid" : POSITION_LABEL[position]}
        </span>
        {slugs.length > 0 && <span className="pool-faces">{faces}</span>}
      </span>
      <button
        type="button"
        className="link-btn pool-slot-edit"
        aria-pressed={open}
        onClick={() => onEdit(open ? null : position)}
        title={`Edit the ${role} pool: click heroes in the grid to add or remove them`}
        aria-label={`Edit the pos ${position} pool`}
      >
        {slugs.length ? "✎" : "+ pool"}
      </button>
    </div>
  );
}

/** The team header's pool control: clear every pool, then undo until the next change. */
export function PoolsHeaderAction({
  pools,
  cleared,
  onClear,
  onUndo,
}: {
  pools: RolePools;
  cleared: ClearedPools | null;
  onClear: () => void;
  onUndo: () => void;
}) {
  if (cleared) {
    return (
      <span className="pools-cleared muted" role="status">
        {cleared.position ? `pos ${cleared.position} pool cleared` : "pools cleared"} ·{" "}
        <button type="button" className="link-btn" onClick={onUndo}>
          undo
        </button>
      </span>
    );
  }
  if (!poolSize(pools)) return null;
  return (
    <button
      type="button"
      className="link-btn"
      onClick={onClear}
      title="Empty every role's pool. The draft stays as it is."
    >
      clear pools
    </button>
  );
}
