import { Fragment } from "react";
import { HeroPortrait } from "./HeroPortrait";
import { MIN_ANSWERS_GONE, MIN_CLEARED_SHARE } from "../lib/intent";
import type { Intent } from "../lib/intent";

interface EnemyIntentProps {
  reading: Intent[];
  /** What their bans came closest to while the reading is empty — see `readNearMisses`. */
  nearMisses: Intent[];
  /** How many bans the enemy has spent — what the reading is built from. */
  banCount: number;
  /** True once the enemy has bans but none of them are attributed. */
  unattributed: boolean;
  onBan: (slug: string) => void;
  onPick: (slug: string) => void;
}

/**
 * What the enemy's own bans say about their next pick.
 *
 * The one panel in the app that is about a person rather than about heroes.
 * Everything else reads the board; this reads the captain — they spent bans
 * removing the answers to something, and the something is what they mean to
 * take. See `readIntent`.
 *
 * Written to be easy to disbelieve. Each row shows the bans it is built from by
 * name, so the claim can be checked against the ban list in two seconds rather
 * than taken on faith, and the panel says nothing at all far more often than it
 * says something.
 */
export function EnemyIntent({
  reading,
  nearMisses,
  banCount,
  unattributed,
  onBan,
  onPick,
}: EnemyIntentProps) {
  return (
    <section className="panel panel-intent">
      <header className="panel-header">
        <h2>Enemy is clearing the way</h2>
        <p className="muted">
          Heroes whose answers <em>their</em> bans removed — read as what they are angling for
        </p>
      </header>

      {reading.length === 0 ? (
        <p className="empty">
          {unattributed
            ? "None of the bans on the board are marked as theirs. Mark them in the ban panel and their plan becomes readable."
            : banCount < 2
              ? "Needs at least two of their bans. One ban landing on a hero's counter list is a coincidence."
              : <QuietReason nearMisses={nearMisses} />}
        </p>
      ) : (
        <ol className="intent-list">
          {reading.map((r) => (
            <li key={r.hero.slug}>
              <div className="intent-row">
                <HeroPortrait hero={r.hero} className="portrait-sm" />
                <div className="intent-body">
                  <div className="intent-top">
                    <span className="intent-name">{r.hero.name}</span>
                    <span
                      className="intent-score"
                      title={
                        `Their bans removed ${r.cleared.toFixed(1)} points of counter-play from ` +
                        `this hero's path — ${r.answersGone} of the ${r.answerPool} heroes who ` +
                        `answer them, worth ${Math.round(r.share * 100)}% of the answers that existed.`
                      }
                    >
                      {r.answersGone}/{r.answerPool} answers gone
                    </span>
                  </div>

                  <div className="intent-bar" aria-hidden>
                    <span className="intent-bar-fill" style={{ width: `${r.share * 100}%` }} />
                  </div>

                  <div className="intent-tags">
                    {r.evidence.map((e) => (
                      <span
                        key={e.slug}
                        className="tag tag-evidence"
                        title={
                          `They banned ${e.name}, who beats ${r.hero.name} by ` +
                          `${e.advantage.toFixed(1)} points — ${e.specific.toFixed(1)} of that is ` +
                          `specific to this matchup rather than ${e.name} being strong generally · ` +
                          `${e.matches.toLocaleString()} games`
                        }
                      >
                        ✕ {e.name}
                      </span>
                    ))}
                  </div>

                  {/*
                   * The actionable half, and the reason this panel is not just
                   * a warning. Their plan has exactly two answers: take the
                   * hero away, or take the hero who still beats them — and the
                   * second is only available while it is still on the board.
                   */}
                  <div className="intent-actions">
                    <button type="button" className="intent-act" onClick={() => onBan(r.hero.slug)}>
                      Ban {r.hero.name}
                    </button>
                    {r.answerLeft ? (
                      <button
                        type="button"
                        className="intent-act intent-act-answer"
                        onClick={() => onPick(r.answerLeft!.slug)}
                        title={
                          `${r.answerLeft.name} still answers ${r.hero.name} by ` +
                          `${r.answerLeft.advantage.toFixed(1)} points, and is still available.`
                        }
                      >
                        or take {r.answerLeft.name}
                      </button>
                    ) : (
                      <span className="tag tag-bad" title="Every answer this panel knows about is off the board.">
                        no answer left
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const percent = (share: number) => `${Math.round(share * 100)}%`;
/** Floored, unlike `percent`: a share just under the bar must never print as the bar itself. */
const percentUnderBar = (share: number) => `${Math.floor(share * 100)}%`;

/**
 * Plain prose on purpose: this renders on nearly every quiet board, and a
 * portrait, bar or action here would turn the explanation into a prediction.
 */
function QuietReason({ nearMisses }: { nearMisses: Intent[] }) {
  if (!nearMisses.length) {
    // Only "still available": their bans may well have cleared the way for a
    // hero who is already picked, and this must not claim otherwise.
    return <>{"None of their bans is among the answers to any hero still available."}</>;
  }
  return (
    <>
      {`Not a plan yet — that takes ${MIN_ANSWERS_GONE} of a hero's answers, worth ` +
        `${percent(MIN_CLEARED_SHARE)} of the counter-play against them. Closest: `}
      {nearMisses.map((m, i) => (
        <Fragment key={m.hero.slug}>
          {i > 0 && (i === nearMisses.length - 1 ? " and " : ", ")}
          <span title={explainMiss(m)}>{`${m.hero.name} (${describeMiss(m)})`}</span>
        </Fragment>
      ))}
      .
    </>
  );
}

function listNames(evidence: Intent["evidence"]): string {
  const names = evidence.map((e) => e.name);
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function describeMiss(m: Intent): string {
  const bans = listNames(m.evidence);
  const gone = `${m.answersGone}/${m.answerPool} answers gone`;
  return m.answersGone < MIN_ANSWERS_GONE
    ? `${bans} — ${gone}`
    : `${bans} — ${gone}, worth only ${percentUnderBar(m.share)}`;
}

function explainMiss(m: Intent): string {
  const bans = listNames(m.evidence);
  const counted = `They banned ${bans}, ${m.answersGone} of the ${m.answerPool} heroes who answer ${m.hero.name}`;
  return m.answersGone < MIN_ANSWERS_GONE
    ? `${counted}. None of their other bans is among ${m.hero.name}'s answers, and it takes ` +
        `${MIN_ANSWERS_GONE} to read as a plan.`
    : `${counted} — but together worth only ${percentUnderBar(m.share)} of the counter-play against ` +
        `them, and it takes ${percent(MIN_CLEARED_SHARE)} to read as a plan.`;
}
