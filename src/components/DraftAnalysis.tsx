import { useMemo, useRef, useState } from "react";
import { buildBriefing } from "../lib/draftInsights";
import { EvidenceStrip, GamePlan, MatchupMap } from "./DraftBriefing";
import type { Dataset } from "../types";
import { HeroPortrait } from "./HeroPortrait";
import { useSheetFocus } from "./useSheetFocus";
import { formatSigned } from "../lib/scoring";
import { NOISE, slotLabel, toMarkdown } from "../lib/analysis";
import type {
  DraftAnalysis as Analysis,
  LaneForm,
  LaneReport,
  PairEdge,
  StageRead,
  StageReport,
  SynergyPair,
} from "../lib/analysis";

interface Props {
  analysis: Analysis;
  data: Dataset;
  /** True once `npm run timings` has been run; drives the game-length card. */
  hasTimings: boolean;
  onClose: () => void;
}

/** Percentage points that fill a bar end to end. Beyond this it just pins. */
const BAR_SCALE = 6;

/**
 * Green, red, or neither — on one threshold for the whole panel.
 *
 * The default used to be 0.05, which meant a lane sitting at +0.1 was painted
 * the same green as one at +4 while the headline, on its own separate 0.5
 * floor, called −0.3 a coin flip. Colour is the fastest thing a reader takes in
 * and it was the least honest signal on the screen. `NOISE` is now the only
 * floor: below it, nothing gets a colour anywhere.
 */
const tone = (n: number, dead = NOISE) => (Math.abs(n) < dead ? "even" : n > 0 ? "good" : "bad");

/**
 * The two curves, drawn.
 *
 * Four rows of "us +1.2 · them −0.4" is a table of a shape, and a shape is the
 * one thing a table is bad at: the question here is not "what is the number in
 * the 35–45 bucket" but "where do the lines cross" — before that point we want
 * fights, after it they do. Plotting it answers that at a glance and the rows
 * below still carry the figures for anyone who wants them.
 *
 * Skews are percentage points either side of each hero's own baseline, so zero
 * is a real line on this chart rather than an arbitrary floor, and it is drawn.
 */
function StageChart({ buckets }: { buckets: StageReport[] }) {
  const usable = buckets;
  if (usable.length < 2) return null;

  const W = 260;
  const H = 96;
  const PAD = { top: 8, right: 8, bottom: 16, left: 8 };
  const values = usable.flatMap((b) => [b.mine, b.theirs]);
  // Never scale tighter than ±1pp: a draft where both lines are flat should
  // *look* flat, not have its rounding errors magnified to fill the box.
  const span = Math.max(1, ...values.map(Math.abs)) * 1.15;

  const x = (i: number) =>
    PAD.left + (i * (W - PAD.left - PAD.right)) / Math.max(1, usable.length - 1);
  const y = (v: number) =>
    PAD.top + ((span - v) / (2 * span)) * (H - PAD.top - PAD.bottom);

  const path = (pick: (b: StageReport) => number, has: (b: StageReport) => boolean) => {
    let active = false;
    return usable.map((b, i) => {
      if (!has(b)) { active = false; return ""; }
      const command = active ? "L" : "M";
      active = true;
      return `${command}${x(i).toFixed(1)} ${y(pick(b)).toFixed(1)}`;
    }).join(" ");
  };

  return (
    <figure className="stage-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Win-rate skew by game length">
        <line
          className="stage-axis"
          x1={PAD.left}
          x2={W - PAD.right}
          y1={y(0)}
          y2={y(0)}
        />
        <path className="stage-line stage-line-them" d={path((b) => b.theirs, (b) => b.theirCovered > 0)} />
        <path className="stage-line stage-line-us" d={path((b) => b.mine, (b) => b.covered > 0)} />
        {usable.map((b, i) => (
          <g key={b.key}>
            {b.theirCovered > 0 && (
              <circle className="stage-dot stage-dot-them" cx={x(i)} cy={y(b.theirs)} r={2.5} />
            )}
            {b.covered > 0 && (
              <circle className="stage-dot stage-dot-us" cx={x(i)} cy={y(b.mine)} r={2.5} />
            )}
            <text className="stage-tick" x={x(i)} y={H - 4} textAnchor="middle">
              {b.short}
            </text>
          </g>
        ))}
      </svg>
      <figcaption className="muted">
        <span className="stage-key stage-key-us" aria-hidden /> us ·{" "}
        <span className="stage-key stage-key-them" aria-hidden /> them · points either side of each
        hero&rsquo;s own win rate
      </figcaption>
    </figure>
  );
}

