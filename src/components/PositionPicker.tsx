import { POSITIONS, POSITION_LABEL, positionFit } from "../lib/roles";
import type { Hero, Position } from "../types";

interface PositionPickerProps {
  hero: Hero | undefined;
  value: Position | null;
  onChange: (position: Position | null) => void;
  /** Positions already claimed by a team-mate, shown as taken. */
  taken?: Set<Position>;
}

/**
 * The position dropdown that sits on every drafted hero. Options are annotated
 * with how much of that hero's games are actually spent there, so an unusual
 * assignment is visible rather than silent.
 *
 * The badge is too narrow for a role name, so the closed state shows the bare
 * number: the select's own text is hidden and the digit is drawn over it, with
 * the role spelled out in a hover tooltip. The dropdown itself still lists the
 * full labels.
 */
export function PositionPicker({ hero, value, onChange, taken }: PositionPickerProps) {
  const label = (position: Position) => {
    const fit = positionFit(hero, position);
    const share = hero?.positions ? ` ${Math.round(fit * 100)}%` : "";
    const claimed = taken?.has(position) && position !== value ? " ·" : "";
    return `${position} ${POSITION_LABEL[position]}${share}${claimed}`;
  };

  return (
    <span
      className={`position-slot ${value ? `pos-${value}` : "pos-none"}`}
      data-role={value ? `${value} · ${POSITION_LABEL[value]}` : "Set position"}
    >
      <select
        className="position-picker"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value ? (Number(e.target.value) as Position) : null)}
        onClick={(e) => e.stopPropagation()}
        aria-label={hero ? `Position for ${hero.name}` : "Position"}
      >
        <option value="">–</option>
        {POSITIONS.map((position) => (
          <option key={position} value={position}>
            {label(position)}
          </option>
        ))}
      </select>
      <span className="position-face" aria-hidden>
        {value ?? "–"}
      </span>
    </span>
  );
}

interface PositionFilterProps {
  value: Position | null;
  onChange: (position: Position | null) => void;
  /** Positions the team still needs, highlighted as the likely choice. */
  needed?: Position[];
  disabled?: boolean;
  /** Extra class on the wrapper, for the inline copy that sits in the sort bar. */
  className?: string;
  /** What this particular filter governs — there is more than one on screen. */
  label?: string;
  /** Chip tooltips, when the plain position name is not enough. */
  title?: (position: Position | null) => string;
}

/** The "which position am I drafting for" selector above a suggestion list. */
export function PositionFilter({
  value,
  onChange,
  needed,
  disabled,
  className,
  label = "Position to draft for",
  title,
}: PositionFilterProps) {
  const tip = (position: Position | null) =>
    title?.(position) ?? (position ? POSITION_LABEL[position] : "Any position");

  return (
    <div className={`position-filter ${className ?? ""}`} role="group" aria-label={label}>
      <button
        type="button"
        className={`pos-chip ${value === null ? "pos-chip-active" : ""}`}
        onClick={() => onChange(null)}
        title={tip(null)}
        disabled={disabled}
      >
        Any
      </button>
      {POSITIONS.map((position) => (
        <button
          key={position}
          type="button"
          className={[
            "pos-chip",
            `pos-${position}`,
            value === position ? "pos-chip-active" : "",
            needed?.includes(position) ? "pos-chip-needed" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          onClick={() => onChange(value === position ? null : position)}
          title={tip(position)}
          disabled={disabled}
        >
          {position}
        </button>
      ))}
    </div>
  );
}
