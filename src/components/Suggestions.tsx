import { HeroPortrait } from "./HeroPortrait";
import { PositionFilter } from "./PositionPicker";
import { formatSigned } from "../lib/scoring";
import { fromYourSide } from "../lib/perspective";
import { POSITION_LABEL } from "../lib/roles";
import { RANK_BAND_LABEL } from "../lib/positions";
import { TARGET_EARLY_COVER } from "../lib/timing";
import type { OffRolePick } from "../lib/scoring";
import type { Position, RankBand, ScoreMode, Suggestion } from "../types";

interface SuggestionsProps {
  title: string;
  subtitle: string;
  mode: ScoreMode;
  suggestions: Suggestion[];
  position: Position | null;
  onPositionChange: (position: Position | null) => void;
  /** Positions the relevant team still needs. */
  needed?: Position[];
  positionsAvailable: boolean;
  onApply: (suggestion: Suggestion) => void;
  emptyMessage: string;
  /**
   * Heroes that stay in the top few however the tuning sliders are set.
   *
   * Without this the list quietly conflates "the data likes this hero" with
   * "your current weights like this hero", and those are different claims.
   */
  robust?: Set<string>;
  /** The rank band the win rates were read from; null when they are Dotabuff's. */
  rankBand?: RankBand | null;
  /**
   * Heroes the role threshold removed and one measured lane pairing puts back
   * — see `offRolePicks`. Kept out of `suggestions` on purpose: they are a
   * different kind of claim and the list says so in its own words.
   */
  offRole?: OffRolePick[];
}

/**
 * Spells out the direction of a matchup chip, which otherwise only has room
 * for a name and a number — and the name on the chip is the *other* hero.
 */
function matchupTitle(candidate: string, other: string, advantage: number, mode: ScoreMode) {
  const gap = Math.abs(advantage).toFixed(1);
  // In ban mode the chip names one of your heroes, and `advantage` is the ban
  // candidate's edge over them; in pick mode it names an enemy.
  const yours = mode === "ban" ? `your ${other}` : other;
  return advantage >= 0
    ? `${candidate} beats ${yours} by ${gap} points`
    : `${yours} beats ${candidate} by ${gap} points`;
}

/** The same job for a synergy chip, where the other hero is a teammate. */
function synergyTitle(other: string, value: number, matches: number, mode: ScoreMode) {
  const gap = Math.abs(value).toFixed(1);
  const side = mode === "ban" ? "the enemy's" : "your";
  const verb = value >= 0 ? "gain" : "lose";
  return (
    `Together with ${side} ${other} they ${verb} ${gap} points of win rate ` +
    `beyond what the two are worth apart · ${matches.toLocaleString()} games`
  );
}