/**
 * A bar that grows out of the middle rather than the left edge.
 *
 * Every number in this panel is signed and read against zero, and a
 * left-anchored bar quietly implies the opposite — that more is further along
 * some scale. Growing from the centre puts "we are losing this" on the left of
 * the line and "we are winning it" on the right, which is how the numbers are
 * actually used.
 */
function Diverging({ value, scale = BAR_SCALE }: { value: number; scale?: number }) {
  const width = Math.min(50, (Math.abs(value) / scale) * 50);
  return (
    <span className="diverge" aria-hidden>
      <span className="diverge-axis" />
      <span
        className={`diverge-fill ${tone(value)}`}
        style={value >= 0 ? { left: "50%", width: `${width}%` } : { right: "50%", width: `${width}%` }}
      />
    </span>
  );
}

/** "Axe beats Lina by 3.2" — one row of the threats and edges lists. */
function PairRow({ pair }: { pair: PairEdge }) {
  const losing = pair.advantage < 0;
  return (
    <li
      className="pair-row"
      title={
        `${slotLabel(losing ? pair.theirs : pair.mine)} is favoured · ` +
        `${pair.matches.toLocaleString()} matches on Dotabuff, measured across whole games rather than a lane` +
        // Dotabuff publishes this pairing on both heroes' pages and the two do
        // not always agree. Where the gap is as large as the edge itself, the
        // reader should see it rather than trust one averaged decimal.
        (pair.spread >= NOISE
          ? ` · the two pages disagree by ${pair.spread.toFixed(1)}, so treat this as approximate`
          : "") +
        (pair.sameLane ? " · they share a lane" : "")
      }
    >
      <span className="pair-names">
        {pair.sameLane && <span className="pair-lane">⚔</span>}
        <strong>{losing ? pair.theirs.name : pair.mine.name}</strong>
        <span className="muted"> beats </span>
        {losing ? pair.mine.name : pair.theirs.name}
      </span>
      <span className={`pair-value ${tone(pair.advantage)}`}>{formatSigned(pair.advantage, 1)}</span>
    </li>
  );
}

/**
 * The chemistry of the two heroes holding one side of a lane.
 *
 * Deliberately quiet. It is a whole-game pairing figure that knows nothing
 * about who is standing opposite, so colouring it like a lane edge would claim
 * more than it means — it only takes a colour once it is big enough to be worth
 * a decision, and the sides are named because "ours −0.5, theirs −0.5" in two
 * different colours reads as a bug otherwise.
 */
function Duo({ pair, label, side }: { pair: SynergyPair; label: string; side: 1 | -1 }) {
  // Kept above the shared floor rather than at it: this is a whole-game pairing
  // figure standing in a lane card, so it earns a colour later than the rest.
  const loud = Math.abs(pair.synergy) >= 1;
  return (
    <span
      title={
        `${pair.a.name} and ${pair.b.name} stand here together — ${formatSigned(pair.synergy, 2)} ` +
        `win-rate points beyond what the two are worth apart, over ${pair.matches.toLocaleString()} games ` +
        `on the same team. Measured across all their games, whoever they faced.`
      }
    >
      {`${label} `}
      <span className={loud ? tone(side * pair.synergy) : ""}>
        {formatSigned(pair.synergy, 1)}
      </span>
    </span>
  );
}

/**
 * One side's record from the lane it is standing in.
 *
 * Coloured on the same rule as everything else — green is good for you, so a
 * weak enemy lane is green — and only once it is worth a decision, since half a
 * point of lane win rate is not one.
 */
function Form({ form, label, side }: { form: LaneForm; label: string; side: 1 | -1 }) {
  const loud = Math.abs(form.value) >= 1;
  return (
    <span
      title={
        `${form.covered === form.possible ? "Both heroes" : `${form.covered} of ${form.possible} heroes`}` +
        ` here, averaged: ${formatSigned(form.value, 2)} points either side of 50 from this lane` +
        `, shrunk towards their overall win rate when they rarely stand in it.`
      }
    >
      {`${label} `}
      <span className={loud ? tone(side * form.value) : ""}>
        {formatSigned(form.value, 1)}
      </span>
    </span>
  );
}

