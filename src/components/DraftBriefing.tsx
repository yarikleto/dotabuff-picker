import { useState } from "react";
import type { Dataset, Hero } from "../types";
import type { DraftAnalysis, DraftWin, LineupSlot, StageReport } from "../lib/analysis";
import { allMatchups, type DraftBriefing as Briefing } from "../lib/draftInsights";
import { NOISE, formatSigned } from "../lib/scoring";
import { HeroPortrait } from "./HeroPortrait";

const signed = (n: number) => formatSigned(n, 1);
const tone = (n: number, floor = NOISE) => Math.abs(n) < floor ? "even" : n > 0 ? "good" : "bad";
type Heroes = Map<string, Hero>;

const winTone = (side: DraftWin["verdict"]["side"]) => (side === "even" ? "even" : side === "mine" ? "good" : "bad");
const wholePct = (n: number) => `${Math.round(n * 100)}%`;

/** The line under the chance: what drafts rated like this actually did, or why there is no such line. */
function winEvidence(win: DraftWin): string {
  if (!win.inRange) return `Model ${wholePct(win.chance)} · beyond the range the calibration can vouch for`;
  if (win.evidence) {
    return (
      `Drafts rated ${wholePct(win.evidence.from)}–${wholePct(win.evidence.to)} won ` +
      `${(win.evidence.actual * 100).toFixed(1)}% of ${win.evidence.games.toLocaleString()} line-ups in an out-of-fold check`
    );
  }
  return `Calibrated on ${win.matches.toLocaleString()} ranked games`;
}

function Face({ slot, heroes }: { slot: LineupSlot; heroes: Heroes }) {
  const hero = heroes.get(slot.slug);
  return hero ? <HeroPortrait hero={hero} className="intel-portrait" /> : <span className="intel-initial">{slot.name.slice(0, 2)}</span>;
}

export function TimingExplorer({ analysis }: { analysis: DraftAnalysis }) {
  const stages = analysis.stages;
  const [selectedKey, select] = useState<string | null>(null);
  if (!stages) return <div className="intel-empty">Timing data is unavailable for this draft. Matchup and lane insights still work.</div>;
  const buckets = stages.buckets;
  const selected = buckets.find((b) => b.key === selectedKey) ?? buckets[0]!;
  const complete = (b: StageReport) => b.covered === analysis.sides.mine && b.theirCovered === analysis.sides.enemy;
  const comparable = selected.covered > 0 && selected.theirCovered > 0;
  const span = Math.max(2, Math.ceil(Math.max(...buckets.flatMap((b) => [Math.abs(b.mine), Math.abs(b.theirs)]))));
  const W = 460, H = 158, left = 30, right = 435, top = 14, bottom = 130;
  const x = (i: number) => left + i * (right - left) / Math.max(1, buckets.length - 1);
  const y = (v: number) => top + (span - v) / (2 * span) * (bottom - top);
  const line = (side: "mine" | "theirs") => {
    let active = false;
    return buckets.map((b, i) => {
      const has = side === "mine" ? b.covered : b.theirCovered;
      if (!has) { active = false; return ""; }
      const command = active ? "L" : "M";
      active = true;
      return `${command}${x(i)} ${y(b[side])}`;
    }).join(" ");
  };
  return <>
    <div className="intel-chart-legend"><span className="mine">● Your team</span><span className="enemy">● Enemy team</span><span>Relative timing skew</span></div>
    <svg className="intel-timing-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Relative timing trends by game duration; select a window below for details">
      {[-span, 0, span].map((v) => <g key={v}>
        <line x1={left} x2={right} y1={y(v)} y2={y(v)} className={v === 0 ? "intel-chart-zero" : "intel-chart-grid"} />
        <text x={0} y={y(v) + 4}>{v > 0 ? "+" : ""}{v}</text>
      </g>)}
      <line x1={x(buckets.indexOf(selected))} x2={x(buckets.indexOf(selected))} y1={top} y2={bottom} className="intel-chart-cursor" />
      <path d={line("theirs")} className="intel-curve enemy" />
      <path d={line("mine")} className="intel-curve mine" />
      {buckets.map((b, i) => <g key={b.key}>
        {b.covered > 0 && <circle cx={x(i)} cy={y(b.mine)} r={b === selected ? 5 : 3} className="intel-point mine" />}
        {b.theirCovered > 0 && <circle cx={x(i)} cy={y(b.theirs)} r={b === selected ? 5 : 3} className="intel-point enemy" />}
        <text x={x(i)} y={151} textAnchor="middle">{b.short}</text>
      </g>)}
    </svg>
    <div className="seg intel-windows" role="group" aria-label="Game-length windows">
      {buckets.map((b) => <button type="button" key={b.key} className="seg-btn tone-accent" aria-pressed={b === selected} onClick={() => select(b.key)}>
        <span>{b.short}</span><strong className={b.covered && b.theirCovered ? tone(b.edge) : "even"}>{b.covered && b.theirCovered ? signed(b.edge) : "—"}</strong>
      </button>)}
    </div>
    <div className="intel-window-detail" aria-live="polite">
      <strong>{selected.label} <span className={comparable ? tone(selected.edge) : "even"}>{!comparable ? "· unknown" : Math.abs(selected.edge) < NOISE ? "· balanced trend" : selected.edge > 0 ? "· favors your timing" : "· favors their timing"}</span></strong>
      <p>{comparable ? `You ${signed(selected.mine)} · them ${signed(selected.theirs)} relative to each hero’s own baseline.` : "Both lineups need timing data to compare this window."}
        {!complete(selected) && ` Measured: ${selected.covered}/${analysis.sides.mine} yours, ${selected.theirCovered}/${analysis.sides.enemy} theirs.`}</p>
      {stages.shares && <span className="intel-small">{Math.round(stages.shares[buckets.indexOf(selected)]! * 100)}% of sampled games end in this window. Not this draft’s win probability.</span>}
    </div>
  </>;
}

