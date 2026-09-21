import { useEffect, useRef } from "react";
import { HeroPortrait } from "./HeroPortrait";
import { POSITION_LABEL } from "../lib/roles";
import { formatSigned } from "../lib/scoring";
import { breakdownOf, costOf, describeOption, headlineFor } from "../lib/rebalanceCopy";
import type { RebalanceOption, RebalanceReport } from "../lib/rebalance";
import type { Hero, LanePlan, Position } from "../types";

interface RebalanceProps {
  report: RebalanceReport;
  bySlug: Map<string, Hero>;
  /** The deployment the board is on, for the manual control. */
  lanePlan: LanePlan;
  /** The arrangement just applied from here, so it can be taken back. */
  applied: AppliedArrangement | null;
  onApply: (option: RebalanceOption) => void;
  onUndo: () => void;
  onLanePlan: (plan: LanePlan) => void;
  onClose: () => void;
}

/** What was applied, and what the board looked like before it. */
export interface AppliedArrangement {
  label: string;
  restore: { picks: { slug: string; position: Position | null }[]; lanePlan: LanePlan };
}

/** "2 Mid → 4 Soft support", spelled out because the digits alone are cryptic. */
const moveTitle = (from: Position | null, to: Position, fit: number) =>
  `${from ? `${from} ${POSITION_LABEL[from]}` : "unassigned"} → ${to} ${POSITION_LABEL[to]}` +
  ` · ${Math.round(fit * 100)}% of this hero's games are played there`;

/**
 * How much of a stretch a move is, in one word.
 *
 * The percentage is on the tooltip and nobody reads tooltips while drafting.
 * This is the same number said out loud, and it is the thing that decides
 * whether a suggested move is clever or absurd.
 */
function stretch(fit: number): { label: string; tone: string } | null {
  if (fit >= 0.25) return null;
  if (fit >= 0.1) return { label: "off-role", tone: "warn" };
  return { label: "rarely played", tone: "bad" };
}

function Option({
  option,
  bySlug,
  onApply,
}: {
  option: RebalanceOption;
  bySlug: Map<string, Hero>;
  onApply: (option: RebalanceOption) => void;
}) {
  const lead = headlineFor(option);
  const title = describeOption(option);

  return (
    <li className="rebalance-option">
      <span className="rebalance-lead" title={lead.title}>
        <span className={`rebalance-lead-value ${lead.tone}`}>{lead.value}</span>
        <span className="rebalance-lead-unit">{lead.unit}</span>
      </span>

      <div className="rebalance-option-body">
        <p className="rebalance-option-title">
          {title}
          <span className="rebalance-cost" title="How much upheaval this arrangement costs">
            {costOf(option)}
          </span>
        </p>

        <div className="rebalance-moves">
          {option.moves.map((move) => {
            const hero = bySlug.get(move.slug);
            const flag = stretch(move.fit);
            return (
              <span
                key={move.slug}
                className="rebalance-move"
                title={moveTitle(move.from, move.to, move.fit)}
              >
                {hero && <HeroPortrait hero={hero} className="portrait-sm" />}
                <span className="rebalance-move-name">{move.name}</span>
                <span className={`position-ghost pos-${move.from ?? "none"}`}>
                  {move.from ?? "–"}
                </span>
                <span className="rebalance-arrow" aria-hidden>
                  →
                </span>
                <span className={`position-ghost pos-${move.to}`}>{move.to}</span>
                {flag && <span className={`tag tag-${flag.tone}`}>{flag.label}</span>}
              </span>
            );
          })}
          {option.swapsLanes && (
            <span
              className="rebalance-move rebalance-move-lanes"
              title={
                option.lanePlan === "swapped"
                  ? "Send the safe duo up against theirs, and the offlane duo down against theirs. Positions and farm priority are unchanged — only who stands opposite whom."
                  : "Go back to the normal deployment: our safe duo against their offlane duo."
              }
            >
              {option.lanePlan === "swapped" ? "⇄ swap lanes" : "⇄ back to normal lanes"}
            </span>
          )}
        </div>

        <p className="rebalance-why muted">
          {/*
            Both halves of the gain, always, whichever of them is the headline.
            A score option leads with their sum and a lane option leads with one
            lane — either way the reader is owed the draft figure, because that
            is the number the badge in the top bar shows and the one they will
            check this against.
          */}
          <span title="The two terms behind the figure on the left: what the arrangement does to the draft number, and what it does to how well your five suit their seats.">
            {breakdownOf(option)}
          </span>
          {` · leaves the draft at ${formatSigned(option.score.advantage, 1)}, ${option.verdict.toLowerCase()}`}
          {/* The repaired lane is already the headline figure; the rest are the cost. */}
          {option.laneShifts
            .filter((shift) => shift.key !== option.repairedLane?.key)
            .map((shift) => (
              <span key={shift.key} title={`${formatSigned(shift.before, 1)} → ${formatSigned(shift.after, 1)}`}>
                {" · "}
                <span className={shift.delta >= 0 ? "good" : "bad"}>
                  {`${shift.label} ${formatSigned(shift.delta, 1)}`}
                </span>
              </span>
            ))}
        </p>
      </div>

      <button
        type="button"
        className="btn rebalance-apply"
        onClick={() => onApply(option)}
        aria-label={`Apply: ${title}`}
      >
        Apply
      </button>
    </li>
  );
}