/** `2` not `2.0`, `1.5` not `1.50` — these are slider values, not measurements. */
const trim = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/**
 * What the map row is worth, said with the numbers rather than about them.
 *
 * The sentence this replaces was a hard-coded claim — "they count once each in
 * the headline where lane pairings count twice, which on a full board is still
 * most of its weight" — and it was wrong three ways at once. Lane pairings
 * count `1 + laneWeight` times and that slider is user-facing, so "twice" only
 * held at the default. "Most of its weight" was false *at* the default: 16 map
 * pairings against 9 lane pairings at double weight is 16 of 34, a minority,
 * and it only becomes a majority below a lane weight of about 0.78. And the
 * share was never a share of the headline — the headline adds synergy and a
 * timing term to the matchup figure, so the map front was under a tenth of it
 * on the draft that exposed this.
 *
 * Reading the share off `lane.weight` costs a line and cannot go stale when
 * someone moves the slider.
 */
function mapWeightNote(lane: LaneReport): string {
  const seats = `${lane.covered} of ${lane.possible} pairings between heroes who never meet in a lane`;
  if (!lane.weight) return `${seats}.`;

  const { own, total, laneMultiple } = lane.weight;
  const share = total ? Math.round((100 * own) / total) : 0;
  const versus =
    laneMultiple === 1
      ? "Nothing on the board counts for more than one right now — the lane weight is at zero"
      : `Each counts once where a lane pairing counts ${trim(laneMultiple)}×`;

  return (
    `${seats}. ${versus}, so they carry ${trim(own)} of the ${trim(total)} units of weight ` +
    `behind the matchups figure — ${share}% of it. That figure is one of three terms in the ` +
    `headline; team synergy and the early-game shortfall are the others.`
  );
}