export function Suggestions({
  title,
  subtitle,
  mode,
  suggestions,
  position,
  onPositionChange,
  needed,
  positionsAvailable,
  onApply,
  emptyMessage,
  robust,
  rankBand,
  offRole,
}: SuggestionsProps) {
  const peak = Math.max(1, ...suggestions.map((s) => Math.abs(s.score)));

  /**
   * One rule for every number in the app: it is what the hero does to *your*
   * draft score, so green is always good for you.
   *
   * Ban candidates are ranked as enemies — the score measures how hard they
   * beat your line-up — so a raw +4 there is 4 points off your draft. Negating
   * it makes the panel read the way it is used: "this is what I lose if they
   * get him". Ordering is untouched; the biggest threat still leads the list,
   * now as −6.05 rather than a misleading green +6.05.
   *
   * The rule itself lives in `fromYourSide`, because the grid and the hover
   * card have to apply exactly the same one — see the note there.
   */
  const { mine, tone } = fromYourSide(mode);
  const band = rankBand ? ` · ${RANK_BAND_LABEL[rankBand]}` : "";

  return (
    <section className={`panel panel-${mode}`}>
      <header className="panel-header">
        <h2>{title}</h2>
        <PositionFilter
          value={position}
          onChange={onPositionChange}
          needed={needed}
          disabled={!positionsAvailable}
        />
        <p className="muted">
          {position ? <span>{POSITION_LABEL[position]} · </span> : null}
          <span>{subtitle}</span>
        </p>
      </header>

      {suggestions.length === 0 ? (
        <p className="empty">{emptyMessage}</p>
      ) : (
        <ol className="suggestions">
          {suggestions.map((s, i) => {
            // Chips carry two decimals, so an edge is worth showing down to
            // 0.01; only a value that would render as a meaningless "±0.00" is
            // dropped, and the slot goes to the next real matchup instead.
            const readable = s.contributions.filter((c) => Math.abs(c.advantage) >= 0.005);
            const lane = readable.filter((c) => c.sameLane).slice(0, 2);
            const rest = readable.filter((c) => !c.sameLane);
            const best = rest.slice(0, lane.length ? 1 : 2);
            const worst = rest.slice(-1).filter((c) => c.advantage < 0 && !best.includes(c));

            // Sorted best-first, so the ends of the list are the pairing worth
            // making and the one worth avoiding. Only shown when they are big
            // enough to change a decision.
            const partners = s.synergyContributions;
            const bestPartner = partners[0];
            const worstPartner = partners.at(-1);
            const notable = [
              bestPartner && bestPartner.synergy > 0.3 ? bestPartner : null,
              worstPartner && worstPartner !== bestPartner && worstPartner.synergy < -0.3
                ? worstPartner
                : null,
            ].filter((c) => c !== null);

            return (
              <li key={s.hero.slug}>
                <button type="button" className="suggestion" onClick={() => onApply(s)}>
                  <span className="rank">{i + 1}</span>
                  <HeroPortrait hero={s.hero} className="portrait-sm" />
                  <span className="suggestion-body">
                    <span className="suggestion-top">
                      <span className="suggestion-name">{s.hero.name}</span>
                      {robust?.has(s.hero.slug) && (
                        <span
                          className="robust-mark"
                          title={
                            `Stays in the top ${5} however the tuning is set — counter-heavy, ` +
                            `meta-heavy, synergy-heavy or lane-blind. A hero without this mark ` +
                            `may be here because of your current weights rather than the data.`
                          }
                          aria-label="Robust to the tuning settings"
                        >
                          ★
                        </span>
                      )}
                      <span
                        className={`score ${tone(s.score)}`}
                        title={
                          mode === "ban"
                            ? "What your draft score drops to if the enemy gets this hero — ban the most negative"
                            : "What this hero adds to your draft score"
                        }
                      >
                        {formatSigned(mine(s.score))}
                      </span>
                    </span>

                    <span className="bar" aria-hidden>
                      <span
                        className={`bar-fill ${tone(s.score)}`}
                        style={{ width: `${Math.min(100, (Math.abs(s.score) / peak) * 100)}%` }}
                      />
                    </span>

                    <span className="suggestion-meta">
                      {!!s.hero.topPositions?.length && (
                        <span
                          className="tag tag-pos"
                          title={[
                            s.hero.topPositions
                              .map((p) => `${p} ${POSITION_LABEL[p]}`)
                              .join(", "),
                            position && s.hero.positions
                              ? `${Math.round(s.roleFit * 100)}% of this hero's games are played in ${
                                  POSITION_LABEL[position]
                                } — not a win rate`
                              : "",
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        >
                          {`pos ${s.hero.topPositions.join("/")}${
                            position && s.hero.positions
                              ? ` · ${Math.round(s.roleFit * 100)}% of games`
                              : ""
                          }`}
                        </span>
                      )}
                      {/*
                       * The win rate that was *scored*, not the hero's overall
                       * one.
                       *
                       * These are different numbers and the card used to print
                       * the wrong one: under a pos 2 filter Huskar read "45.4%
                       * WR" while the meta term was crediting him with his 52.6%
                       * record in mid. A reader then sees a sub-46% hero ranked
                       * tenth with no way to reconcile it, and the honest
                       * conclusion — that the list is broken — was wrong.
                       *
                       * Labelled with the position when there is one, because
                       * Dotabuff only lists a hero in the lanes they turn up in:
                       * ask for a seat they never play and `positionWinRate`
                       * falls through to the overall figure, which must not be
                       * captioned as a figure for that seat.
                       */}
                      {s.winRate !== undefined && (
                        <span
                          className="tag"
                          title={
                            position && s.hero.positionWinRate?.[position] !== undefined
                              ? `Win rate as pos ${position}${band}` +
                                (s.seatWorth.toFixed(1) !== s.winRate.toFixed(1)
                                  ? ` — the Meta term scores it as ${s.seatWorth.toFixed(1)}%, counting a seat above the hero's own record at the share the win-chance calibration measured`
                                  : " — the figure the Meta term is scored from")
                              : position
                                ? `Overall win rate — Dotabuff has no pos ${position} row for this hero`
                                : `Overall win rate${band}`
                          }
                        >
                          {s.winRate.toFixed(1)}% WR
                          {position && s.hero.positionWinRate?.[position] !== undefined
                            ? ` as ${position}`
                            : ""}
                        </span>
                      )}
                      {s.covered > 0 && (
                        <span
                          className={`tag tag-${tone(s.matchupScore)}`}
                          title={`Head-to-head component of the score, from your side${
                            mode === "ban" ? " — negative means this hero beats your line-up" : ""
                          }`}
                        >
                          h2h {formatSigned(mine(s.matchupScore), 2)}
                        </span>
                      )}
                      {partners.length > 0 && (
                        <span
                          className={`tag tag-${tone(s.synergyScore)}`}
                          title={
                            mode === "ban"
                              ? `How well this hero fits alongside the enemy's ${partners.length} pick(s) — the better they fit, the more the enemy wants them`
                              : `How well this hero fits alongside your ${partners.length} pick(s), averaged`
                          }
                        >
                          syn {formatSigned(mine(s.synergyScore), 2)}
                        </span>
                      )}
                      {/*
                       * The tag that argues with the rest of the row.
                       *
                       * Every other tag is a property of the hero. This one is
                       * a property of the line-up they would join, and it is
                       * the only warning the list can give that a perfectly
                       * good pick is the wrong fifth pick. Shown only when it
                       * is charging something, so it reads as a flag rather
                       * than as another column.
                       */}
                      {s.earlyPenalty <= -0.01 && (
                        <span
                          className="tag tag-bad"
                          title={
                            `This side would field ${(s.teamEarlyCover ?? 0).toFixed(1)} heroes who function ` +
                            `before the median game length, out of the ${TARGET_EARLY_COVER} a line-up needs. ` +
                            `Costing ${formatSigned(mine(s.earlyPenalty), 2)} of the score.` +
                            (mode === "ban"
                              ? " Measured on the enemy's draft — a hero who wrecks their timing is one they want less."
                              : "")
                          }
                        >
                          early {formatSigned(mine(s.earlyPenalty), 2)}
                        </span>
                      )}

                      {/*
                       * The other tag that is not a property of the hero.
                       *
                       * `early` argues about the line-up they would join; this
                       * argues about the captain on the other side. It is the
                       * term that can put a hero at the top of the ban list on
                       * its own — half a point per point of counter-play their
                       * bans have cleared — and without a tag the list gave no
                       * account of why: the hero's own numbers can be ordinary
                       * and the reading still worth acting on. Ban mode only,
                       * and never negative, so it appears exactly when the
                       * enemy has said something out loud.
                       */}
                      {s.intentScore > 0 && (
                        <span
                          className="tag tag-bad"
                          title={
                            `Their bans cleared ${s.intentScore.toFixed(1)} points of counter-play ` +
                            `from this hero's path, which reads as a plan to pick them. ` +
                            `Worth ${formatSigned(mine(s.intentScore), 2)} of the score before weighting.`
                          }
                        >
                          their plan {formatSigned(mine(s.intentScore), 1)}
                        </span>
                      )}

                      {notable.map((c) => (
                        <span
                          key={`syn-${c.slug}`}
                          className={`tag tag-syn tag-${tone(c.synergy)}`}
                          title={synergyTitle(c.name, c.synergy, c.matches, mode)}
                        >
                          &amp; {c.name} {formatSigned(mine(c.synergy), 2)}
                        </span>
                      ))}

                      {lane.map((c) => (
                        <span
                          key={c.slug}
                          className={`tag tag-lane tag-${tone(c.advantage)}`}
                          title={
                            `${matchupTitle(s.hero.name, c.name, c.advantage, mode)} · shares a lane, so it counts double · ${c.matches.toLocaleString()} matches` +
                            (c.laneEdge !== undefined && Math.abs(c.laneEdge) >= 0.005
                              ? ` · ${formatSigned(mine(c.laneEdge), 2)} of it is the seat, from ${(c.laneLanes ?? 0).toLocaleString()} lanes of exactly this confrontation`
                              : "")
                          }
                        >
                          ⚔ {c.name} {formatSigned(mine(c.advantage), 2)}
                        </span>
                      ))}
                      {best.map((c) => (
                        <span
                          key={c.slug}
                          className={`tag tag-${tone(c.advantage)}`}
                          title={`${matchupTitle(s.hero.name, c.name, c.advantage, mode)} · ${c.matches.toLocaleString()} matches on Dotabuff`}
                        >
                          {c.name} {formatSigned(mine(c.advantage), 2)}
                        </span>
                      ))}
                      {worst.map((c) => (
                        <span
                          key={c.slug}
                          className={`tag tag-${tone(c.advantage)}`}
                          title={`${matchupTitle(s.hero.name, c.name, c.advantage, mode)} · ${
                            mode === "ban" ? "their softest matchup here" : "your weakest matchup here"
                          }`}
                        >
                          {c.name} {formatSigned(mine(c.advantage), 2)}
                        </span>
                      ))}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}

      {/*
       * The picks the list above is not allowed to make.
       *
       * Everything in `suggestions` clears the role threshold, which is a
       * statement about how heroes are usually deployed — and an off-meta
       * counter-pick is by definition not usual. These are the heroes below
       * that floor whose record *at this seat against a hero on the board*
       * clears the noise floor anyway, with the sample printed beside them,
       * because the whole claim rests on it.
       */}
      {offRole && offRole.length > 0 && (
        <div className="off-role">
          <h3>
            Off-role answers
            <span
              className="muted"
              title={
                "Heroes below the role threshold for this seat, kept back by one measured " +
                "pairing: how their games went from this seat against that hero, beyond " +
                "what the whole-game matchup already says. These lanes were drafted by " +
                "people choosing to counter-pick, so some of the edge belongs to the " +
                "player and not the hero."
              }
            >
              {" "}
              — rare seats with a measured reason
            </span>
          </h3>
          <ul>
            {offRole.map(({ suggestion: s, against }) => (
              <li key={s.hero.slug}>
                <button type="button" className="off-role-pick" onClick={() => onApply(s)}>
                  <HeroPortrait hero={s.hero} className="portrait-sm" />
                  <span className="off-role-name">{s.hero.name}</span>
                  <span
                    className="tag tag-lane tag-good"
                    title={
                      `From this seat against ${against.name} the games went ` +
                      `${formatSigned(against.laneEdge ?? 0, 2)} beyond their whole-game matchup, ` +
                      `over ${(against.laneLanes ?? 0).toLocaleString()} lanes.`
                    }
                  >
                    ⚔ {against.name} {formatSigned(against.laneEdge ?? 0, 2)}
                  </span>
                  <span
                    className="tag"
                    title={`${(100 * s.roleFit).toFixed(1)}% of this hero's games are played here — their record in this seat is already in the score`}
                  >
                    {(100 * s.roleFit).toFixed(1)}% of games
                  </span>
                  <span className={`score ${tone(s.score)}`}>{formatSigned(mine(s.score))}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