function OptionList({
  options,
  bySlug,
  onApply,
  className,
}: {
  options: RebalanceOption[];
  bySlug: Map<string, Hero>;
  onApply: (option: RebalanceOption) => void;
  className?: string;
}) {
  return (
    <ol className={`rebalance-options ${className ?? ""}`}>
      {options.map((option) => (
        <Option key={option.id} option={option} bySlug={bySlug} onApply={onApply} />
      ))}
    </ol>
  );
}

/**
 * Why the search came back with what it came back with.
 *
 * Every figure in one unit, and the unit named. The old footer said "2 of 20
 * seatings clear your 8% role threshold ... out of 39 scored", which is two
 * denominators of different kinds in one sentence: 20 counted role seatings and
 * 39 counted seatings-times-lane-plans. A reader who tried to reconcile them
 * could not.
 */
function searchNote(report: RebalanceReport): string {
  const { seatings, legalSeatings, arrangements } = report.counts;
  const pct = Math.round(report.minRoleFit * 100);
  const parts = [
    `${arrangements} arrangements scored — ${seatings} seatings × 2 lane plans, less the one you are on.`,
  ];
  if (legalSeatings < seatings) {
    parts.push(`${legalSeatings} of the ${seatings} seatings clear your ${pct}% role threshold.`);
  }
  const forced = report.forced
    .slice(0, 2)
    .map((f) => `${f.name} is the only one of your five who plays ${f.position}`)
    .join("; ");
  if (forced) parts.push(`${forced}.`);
  return parts.join(" ");
}

/**
 * What to do when the enemy answered a hero you have already spent.
 *
 * The rest of the app helps you choose the *next* hero. This is the panel for
 * the moment when there is no next hero — the five are locked, their first pick
 * countered your mid, and the only move left is to put the same five somewhere
 * else.
 *
 * Deliberately a list rather than a single answer with a button. The score
 * cannot see who on your team can actually play position 3, and it never will,
 * so the honest shape of this feature is a shortlist with the stretch on each
 * move made visible and the decision left with the person who knows the players.
 */