function LaneRow({ lane }: { lane: LaneReport }) {
  const staffed = lane.mine.length > 0 || lane.theirs.length > 0;
  const thin = lane.covered > 0 && lane.covered < lane.possible;
  return (
    <div className={`lane-row ${lane.contested ? "" : "lane-row-thin"}`}>
      <div className="lane-top">
        <span className="lane-name">
          {lane.label}
          {/*
            A lane built from two of four pairings used to print the same
            confident figure as one built from all four, with nothing to say so.
          */}
          {thin && (
            <span className="muted" title="Pairings here that had a usable sample. The rest are not counted — the figure is an average of what is left.">
              {` · ${lane.covered}/${lane.possible}`}
            </span>
          )}
        </span>
        {lane.covered > 0 || lane.measured ? (
          <span
            className={`lane-value ${tone(lane.score)}`}
            title={
              lane.measured
                ? "What this lane is worth in games, in win-rate points: how these pairings have " +
                  "gone in lane, the heroes' record from this lane and the 2v2 chemistry, weighted " +
                  "ahead of the whole-game head-to-head figures. The rows below are the inputs."
                : "Mean of the whole-game matchup figures between the heroes standing here. " +
                  "Nothing measured in a lane was available, so this is all the read there is."
            }
          >
            {formatSigned(lane.score, 1)}
          </span>
        ) : (
          <span className="muted lane-value">—</span>
        )}
      </div>

      <Diverging value={lane.covered > 0 || lane.measured ? lane.score : 0} />

      {staffed && (
        <div className="lane-sides muted">
          <span>{lane.mine.map((s) => s.name).join(", ") || "nobody"}</span>
          <span className="lane-vs">vs</span>
          <span>{lane.theirs.map((s) => s.name).join(", ") || "nobody"}</span>
        </div>
      )}

      {lane.outcome && (
        <p className="lane-note muted lane-duos">
          <span
            className="lane-duos-label"
            title="Who takes the laning stage: each side's expected share of it — lanes won plus half of those drawn — from STRATZ's lane outcomes, built from both heroes' lane records and how these particular heroes have fared against each other."
          >
            laning
          </span>
          <span>
            {"ours "}
            {/* A 52–48 lane is an even one; the dead zone is in lane share, not win rate. */}
            <span className={tone(lane.outcome.result, 2)}>
              {`${Math.round(50 + lane.outcome.result)}%`}
            </span>
          </span>
          <span>{`theirs ${Math.round(50 - lane.outcome.result)}%`}</span>
          {lane.outcome.covered > 0 && (
            <span title="What these particular pairings' own lane results are worth in games, in win-rate points — not the lane as a whole. A hero's general lane strength is left out, because across heroes it does not show up in game results, so a lane you expect to lose can still carry pairings that favour you.">
              {"pairings worth "}
              <span className={tone(lane.outcome.gameEdge)}>{formatSigned(lane.outcome.gameEdge, 1)}</span>
            </span>
          )}
        </p>
      )}

      {(lane.myForm || lane.theirForm) && (
        <p className="lane-note muted lane-duos">
          <span
            className="lane-duos-label"
            title="Win rate of the heroes standing here in games they played from this lane, either side of 50. A game figure, not a laning one — it barely tracks who wins the lane — and it says nothing about who they face."
          >
            form
          </span>
          {lane.myForm && <Form form={lane.myForm} label="ours" side={1} />}
          {lane.theirForm && <Form form={lane.theirForm} label="theirs" side={-1} />}
          {lane.formEdge !== null && (
            <span title="Our record from this lane minus theirs, in games won.">
              {"edge "}
              <span className={tone(lane.formEdge)}>{formatSigned(lane.formEdge, 1)}</span>
            </span>
          )}
        </p>
      )}

      {(lane.myDuo || lane.theirDuo) && (
        <p className="lane-note muted lane-duos">
          <span
            className="lane-duos-label"
            title="Chemistry between the two heroes standing together, over all their games on the same team — not measured against the pair opposite."
          >
            duo
          </span>
          {lane.myDuo && <Duo pair={lane.myDuo} label="ours" side={1} />}
          {lane.theirDuo && <Duo pair={lane.theirDuo} label="theirs" side={-1} />}
          {lane.duoEdge !== null && (
            <span title="Our pair's chemistry minus theirs — the 2v2 half of the read, and the second of the two rows the headline is built mostly from.">
              {"edge "}
              <span className={tone(lane.duoEdge)}>{formatSigned(lane.duoEdge, 1)}</span>
            </span>
          )}
        </p>
      )}

      {/*
        Demoted from the headline. This is the figure that used to be set in
        large type at the top of the row, and it is the one reading here that
        was never taken from a lane: on a 2v2 it averages in the support-versus-
        carry pairings, which say nothing about laning and are quite capable of
        carrying the mean back across zero on their own.

        Only shown where it is an *input* — with nothing lane-measured to blend
        it with, the headline already is this number, and printing it twice
        would imply a second opinion that does not exist.
      */}
      {lane.covered > 0 && lane.measured && (
        <p className="lane-note muted lane-duos">
          <span
            className="lane-duos-label"
            title="Mean head-to-head advantage between the heroes standing here, over whole games in which they were on opposing sides. Grouping by lane chose which figures to show; it did not change what they measured."
          >
            matchups
          </span>
          <span>
            {"whole game "}
            <span className={Math.abs(lane.advantage) >= NOISE ? tone(lane.advantage) : ""}>
              {formatSigned(lane.advantage, 1)}
            </span>
          </span>
        </p>
      )}

      {lane.myForm?.worst && (
        <p className="lane-note bad">
          {`${lane.myForm.worst.name} is the weak half (${formatSigned(lane.myForm.worst.value, 1)} from this lane)`}
        </p>
      )}

      {!lane.contested && staffed && (
        <p className="lane-note muted">Uncontested so far — nobody booked opposite.</p>
      )}

      {lane.key === "map" && (
        <p className="lane-note muted">{mapWeightNote(lane)}</p>
      )}

      {/*
        Three rather than two, so that a "split" note — the lane's two readings
        disagreeing — never pushes the losing pairing off the bottom. It is the
        most important line in the card and it is additional to the others, not
        a replacement for them.
      */}
      {lane.notes.slice(0, 3).map((note) => (
        <p
          key={note.text}
          className={`lane-note ${note.kind === "split" ? "lane-note-split " : ""}${
            note.value === null ? "" : tone(note.value)
          }`}
        >
          {note.text}
        </p>
      ))}
    </div>
  );
}