export function GamePlan({ analysis: a, briefing: b, heroes }: { analysis: DraftAnalysis; briefing: Briefing; heroes: Heroes }) {
  const hasMatchups = a.coverage.matchups > 0;
  const measuredLanes = a.lanes.filter((l) => l.key !== "map" && l.outcome).length;
  const threat = b.threats[0];
  const win = a.win;
  return <div className="intel-overview">
    <div className="intel-strategy">
      <div><h2>{b.title}</h2><p>{b.description}</p></div>
      {win ? (
        <div className="intel-draft-score"><span className="intel-label">Win chance</span><strong className={winTone(win.verdict.side)}>{win.shown}</strong><span>{win.verdict.label}</span><small>{winEvidence(win)}</small></div>
      ) : (
        <div className="intel-draft-score"><span className="intel-label">Draft edge</span><strong className={hasMatchups ? tone(a.advantage) : "even"}>{hasMatchups ? signed(a.advantage) : "—"}</strong><span>{hasMatchups ? a.verdict.label : "Insufficient matchup data"}</span><small>Comparison signal · not win probability</small></div>
      )}
    </div>
    <div className="intel-metrics">
      <div><span className="intel-label">Best timing</span><strong>{b.bestWindow?.short ?? (b.timingComplete ? "No clear edge" : "Unknown")}</strong><small>{b.bestWindow ? `${signed(b.bestWindow.edge)} relative timing skew` : b.timingComplete ? "No window clears the noise floor" : "Both lineups need full timing data"}</small></div>
      <div><span className="intel-label">Opening pressure</span><strong>{a.lanesResolved && measuredLanes > 0 ? `${b.pressuredLanes.length} lane${b.pressuredLanes.length === 1 ? "" : "s"}` : "Unknown"}</strong><small>{a.lanesResolved && measuredLanes > 0 ? (b.pressuredLanes.map((l) => l.label).join(" · ") || `${measuredLanes}/3 lanes measured · none clearly pressured`) : "Assign positions and collect lane records"}</small></div>
      <div><span className="intel-label">Widest enemy threat</span><strong>{threat?.hero.name ?? (hasMatchups ? "None stands out" : "Unknown")}</strong><small>{threat ? `${threat.victims.length} unfavorable matchups · ${threat.covered}/${a.sides.mine} measured` : "Based on whole-game matchups"}</small></div>
      <div><span className="intel-label">Games before your window</span><strong>{b.exposure !== null ? `${Math.round(b.exposure * 100)}%` : "—"}</strong><small>{b.firstWindow ? `Before ${b.firstWindow.label.toLowerCase()} · population sample` : "No fully measured favorable window"}</small></div>
    </div>
    <div className="intel-plan-grid">
      <section className="intel-playbook">
        <h3 className="sheet-section">Your playbook<span className="muted"> — a suggested plan, with the evidence under each call</span></h3>
        {b.insights.length ? <div className="intel-insights">{b.insights.map((insight, i) => <article key={insight.id} className={`intel-insight ${insight.tone}`}>
          <div className="intel-insight-label"><span>{insight.label}</span><span className="intel-number">{String(i + 1).padStart(2, "0")}</span></div>
          <h4>{insight.title}</h4><p>{insight.action}</p><details><summary>Why this matters</summary><p>{insight.evidence}</p></details>
        </article>)}</div> : <div className="intel-empty">No measured edge clears the noise floor yet. Add picks or inspect the matchup map to see what is known.</div>}
      </section>
      <aside className="intel-timing-panel"><h3 className="sheet-section">Timing<span className="muted"> — pick a window</span></h3><TimingExplorer analysis={a} />
        {win ? (
          <div className="intel-score-parts"><h4 className="intel-label">What moves the win chance</h4>{[...win.parts].sort((x, y) => Math.abs(y.points) - Math.abs(x.points)).map((p) => (
            <div key={p.group}><span>{p.label}{win.reasons[p.group] && <span className="intel-part-reason">{win.reasons[p.group]}</span>}</span><strong className={tone(p.points)}>{signed(p.points)}</strong></div>
          ))}<small>Points of win chance against an even draft; together they make {win.inRange ? `${win.shown}.` : `the model's ${wholePct(win.chance)}, beyond the range the calibration can vouch for.`}</small></div>
        ) : (
          <div className="intel-score-parts"><h4 className="intel-label">What moves the draft score</h4>{[
            ["Matchups", a.counter], ["Team chemistry", a.cohesionContribution], ["Early cover", a.earlyEdge],
          ].map(([label, value]) => <div key={label}><span>{label}</span><strong className={tone(value as number)}>{signed(value as number)}</strong></div>)}<small>Weighted contributions; totals may differ by 0.1 after rounding.</small></div>
        )}
      </aside>
    </div>
    <h3 className="sheet-section">Lanes<span className="muted">{a.lanePlan === "swapped" ? " — swapped: safe duo against safe duo" : " — standard deployment"}</span></h3>
    {!a.lanesResolved && <p className="intel-notice">Assign every drafted hero a position for a complete lane plan.</p>}
    <div className="intel-lanes">{a.lanes.filter((l) => l.key !== "map").map((l) => {
      const result = l.outcome?.result;
      const read = !a.lanesResolved ? "Provisional lane" : result === undefined ? "Awaiting lane data" : result <= -3 ? "Protect & recover" : result >= 3 ? "Establish pressure" : "Play for small advantages";
      return <article key={l.key} className="intel-lane"><div className="intel-card-head"><h4>{l.label}</h4><span className={result === undefined ? "even" : tone(result, 3)}>{read}</span></div>
        <div className="intel-lane-teams"><div>{l.mine.map((s) => <span key={s.slug} title={s.name}><Face slot={s} heroes={heroes} /><span>{s.name}</span></span>)}</div><b>VS</b><div>{l.theirs.map((s) => <span key={s.slug} title={s.name}><Face slot={s} heroes={heroes} /><span>{s.name}</span></span>)}</div></div>
        <div className="intel-lane-read"><span>Expected lane share</span><strong className={result === undefined ? "even" : tone(result, 3)}>{result === undefined ? "—" : `${Math.round(50 + result)}% ours`}</strong></div>
        <div className="intel-lane-share" aria-hidden="true">{result !== undefined && <span style={{ width: `${50 + result}%` }} />}</div>
        <p>{result !== undefined ? "Lane wins + half of draws, not game win chance." : "Whole-game matchups cannot tell us who wins the lane."}</p>
        <div className="intel-lane-read"><span>Composite game outlook</span><strong className={tone(l.score)}>{l.measured || l.covered ? signed(l.score) : "—"}</strong></div>
        {result !== undefined && ((result <= -3 && l.score >= NOISE) || (result >= 3 && l.score <= -NOISE)) && <div className="intel-tradeoff">Opening and game outlook disagree. Plan for both.</div>}
      </article>;
    })}</div>
  </div>;
}