export function Rebalance({
  report,
  bySlug,
  lanePlan,
  applied,
  onApply,
  onUndo,
  onLanePlan,
  onClose,
}: RebalanceProps) {
  const { offRole, seatFixes, swaps, options, laneFixes, beyondThreshold, losing } = report;
  /*
    A single trade is both a small move and an arrangement, so it can be on the
    trade-off curve as well — and a card the reader has already read once is
    noise the second time. The small-move list wins the tie: it is the one that
    says what the move costs in the words the reader is already thinking in.
    What is left of the curve is still a curve, because dropping its cheapest
    entries cannot break "increasing in both size and reward".
  */
  const shown = new Set([...seatFixes, ...swaps].map((option) => option.id));
  const bigger = options.filter((option) => !shown.has(option.id));
  const smallMoves = swaps.filter((swap) => !seatFixes.some((fix) => fix.id === swap.id));
  const nothingLegal =
    seatFixes.length === 0 &&
    swaps.length === 0 &&
    options.length === 0 &&
    laneFixes.length === 0;
  const panel = useRef<HTMLElement>(null);

  /**
   * Opening moves the reader here, and Escape sends them back.
   *
   * The panel appears above the board and pushes several hundred pixels of it
   * down, which is a large change to make to a page while leaving the keyboard
   * focus behind on a button that now says something else. `onClose` restores
   * focus to the opener — see `App`.
   */
  useEffect(() => {
    panel.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <section
      className="rebalance"
      ref={panel}
      tabIndex={-1}
      role="region"
      aria-labelledby="rebalance-title"
    >
      <div className="rebalance-inner">
        <header className="rebalance-head">
          <div className="rebalance-head-text">
            <h2 id="rebalance-title">Rebalance</h2>
            <p className="muted">
              {`Same five heroes, different seats. The draft reads ${formatSigned(
                report.current.advantage,
                1,
              )} — ${report.currentVerdict.toLowerCase()}.`}
              {losing.length > 0 && (
                <span className="bad">
                  {` Losing ${losing
                    .map((lane) => `${lane.label.toLowerCase()} ${formatSigned(lane.score, 1)}`)
                    .join(", ")}.`}
                </span>
              )}
            </p>
          </div>

          <div className="rebalance-actions">
            {/*
              The deployment is a property of the board, not of this list, and it
              is set here because this is the only place in the app that can set
              it. Labelled and set apart from Close for that reason: changing it
              re-runs the search, and a control that quietly reshuffles the list
              under the reader's cursor has to at least say what it is.
            */}
            <div className="rebalance-plan" role="group" aria-label="Lane deployment">
              <span className="rebalance-plan-label muted">Deployment</span>
              {(["standard", "swapped"] as LanePlan[]).map((plan) => (
                <button
                  key={plan}
                  type="button"
                  className={`pos-chip ${lanePlan === plan ? "pos-chip-active" : ""}`}
                  onClick={() => onLanePlan(plan)}
                  aria-pressed={lanePlan === plan}
                  title={
                    plan === "standard"
                      ? "Normal lanes: our safe duo faces their offlane duo"
                      : "Swapped lanes: safe duo against safe duo, offlane against offlane"
                  }
                >
                  {plan === "standard" ? "Normal" : "Swapped"}
                </button>
              ))}
            </div>
            <button type="button" className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        </header>

        {/*
          Applying rewrites five positions at once and there is no other way to
          put them back — `setPosition` is exclusive, so undoing a three-way
          rotation by hand leaves heroes on nothing. The panel stays open holding
          the board it replaced until the reader is happy or takes it back.
        */}
        {applied && (
          <div className="rebalance-applied" role="status">
            <span>
              <strong>Applied</strong>
              {` — ${applied.label}`}
            </span>
            <button type="button" className="btn btn-small" onClick={onUndo}>
              Undo
            </button>
          </div>
        )}

        {/*
          The check this panel applied to every arrangement it considered and
          never to the board in front of the reader. It goes first because it is
          the only thing here that is a statement about their draft rather than
          about a hypothetical, and because on the board that prompted it the
          rest of the panel was empty.
        */}
        {offRole.length > 0 && (
          <div className="rebalance-applied rebalance-offrole" role="status">
            <span>
              <strong>{offRole.length === 1 ? "Off-role seat" : "Off-role seats"}</strong>
              {" — "}
              {offRole
                .map(
                  (seat) =>
                    `${seat.name} is booked at ${seat.position} ${POSITION_LABEL[
                      seat.position
                    ].toLowerCase()}, ${(seat.fit * 100).toFixed(seat.fit < 0.01 ? 2 : 0)}% of their games`,
                )
                .join("; ")}
              {seatFixes.length === 0 &&
                ". No rearrangement of these five fixes it — that is a draft problem, not a seating one."}
            </span>
          </div>
        )}

        {seatFixes.length > 0 && (
          <>
            <h3 className="rebalance-aside-head">
              Put them back on a seat they play
              <span className="muted">
                {" — these are the only rows here allowed to cost score, and the figure on each says what it costs"}
              </span>
            </h3>
            <OptionList options={seatFixes} bySlug={bySlug} onApply={onApply} />
          </>
        )}

        {smallMoves.length > 0 && (
          <>
            <h3 className="rebalance-aside-head">
              One move at a time
              <span className="muted">
                {" — every single trade that already makes the board better. Take one and the list re-runs on what it leaves; two or three of these usually settle a draft."}
              </span>
            </h3>
            <OptionList options={smallMoves} bySlug={bySlug} onApply={onApply} />
          </>
        )}

        {bigger.length > 0 && (
          <>
            {shown.size > 0 && (
              <h3 className="rebalance-aside-head">
                All at once
                <span className="muted">
                  {" — reseatings no sequence of single trades gets to in one step"}
                </span>
              </h3>
            )}
            <OptionList options={bigger} bySlug={bySlug} onApply={onApply} />
          </>
        )}

        {laneFixes.length > 0 && (
          <>
            <h3 className="rebalance-aside-head">
              Worth it for one lane
              <span className="muted">
                {" — the whole-board figure barely moves, but a lane you are losing stops losing"}
              </span>
            </h3>
            <OptionList options={laneFixes} bySlug={bySlug} onApply={onApply} />
          </>
        )}

        {nothingLegal && (
          <p className="empty">
            {report.pinned
              ? "Every hero is pinned to the one position they play often enough for your role threshold — the deployment was the only thing on the table."
              : `No arrangement beats the board by more than ${report.threshold.toFixed(1)} points, and no lane you are losing is fixed by moving anyone.`}
          </p>
        )}

        {/*
          Shown in full only when there is nothing legal to offer, which is
          exactly the case the list was added for. With good advice already on
          screen it would be arguing against the reader's own threshold setting,
          so it stays one line they can act on if they want to.
        */}
        {beyondThreshold.length > 0 &&
          (nothingLegal ? (
            <>
              <h3 className="rebalance-aside-head">
                Beyond your role threshold
                <span className="muted">
                  {" — these work, but need somebody in a position they hardly ever play"}
                </span>
              </h3>
              <OptionList
                options={beyondThreshold}
                bySlug={bySlug}
                onApply={onApply}
                className="rebalance-options-beyond"
              />
            </>
          ) : (
            <p className="rebalance-foot muted">
              {`${beyondThreshold.length} further arrangement${
                beyondThreshold.length === 1 ? "" : "s"
              } would help but need somebody below your role threshold — lower it in Tuning to see them.`}
            </p>
          ))}

        <footer className="rebalance-foot muted">
          <p>
            Single trades first — all of them — then one arrangement per amount of upheaval.
            Figures are percentage points of win rate: <strong>draft</strong> is the number in the
            top bar — matchups, cohesion and timing, all measured over whole games;{" "}
            <strong>lanes</strong> is what the laning stage is worth, from how the pairings standing
            opposite each other have gone in lane, each side&apos;s record in the lane they would be
            standing in, and how the two duos work together;{" "}
            <strong>seats</strong> is each hero&apos;s record in the position they would take;{" "}
            <strong>overall</strong> is the three together, which is what the lists are ranked on.
          </p>
          <p>
            What the model cannot see is who on your team can actually play the seat, so read the
            off-role flags before you apply anything. {searchNote(report)}
          </p>
        </footer>
      </div>
    </section>
  );
}