function StageRow({
  stage,
  sides,
  share,
}: {
  stage: StageReport;
  sides: { mine: number; enemy: number };
  /** Share of all games that end in this window, or null without timings. */
  share: number | null;
}) {
  /**
   * Both sides' coverage, against the real team size.
   *
   * This row used to hard-code "/5" and report only my own coverage, so an edge
   * built from five of my heroes against two of theirs looked exactly like one
   * built from five against five. The edge is a difference of two means; if the
   * two means are averages over different numbers of heroes, that is the first
   * thing a reader needs to know about it.
   */
  const partial = stage.covered < sides.mine || stage.theirCovered < sides.enemy;
  const comparable = stage.covered > 0 && stage.theirCovered > 0;
  return (
    <div className="stage-row">
      <div className="lane-top">
        <span className="lane-name">{stage.label}</span>
        <span className={`lane-value ${comparable ? tone(stage.edge) : "even"}`}>{comparable ? formatSigned(stage.edge, 1) : "—"}</span>
      </div>
      <Diverging value={comparable ? stage.edge : 0} scale={3} />
      <p className="lane-note muted">
        {`us ${stage.covered ? formatSigned(stage.mine, 1) : "unknown"} · them ${stage.theirCovered ? formatSigned(stage.theirs, 1) : "unknown"}`}
        {/*
         * How often games actually end here.
         *
         * The four rows are the same height and used to look equally
         * consequential. They are not: a third of games reach the last window
         * and one game in fifty ends in the first, so a draft that is +6 in the
         * first and −2 in the last is behind, not ahead. Printing the share on
         * the row is the cheapest possible way to stop the four numbers being
         * read as if they were weighted the same.
         */}
        {share !== null ? ` · ${Math.round(share * 100)}% of games end here` : ""}
        {partial
          ? ` · timed ${stage.covered}/${sides.mine} vs ${stage.theirCovered}/${sides.enemy}`
          : ""}
      </p>
    </div>
  );
}

/**
 * The two figures that turn the four window rows into a decision.
 *
 * The card could already tell you your window was 45 minutes and up. What it
 * could not tell you is that you have to reach it — and the draft that prompted
 * this row was +1.8 in the last window, −4.0 in the first, read out as a slight
 * edge, and lost before it ever got to play the game it was built for.
 *
 * `weightedEdge` is the same four numbers priced by how often games actually
 * end in each window, and it is routinely a different sign from the mean of
 * them. `cover` is the count the mean cannot express: how many heroes on each
 * side function before the median game, out of five. Nought of five with a
 * good late number is the exact shape being warned about, and it is invisible
 * in every other figure on this panel.
 */
