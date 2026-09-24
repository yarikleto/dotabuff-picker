import { NOISE, formatSigned } from "./scoring";
import type { DraftAnalysis, LaneReport, LineupSlot, PairEdge, StageReport } from "./analysis";

export interface DraftInsight {
  id: string;
  kind: "roles" | "timing" | "lane" | "threat" | "opportunity" | "synergy";
  tone: "good" | "bad" | "neutral";
  label: string;
  title: string;
  action: string;
  evidence: string;
}

export interface ThreatProfile {
  hero: LineupSlot;
  victims: PairEdge[];
  answers: PairEdge[];
  covered: number;
  /** Mean pressure across ALL measured opponents, including unfavourable ones. */
  pressure: number;
}

export interface DraftBriefing {
  title: string;
  description: string;
  insights: DraftInsight[];
  threats: ThreatProfile[];
  firstWindow: StageReport | null;
  bestWindow: StageReport | null;
  timingComplete: boolean;
  pressuredLanes: LaneReport[];
  favorableLanes: LaneReport[];
  exposure: number | null;
}

export const allMatchups = (analysis: DraftAnalysis): PairEdge[] => analysis.lanes.flatMap((l) => l.pairs);
const signed = (n: number) => formatSigned(n, 1);

/** Points of win chance the seats must cost before the headline leads with them. */
const ROLES_HEADLINE = 5;
/** And before the playbook names them. */
const ROLES_INSIGHT = 2;

const names = (slots: LineupSlot[]) => slots.map((s) => s.name).join(" + ");

