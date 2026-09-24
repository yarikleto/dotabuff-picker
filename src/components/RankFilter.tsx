import { RANK_BANDS, RANK_BAND_LABEL } from "../lib/positions";
import type { RankBand } from "../types";

interface RankFilterProps {
  /** The band in effect, which is all ranks when the file lacks the one asked for. */
  value: RankBand;
  /** Bands positions.json carries; the rest are shown but cannot be chosen. */
  available: readonly RankBand[];
  onChange: (band: RankBand) => void;
}

/**
 * Whose games the hero figures are read from.
 *
 * In the top bar rather than under Tuning because it changes what the numbers
 * on every card mean, not how much they weigh.
 */
export function RankFilter({ value, available, onChange }: RankFilterProps) {
  const title = (band: RankBand) =>
    available.length
      ? `${RANK_BAND_LABEL[band]}: win rates, positions, seat records and pick rates from STRATZ. ` +
        "Counters, synergies, lanes and timings are all ranks whichever you pick."
      : "Run “npm run positions” to read hero figures from STRATZ by rank.";

  return (
    <div className="seg seg-sm" role="group" aria-label="Rank">
      {RANK_BANDS.map((band) => (
        <button
          key={band}
          type="button"
          className="seg-btn"
          aria-pressed={value === band}
          onClick={() => onChange(band)}
          disabled={!available.includes(band)}
          title={title(band)}
        >
          {RANK_BAND_LABEL[band]}
        </button>
      ))}
    </div>
  );
}