function SurvivalRow({
  stages,
  sides,
}: {
  stages: StageRead;
  sides: { mine: number; enemy: number };
}) {
  if (stages.weightedEdge === null && stages.cover === null) return null;
  const risk = stages.exposure;
  const cost = stages.penalty - stages.theirPenalty;

  return (
    <div className="stage-row">
      <div className="lane-top">
        <span className="lane-name">Weighted for how long games run</span>
        {stages.weightedEdge !== null && (
          <span className={`lane-value ${tone(stages.weightedEdge)}`}>
            {formatSigned(stages.weightedEdge, 1)}
          </span>
        )}
      </div>
      {stages.weightedEdge !== null && <Diverging value={stages.weightedEdge} scale={3} />}
      <p className="lane-note muted">
        {[
          stages.weightedEdge !== null
            ? `every window priced by how often games end in it — the flat average of the four is ${formatSigned(
                stages.buckets.reduce((s, b) => s + b.edge, 0) / (stages.buckets.length || 1),
                1,
              )}`
            : null,
          risk !== null && risk > 0
            ? `${Math.round(risk * 100)}% of games finish before you are ahead`
            : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {stages.cover !== null && (
        <p className={`lane-note ${cost >= NOISE ? "bad" : "muted"}`}>
          {`Early-cover equivalents${sides.mine < 5 || sides.enemy < 5 ? " (projected to five)" : ""}: ours ${stages.cover.toFixed(1)} of 5`}
          {stages.theirCover !== null ? `, theirs ${stages.theirCover.toFixed(1)} of 5` : ""}
          {/*
           * Only shown once it is actually costing something. A draft with
           * ordinary cover pays nothing and does not need telling that a term
           * it is not being charged for exists.
           */}
          {cost >= NOISE ? ` — costing ${formatSigned(-cost, 1)} in the headline` : ""}
        </p>
      )}
    </div>
  );
}

function SynergyRow({ pair, side }: { pair: SynergyPair; side: 1 | -1 }) {
  return (
    <li className="pair-row" title={`${pair.matches.toLocaleString()} games together`}>
      <span className="pair-names">
        {pair.a.name} <span className="muted">+</span> {pair.b.name}
      </span>
      <span className={`pair-value ${tone(side * pair.synergy)}`}>
        {formatSigned(pair.synergy, 1)}
      </span>
    </li>
  );
}

/**
 * The draft taken apart.
 *
 * The figure on the Draft analysis button is one number, which is the right size
 * for a glance and no use to a captain who has to tell four other people what the plan is.
 * This is that number's working: where we are losing, when we are meant to win,
 * who is carrying and who is struggling — with the sample size beside each
 * claim, because half of these numbers deserve less confidence than they look
 * like they deserve.
 */
export function DraftAnalysis({ analysis, data, hasTimings, onClose }: Props) {
  /**
   * Collapsed to the headline and the talking points.
   *
   * Even capped at 45vh the full read-out costs half the board, which is the
   * wrong trade while you are still picking: mid-draft you want the one-line
   * verdict and the whole hero grid, and the tables afterwards.
   */
  const [compact, setCompact] = useState(false);
  const [view, setView] = useState<"plan" | "matchups" | "details">("plan");
  const briefing = useMemo(() => buildBriefing(analysis), [analysis]);
  /**
   * Confirmation for the copy button. A clipboard write is silent, and a
   * button that looks identical before and after being pressed leaves the
   * reader unsure whether anything happened — so it says so for a moment.
   */
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const panel = useRef<HTMLElement>(null);
  useSheetFocus(panel, onClose);
  const points = briefing.insights.slice(0, 4).map((insight) => `${insight.title} — ${insight.action}`);
  const { coverage, stages, sides } = analysis;
  const thin = coverage.matchupsPossible > 0 && coverage.matchups / coverage.matchupsPossible < 0.6;
  const synergyPairs = analysis.mySynergyPairs.length + analysis.theirSynergyPairs.length;

  return (
    <section
      className="sheet analysis"
      ref={panel}
      tabIndex={-1}
      role="region"
      aria-labelledby="analysis-title"
    >
      <header className="sheet-head">
        <div className="sheet-title">
          <h2 id="analysis-title">Draft analysis</h2>
          <p className="muted">
            How the two line-ups compare and what to play for. Updates as heroes go on the board.
          </p>
        </div>

        <div className="sheet-actions">
          {!analysis.complete && (
            <span className="tag" title="Sections fill in as heroes go on the board">
              draft in progress
            </span>
          )}
          {!analysis.lanesResolved && (
            <span className="tag" title="Set positions in the team panels to get the lane split">
              positions incomplete
            </span>
          )}
          {analysis.lanePlan === "swapped" && (
            <span
              className="tag tag-warn"
              title="Lanes are swapped: your safe duo walked into their safe lane and your offlane duo into theirs, so carry meets carry. Their heroes have not moved — only yours are read against a different lane record."
            >
              lanes swapped
            </span>
          )}
          <span
            className={`tag ${thin ? "tag-bad" : ""}`}
            title="How many of the pairings on the board Dotabuff and OpenDota had a usable sample for. The rest are simply not counted."
          >
            {`${coverage.matchups}/${coverage.matchupsPossible} matchups · ${coverage.synergies}/${coverage.synergiesPossible} pairings`}
          </span>
          <button
            type="button"
            className="btn"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(toMarkdown(analysis));
                setCopied("ok");
              } catch {
                // Clipboard access is refused outside a secure context and in
                // some embedded browsers. Say so rather than appearing to work.
                setCopied("failed");
              }
              window.setTimeout(() => setCopied(null), 2000);
            }}
            title="Copy the whole read-out as text — talking points, lanes, timings and threats"
          >
            {copied === "ok" ? "Copied" : copied === "failed" ? "Copy blocked" : "Copy briefing"}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setCompact((v) => !v)}
            aria-pressed={compact}
            title={
              compact
                ? "Show the lane, timing and pairing tables again"
                : "Keep the verdict and the talking points, give the board back its room"
            }
          >
            Compact
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </header>

      {compact && <div className="intel-compact"><strong>{briefing.title}</strong><span>{briefing.description}</span></div>}
      {compact && points.length > 0 && (
        <ul className="analysis-points">
          {points.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}

      {!compact && <>
        <div className="analysis-views">
          <div className="seg" role="group" aria-label="Analysis views">
            {([["plan", "Game plan"], ["matchups", "Matchup map"], ["details", "Deep dive"]] as const).map(([id, label]) => (
              <button
                type="button"
                key={id}
                className="seg-btn tone-accent"
                aria-pressed={view === id}
                onClick={() => setView(id)}
              >
                {label}
                {id === "matchups" && <span className="num-chip">{coverage.matchups}</span>}
              </button>
            ))}
          </div>
        </div>
        {view === "plan" && <GamePlan analysis={analysis} briefing={briefing} heroes={data.bySlug} />}
        {view === "matchups" && <MatchupMap analysis={analysis} heroes={data.bySlug} />}
      </>}
      <div className="analysis-grid" hidden={compact || view !== "details"}>
        <article className="analysis-card">
          <h3>Lanes</h3>
          {/*
            The subtitle has been wrong twice. It first read "Only the heroes
            who would actually stand opposite each other", implying the figures
            were measured in a lane — they were not. The fix said so honestly
            and left the whole-game matchup mean as the headline anyway, which
            was worse: the card admitted its big number answered a different
            question and printed it in large type regardless. Now the headline
            is the blend, and the subtitle says what it leans on.
          */}
          <p className="analysis-card-sub muted">
            Who takes each lane, and what it is worth in games. <em>laning</em> is the lane
            itself; the headline leans on it, <em>form</em> and <em>duo</em> over the
            whole-game <em>matchups</em>.
          </p>
          {analysis.lanes.map((lane) => (
            <LaneRow key={lane.key} lane={lane} />
          ))}
        </article>

        <article className="analysis-card">
          <h3>Game length</h3>
          {stages ? (
            <>
              <p className="analysis-card-sub muted">{stages.summary}</p>
              <StageChart buckets={stages.buckets} />
              <SurvivalRow stages={stages} sides={sides} />
              {stages.buckets.map((stage, i) => (
                <StageRow
                  key={stage.key}
                  stage={stage}
                  sides={sides}
                  share={stages.shares?.[i] ?? null}
                />
              ))}
              {(stages.mostLate || stages.mostEarly) && (
                <p className="lane-note muted">
                  {[
                    stages.mostLate
                      ? `${stages.mostLate.name} has our strongest late-game skew (${formatSigned(stages.mostLate.skew, 1)} in the last window)`
                      : null,
                    stages.mostEarly
                      ? `${stages.mostEarly.name} has our weakest late-game skew (${formatSigned(stages.mostEarly.skew, 1)})`
                      : null,
                  ]
                    .filter(Boolean)
                    .join("; ")}
                </p>
              )}
            </>
          ) : (
            <p className="empty">
              {hasTimings
                ? "None of the drafted heroes have timing data yet."
                : "Run `npm run timings` once to collect win rate by game length, then reload."}
            </p>
          )}
        </article>

        <article className="analysis-card">
          <h3>Our lineup</h3>
          <p className="analysis-card-sub muted">
            Matchups against their line-up plus fit with ours, best first.
          </p>
          {analysis.heroes.map((report) => (
            <div key={report.hero.slug} className="hero-row">
              <HeroPortrait hero={report.hero} className="portrait-sm" />
              <div className="hero-row-body">
                <div className="lane-top">
                  <span className="lane-name">
                    {report.hero.name}
                    {report.position ? <span className="muted"> · {report.position}</span> : null}
                  </span>
                  <span className={`lane-value ${tone(report.total)}`}>
                    {formatSigned(report.total, 1)}
                  </span>
                </div>
                <Diverging value={report.total} />
                {/*
                  "fit" was ambiguous next to a panel that uses the same word
                  for position fit; this column has always been chemistry with
                  our own four. "struggles into" now only appears when `worst`
                  is non-null, which analysis.ts gates on NOISE — it used to be
                  whichever pairing sorted last, so a hero at +1.3 whose worst
                  matchup was −0.1 was still reported as struggling into it.
                */}
                <p className="lane-note muted">
                  {`h2h ${formatSigned(report.matchup, 1)} · with ours ${formatSigned(report.synergy, 1)}`}
                  {report.covered < sides.enemy ? ` · ${report.covered}/${sides.enemy} matched` : ""}
                  {report.worst ? ` · struggles into ${report.worst.theirs.name}` : ""}
                </p>
              </div>
            </div>
          ))}
        </article>

        <article className="analysis-card">
          <h3>Pairings that matter</h3>
          <h4 className="analysis-sub-head">Against us</h4>
          {analysis.threats.length ? (
            <ul className="pair-list">
              {analysis.threats.map((p) => (
                <PairRow key={`${p.mine.slug}-${p.theirs.slug}`} pair={p} />
              ))}
            </ul>
          ) : (
            <p className="empty">
              Nothing on their side beats one of ours by more than {NOISE.toFixed(1)}.
            </p>
          )}

          <h4 className="analysis-sub-head">For us</h4>
          {analysis.edges.length ? (
            <ul className="pair-list">
              {analysis.edges.map((p) => (
                <PairRow key={`${p.mine.slug}-${p.theirs.slug}`} pair={p} />
              ))}
            </ul>
          ) : (
            <p className="empty">
              No pairing of ours is ahead by more than {NOISE.toFixed(1)} yet.
            </p>
          )}
        </article>

        {synergyPairs > 0 && (
          <article className="analysis-card">
            <h3>Cohesion</h3>
            {/*
              Two decimals, and the edge stated rather than left to be worked
              out. At one decimal this line read "ours −0.0, theirs +0.2" while
              the headline said cohesion −0.3: subtract the two printed figures
              and you get −0.2, so the card looked like it disagreed with the
              top of the panel. It never did — −0.014 and +0.240 really do make
              −0.25 — but a reader has no way to see that from rounded numbers.
            */}
            <p className="analysis-card-sub muted">
              {`Our pairings average ${formatSigned(analysis.mySynergy, 2)}, theirs ${formatSigned(analysis.theirSynergy, 2)} — `}
              {`a ${formatSigned(analysis.synergyEdge, 2)} edge ${analysis.synergyEdge >= 0 ? "to us" : "to them"}.`}
            </p>
            <h4 className="analysis-sub-head">Ours</h4>
            <ul className="pair-list">
              {analysis.mySynergyPairs.slice(0, 3).map((p) => (
                <SynergyRow key={`${p.a.slug}-${p.b.slug}`} pair={p} side={1} />
              ))}
              {analysis.mySynergyPairs.length > 3 &&
                analysis.mySynergyPairs.slice(-1).map((p) => (
                  <SynergyRow key={`worst-${p.a.slug}-${p.b.slug}`} pair={p} side={1} />
                ))}
            </ul>
            {analysis.theirSynergyPairs.length > 0 && (
              <>
                <h4 className="analysis-sub-head">Theirs</h4>
                <ul className="pair-list">
                  {analysis.theirSynergyPairs.slice(0, 3).map((p) => (
                    <SynergyRow key={`them-${p.a.slug}-${p.b.slug}`} pair={p} side={-1} />
                  ))}
                </ul>
              </>
            )}
          </article>
        )}
      </div>

      {!compact && <EvidenceStrip analysis={analysis} data={data} />}
      <p className="analysis-foot muted" hidden={compact || view !== "details"}>
        Matchup and synergy edges are measured over whole games. Lane share describes lane wins
        plus half of draws; form describes game results from that lane. Timing skews are relative
        to each hero’s own baseline. The composite draft score is a comparison signal, not a win
        probability. Edges below {NOISE.toFixed(1)} points are treated as noise.

      </p>
    </section>
  );
}