export function MatchupMap({ analysis: a, heroes }: { analysis: DraftAnalysis; heroes: Heroes }) {
  const [selectedKey, select] = useState<string | null>(null);
  const [laneOnly, setLaneOnly] = useState(false);
  const pairs = allMatchups(a);
  const keyOf = (mine: string, theirs: string) => `${mine}/${theirs}`;
  const pairMap = new Map(pairs.map((p) => [keyOf(p.mine.slug, p.theirs.slug), p]));
  const visible = pairs.filter((p) => !laneOnly || p.sameLane);
  const fallback = [...visible].sort((x, y) => Math.abs(y.advantage) - Math.abs(x.advantage))[0];
  const selected = visible.find((p) => keyOf(p.mine.slug, p.theirs.slug) === selectedKey) ?? fallback;
  const sorted = (slots: LineupSlot[]) => [...slots].sort((x, y) => (x.position ?? 6) - (y.position ?? 6));
  return <div className="intel-matchups">
    <div className="intel-head-row"><h3 className="sheet-section">Every matchup<span className="muted"> — across for your hero’s problems, down for an enemy’s reach; select a cell for its evidence</span></h3><div className="seg seg-sm" role="group" aria-label="Which matchups"><button type="button" className="seg-btn" aria-pressed={!laneOnly} onClick={() => setLaneOnly(false)}>All matchups</button><button type="button" className="seg-btn" aria-pressed={laneOnly} onClick={() => setLaneOnly(true)}>Lane opponents</button></div></div>
    {laneOnly && !a.lanesResolved && <p className="intel-notice">Positions are incomplete. Only confirmed lane opponents are shown.</p>}
    <div className="intel-matrix-layout"><div className="intel-matrix-scroll"><table className="intel-matrix"><caption>Whole-game matchup edge · positive favors your hero · ◇ lane opponent · — no usable sample</caption><thead><tr><th scope="col">YOUR TEAM ↓<br />ENEMY TEAM →</th>{sorted(a.lineups.enemy).map((s) => <th key={s.slug} scope="col"><Face slot={s} heroes={heroes} /><span>{s.name}</span><small>POS {s.position ?? "?"}</small></th>)}</tr></thead><tbody>{sorted(a.lineups.mine).map((s) => <tr key={s.slug}><th scope="row"><Face slot={s} heroes={heroes} /><span>{s.name}</span><small>POS {s.position ?? "?"}</small></th>{sorted(a.lineups.enemy).map((e) => {
      const p = pairMap.get(keyOf(s.slug, e.slug));
      const filtered = laneOnly && !p?.sameLane;
      return <td key={e.slug}>{p && !filtered ? <button type="button" className={`intel-cell ${tone(p.advantage)}`} aria-pressed={p === selected} aria-label={`${s.name} versus ${e.name}: ${signed(p.advantage)} points${p.sameLane ? ", lane opponent" : ""}`} onClick={() => select(keyOf(s.slug, e.slug))} style={{ backgroundColor: Math.abs(p.advantage) < NOISE ? undefined : `color-mix(in srgb, var(${p.advantage > 0 ? "--good" : "--bad"}) ${Math.round(12 + Math.min(Math.abs(p.advantage) / 8, 1) * 20)}%, transparent)` }}>{signed(p.advantage)}{p.sameLane && <small aria-hidden="true">◇</small>}</button> : <span className="intel-cell-empty" title={filtered ? "Outside the lane filter" : "No sample above your match threshold"}>{filtered && p ? "·" : "—"}</span>}</td>;
    })}</tr>)}</tbody></table></div>
      <aside className="intel-pair-detail" aria-live="polite">{selected ? <>
        <span className="intel-label">Selected matchup</span><div className="intel-pair-faces"><Face slot={selected.mine} heroes={heroes} /><span>VS</span><Face slot={selected.theirs} heroes={heroes} /></div>
        <h3>{selected.mine.name}<span> vs {selected.theirs.name}</span></h3><strong className={`intel-pair-score ${tone(selected.advantage)}`}>{signed(selected.advantage)}<small> matchup points</small></strong>
        <p>{Math.abs(selected.advantage) < NOISE ? "Inside the noise floor. Neither hero has a clear statistical edge." : `${selected.advantage > 0 ? selected.mine.name : selected.theirs.name} has the favorable whole-game matchup.`}</p>
        <dl><div><dt>Match sample</dt><dd>{selected.matches.toLocaleString()}</dd></div><div><dt>Deployment</dt><dd>{selected.sameLane ? "Lane opponents" : "Across the map"}</dd></div><div><dt>Source disagreement</dt><dd>{selected.spread.toFixed(1)} points</dd></div></dl>
        <div className="intel-notice">{selected.spread >= NOISE ? "The two source readings differ. Treat the edge as approximate. " : ""}This measures game results, not duel odds or lane win probability.</div>
      </> : <div className="intel-empty">No measured matchups in this view. {laneOnly ? "Show all matchups or assign positions." : "Add heroes or refresh matchup data."}</div>}</aside>
    </div>
  </div>;
}