/** Plans are interpretations of measured trends, never invented ability or item advice. */
export function buildBriefing(a: DraftAnalysis): DraftBriefing {
  const pairs = allMatchups(a);
  const insights: DraftInsight[] = [];
  const buckets = a.stages?.buckets ?? [];
  const timingComplete = buckets.length > 0 && buckets.every((b) =>
    b.covered === a.sides.mine && b.theirCovered === a.sides.enemy && b.covered > 0 && b.theirCovered > 0,
  );
  // A missing side is unknown, not a zero-skew opponent. Only fully measured
  // windows earn strategic advice; the raw partial figures remain in deep dive.
  const firstWindow = timingComplete ? buckets.find((b) => b.edge >= NOISE) ?? null : null;
  const bestWindow = timingComplete
    ? [...buckets].filter((b) => b.edge >= NOISE).sort((x, y) => y.edge - x.edge)[0] ?? null : null;
  const exposure = timingComplete && firstWindow ? a.stages?.exposure ?? null : null;
  const realLanes = a.lanes.filter((l) => l.key !== "map" && l.contested);
  // Lane outcomes, rather than the whole-game blend, decide the opening plan.
  const readyLanes = a.lanesResolved ? realLanes.filter((l) => l.outcome) : [];
  const pressuredLanes = readyLanes.filter((l) => l.outcome!.result <= -3)
    .sort((x, y) => x.outcome!.result - y.outcome!.result);
  const favorableLanes = readyLanes.filter((l) => l.outcome!.result >= 3)
    .sort((x, y) => y.outcome!.result - x.outcome!.result);

  // The seats, from the same model as the headline: when they are the largest
  // cost on the board, no lane or timing plan is the first thing to say.
  const roles = a.win?.parts.find((p) => p.group === "roles") ?? null;
  const rolesLead =
    roles !== null &&
    roles.points <= -ROLES_HEADLINE &&
    (a.win?.parts.every((p) => p.points >= roles.points) ?? false);

  let title = "Find your edge. Make a plan.";
  let description = "Use the individual matchups to choose your fights; the draft score alone cannot tell you how to play.";
  if (rolesLead && roles) {
    const reason = a.win?.reasons.roles ?? "Your seats cost more than anything else on the board";
    title = "Fix the roles first.";
    description =
      `${reason}. That costs about ${Math.round(-roles.points)} points of win chance — ` +
      "more than anything else on the board.";
  } else if (!a.complete) {
    title = "The plan is still taking shape.";
    description = `${a.sides.mine} of your picks and ${a.sides.enemy} of theirs are in. These insights describe the heroes shown; remaining picks can change the plan.`;
  } else if (timingComplete && firstWindow) {
    if (buckets[0]!.edge <= -NOISE && buckets.indexOf(firstWindow) > 0) {
      title = "Survive the pressure. Play for your window.";
      description = `Your first favorable timing trend is ${firstWindow.label.toLowerCase()}; your strongest is ${bestWindow!.label.toLowerCase()}. Preserve options through the opening.`;
    } else if (buckets.at(-1)!.edge <= -NOISE) {
      title = "Build a lead. Make it count.";
      description = `Your timing trend is strongest ${bestWindow!.label.toLowerCase()}, but turns against you in longer games. Look to convert good fights into objectives.`;
    } else {
      title = "Set the pace around your best matchups.";
      description = `Your strongest timing trend is ${bestWindow!.label.toLowerCase()}. Use the lane and matchup reads below to choose where to apply pressure.`;
    }
  } else if (timingComplete && buckets.every((b) => b.edge <= -NOISE)) {
    title = "Create an opening. Waiting is not the plan.";
    description = "Their timing trend is stronger in every measured window. Look for favorable individual matchups and uneven fights to create an advantage.";
  } else if (pressuredLanes.length >= 2) {
    title = "Protect the opening. Keep your options.";
    description = `${pressuredLanes.length} lanes face statistical pressure. Plan support coverage and recovery space before committing to the lanes.`;
  }

  if (roles && roles.points <= -ROLES_INSIGHT && a.win) {
    const worst = [...a.win.roles.mine.seats].sort((x, y) => x.delta - y.delta)[0];
    // The seat rolesReason names, so the title agrees with the Roles reason
    // beside it: the rarest seat for its hero, else one that costs a lot even
    // for a hero who plays it often. A seat can be negative without either.
    const offRole = a.win.roles.mine.offRole[0] ?? (worst && worst.delta <= -3 ? worst : undefined);
    // The evidence names the title's hero, or the costliest seat under the generic title.
    const shown = offRole ?? worst;
    insights.push({
      id: "roles",
      kind: "roles",
      tone: "bad",
      label: "ROLES",
      title:
        offRole?.position
          ? `${offRole.name} is out of position at ${offRole.position}`
          : "Your seats are costing you",
      action: offRole
        ? "Open Rebalance for seatings they actually play. If nobody can move, expect that seat to lose more of its games and plan support around it."
        : "Some of your heroes win less in these seats than they do overall; the Roles card in Deep dive shows which.",
      evidence:
        (shown && shown.seatWinRate !== null && shown.winRate !== null
          ? `${shown.name} wins ${shown.seatWinRate.toFixed(1)}% at ${shown.position} against ${shown.winRate.toFixed(1)}% overall. `
          : "") + `The win-chance model prices your seats at ${signed(roles.points)} points.`,
    });
  }

  if (timingComplete && bestWindow && firstWindow) {
    const earlyBehind = buckets[0]!.edge <= -NOISE;
    insights.push({
      id: "timing", kind: "timing", tone: earlyBehind ? "neutral" : "good", label: "WIN CONDITION",
      title: `Aim for ${bestWindow.label.toLowerCase()}`,
      action: earlyBehind
        ? `Prioritize keeping your cores in the game until ${firstWindow.label.toLowerCase()}; then look to turn good fights into objectives.`
        : "Use your favorable window to build map control and take objectives when the game state allows it.",
      evidence: `${signed(bestWindow.edge)} timing-skew edge at your peak.` +
        (exposure !== null && exposure > 0 ? ` ${Math.round(exposure * 100)}% of sampled games end before your first favorable window.` : "") +
        " Duration trends are not live power-spike predictions.",
    });
  } else if (timingComplete && buckets.every((b) => b.edge <= -NOISE)) {
    insights.push({ id: "timing", kind: "timing", tone: "bad", label: "TIMING RISK",
      title: "Time alone does not solve this draft", action: "Look for a numbers advantage or your strongest individual matchup; do not rely on outscaling alone.",
      evidence: "Their relative timing skew is higher in every measured game-length window." });
  }

  const weak = pressuredLanes[0];
  if (weak) {
    const split = weak.score >= NOISE;
    insights.push({ id: `lane-${weak.key}`, kind: "lane", tone: "bad", label: split ? "HIDDEN TRADEOFF" : "PROTECT THIS LANE",
      title: split ? `${weak.label}: good outlook, tough opening` : `${weak.label} needs a recovery plan`,
      action: `Keep ${names(weak.mine)} from falling too far behind. Plan support attention and a fallback if the lane becomes unplayable.`,
      evidence: `${Math.round(50 + weak.outcome!.result)}% expected lane share for your side` +
        (split ? `, despite a ${signed(weak.score)} composite game outlook.` : ".") +
        (weak.outcome!.covered === 0 ? " Based on hero lane records; direct pairing results are unavailable." : ""),
    });
  }
  const strong = favorableLanes[0];
  if (strong) insights.push({ id: `lane-${strong.key}`, kind: "lane", tone: "good", label: "APPLY PRESSURE",
    title: `Start with your ${strong.label.toLowerCase()}`,
    action: `Let ${names(strong.mine)} establish the lane before using that space to help elsewhere.`,
    evidence: `${Math.round(50 + strong.outcome!.result)}% expected lane share. ` +
      (strong.outcome!.covered === 0 ? "Hero lane records only; direct pairing results are unavailable." : `${strong.outcome!.covered}/${strong.outcome!.possible} direct lane pairings measured.`),
  });

  const threats: ThreatProfile[] = a.lineups.enemy.map((hero) => {
    const own = pairs.filter((p) => p.theirs.slug === hero.slug);
    return { hero, covered: own.length,
      pressure: own.length ? -own.reduce((s, p) => s + p.advantage, 0) / own.length : 0,
      victims: own.filter((p) => p.advantage <= -NOISE).sort((x, y) => x.advantage - y.advantage),
      answers: own.filter((p) => p.advantage >= NOISE).sort((x, y) => y.advantage - x.advantage),
    };
  }).filter((t) => t.victims.length > 0)
    .sort((x, y) => y.victims.length - x.victims.length || y.pressure - x.pressure);
  const threat = threats[0];
  if (threat) {
    const answer = threat.answers[0];
    insights.push({ id: "threat", kind: "threat", tone: "bad", label: "ENEMY TO RESPECT",
      title: `${threat.hero.name} pressures ${threat.victims.length} of your ${a.sides.mine}`,
      action: answer ? `Consider ${answer.mine.name} as your statistical answer. Avoid letting ${threat.victims[0]!.mine.name} handle this matchup alone.`
        : `Plan team support for ${threat.victims[0]!.mine.name}; none of the measured matchups offers a clear individual answer.`,
      evidence: `${threat.victims.map((p) => `${p.mine.name} ${signed(p.advantage)}`).join(" · ")}. ${threat.covered}/${a.sides.mine} matchups measured; whole-game effects, not duel odds.`,
    });
  }

  // A broad threat and a single severe counter answer different questions.
  // Keep both when they name different enemies, rather than letting reach hide
  // the one matchup that can make a particular teammate's game difficult.
  const worstPair = [...pairs].sort((x, y) => x.advantage - y.advantage)[0];
  if (worstPair && worstPair.advantage <= -2 && worstPair.theirs.slug !== threat?.hero.slug) {
    insights.push({ id: "counter-trap", kind: "threat", tone: "bad", label: "DANGEROUS MATCHUP",
      title: `${worstPair.mine.name} must respect ${worstPair.theirs.name}`,
      action: `Plan backup for ${worstPair.mine.name} when ${worstPair.theirs.name} is involved. A balanced draft score can hide a very difficult individual matchup.`,
      evidence: `${signed(worstPair.advantage)} whole-game matchup edge for ${worstPair.mine.name}, over ${worstPair.matches.toLocaleString()} matches.` +
        (worstPair.spread >= NOISE ? ` Source readings differ by ${worstPair.spread.toFixed(1)} points.` : ""),
    });
  }

  const bestPair = [...pairs].sort((x, y) => y.advantage - x.advantage)[0];
  if (bestPair && bestPair.advantage >= NOISE) insights.push({ id: "opportunity", kind: "opportunity", tone: "good", label: "MATCHUP TO EXPLOIT",
    title: `${bestPair.mine.name} into ${bestPair.theirs.name}`,
    action: `Look for opportunities to involve ${bestPair.mine.name} when contesting ${bestPair.theirs.name}. Check items, levels and nearby heroes before committing.`,
    evidence: `${signed(bestPair.advantage)} whole-game matchup edge across ${bestPair.matches.toLocaleString()} matches.` +
      (bestPair.spread >= NOISE ? ` Source readings differ by ${bestPair.spread.toFixed(1)} points.` : ""),
  });
  const duo = a.mySynergyPairs.find((p) => p.synergy >= NOISE);
  if (duo) insights.push({ id: "synergy", kind: "synergy", tone: "good", label: "YOUR BEST PARTNERSHIP",
    title: `${duo.a.name} + ${duo.b.name}`,
    action: "Coordinate these two players’ plans; this is your strongest measured positive partnership.",
    evidence: `${signed(duo.synergy)} synergy beyond their individual baselines, over ${duo.matches.toLocaleString()} games together. This does not identify a specific spell combo.`,
  });

  return { title, description, insights, threats, firstWindow, bestWindow, timingComplete, pressuredLanes, favorableLanes, exposure };
}