export function EvidenceStrip({ analysis: a, data }: { analysis: DraftAnalysis; data: Dataset }) {
  const dated = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "date unavailable";
  const timed = a.stages?.buckets ?? [];
  const timingRows = timed.reduce((sum, b) => sum + b.covered + b.theirCovered, 0);
  const timingPossible = (a.sides.mine + a.sides.enemy) * data.timingBuckets.length;
  const laneRows = a.lanes.filter((l) => l.key !== "map");
  return <details className="intel-evidence"><summary><span>Evidence & coverage</span><span>{a.coverage.matchups}/{a.coverage.matchupsPossible} matchups · {a.coverage.synergies}/{a.coverage.synergiesPossible} partnerships</span></summary><div className="intel-evidence-grid">
    <div><strong>Matchups · Dotabuff</strong><p>{a.coverage.matchups}/{a.coverage.matchupsPossible} usable pairings</p><small>Collected {dated(data.generatedAt)}</small></div>
    <div><strong>Partnerships · OpenDota</strong><p>{a.coverage.synergies}/{a.coverage.synergiesPossible} usable pairings</p><small>Collected {dated(data.synergyGeneratedAt)}</small></div>
    <div><strong>Game length · OpenDota</strong><p>{timingRows}/{timingPossible} hero-window records</p><small>Collected {dated(data.timingGeneratedAt)}</small></div>
    <div><strong>Laning · STRATZ</strong><p>{laneRows.reduce((s, l) => s + (l.outcome?.covered ?? 0), 0)}/{laneRows.reduce((s, l) => s + (l.outcome?.possible ?? l.possible), 0)} direct lane pairings</p><small>Collected {dated(data.lanesGeneratedAt)}</small></div>
  </div><p>Coverage describes available evidence, not prediction accuracy. Missing records are unknown. Insights use population trends; player skill, items, execution and live game state are not modeled. Matchup, synergy, lane and timing data cover all ranks.</p></details>;
}
