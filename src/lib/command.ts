import type { BanSide, DraftPick, Hero, Position, Slot } from "../types";
import { MAX_BANS, TEAM_SIZE, draftReducer, type DraftState } from "./draftState";
import { guessPosition, positionFit } from "./roles";
import { TYPO, topHit, type SearchIndexEntry } from "./search";

export type CommandVerb = "pick" | "ban" | "remove";

/** A seat as a command names it. "support" leaves 4 or 5 to the hero's own games. */
export type Seat = Position | "support";

export interface CommandAction {
  /** Null when the text names no action at all: "lina mid", "enemy lina". */
  verb: CommandVerb | null;
  /** The side the text names; null follows the armed slot. */
  team: BanSide | null;
  slug: string;
  seat: Seat | null;
}

export interface CommandRead {
  /** False for a plain hero search, which keeps its old Enter. */
  isCommand: boolean;
  actions: CommandAction[];
  /** Words that are neither a keyword nor a hero, as typed. */
  unknown: string[];
  /**
   * Heroes named in a clause with an unknown word and no action of its own. That
   * word may be the action misspelled ("bannned lina"), so the clause is not guessed at.
   */
  held: string[];
  /** What the grid filters on while this is typed: the hero being named. */
  searchText: string;
}

const TEAM_WORDS: Record<string, BanSide> = {
  i: "mine",
  "i'm": "mine",
  im: "mine",
  "i'll": "mine",
  "i've": "mine",
  me: "mine",
  my: "mine",
  mine: "mine",
  we: "mine",
  "we're": "mine",
  "we'll": "mine",
  "we've": "mine",
  us: "mine",
  our: "mine",
  ours: "mine",
  ally: "mine",
  allies: "mine",
  they: "enemy",
  "they're": "enemy",
  theyre: "enemy",
  "they'll": "enemy",
  "they've": "enemy",
  them: "enemy",
  their: "enemy",
  theirs: "enemy",
  enemy: "enemy",
  "enemy's": "enemy",
  enemies: "enemy",
  opponent: "enemy",
  opponents: "enemy",
  opp: "enemy",
  opps: "enemy",
};

const VERB_WORDS: Record<string, CommandVerb> = {
  pick: "pick",
  picks: "pick",
  picked: "pick",
  picking: "pick",
  take: "pick",
  takes: "pick",
  took: "pick",
  taking: "pick",
  taken: "pick",
  play: "pick",
  plays: "pick",
  played: "pick",
  playing: "pick",
  get: "pick",
  gets: "pick",
  got: "pick",
  choose: "pick",
  chose: "pick",
  lock: "pick",
  locks: "pick",
  locked: "pick",
  draft: "pick",
  drafted: "pick",
  went: "pick",
  have: "pick",
  has: "pick",
  ban: "ban",
  bans: "ban",
  banned: "ban",
  banning: "ban",
  remove: "remove",
  removed: "remove",
  delete: "remove",
  deleted: "remove",
  undo: "remove",
  unban: "remove",
  unbanned: "remove",
  unpick: "remove",
  unpicked: "remove",
  drop: "remove",
  dropped: "remove",
};

/** "we have to ban lina" is a ban: the stronger verb in a clause wins. */
const VERB_RANK: Record<CommandVerb, number> = { pick: 1, ban: 2, remove: 3 };

const SEAT_WORDS: Record<string, Seat> = {
  carry: 1,
  safe: 1,
  safelane: 1,
  safelaner: 1,
  mid: 2,
  middle: 2,
  midlane: 2,
  midlaner: 2,
  offlane: 3,
  offlaner: 3,
  roam: 4,
  roamer: 4,
  roaming: 4,
  support: "support",
  supp: "support",
  sup: "support",
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  pos1: 1,
  pos2: 2,
  pos3: 3,
  pos4: 4,
  pos5: 5,
  p1: 1,
  p2: 2,
  p3: 3,
  p4: 4,
  p5: 5,
};

const BREAK_WORDS = new Set([",", ";", ".", ":", "&", "+", "!", "?", "and", "then", "also", "plus", "but"]);

/** Words that carry no meaning here; trimmed off a hero name's ends but kept inside one. */
const FILLER_WORDS = new Set([
  "a",
  "an",
  "the",
  "hero",
  "team",
  "lane",
  "laner",
  "pos",
  "position",
  "is",
  "are",
  "was",
  "were",
  "be",
  "as",
  "at",
  "on",
  "in",
  "for",
  "to",
  "by",
  "with",
  "now",
  "just",
  "will",
  "would",
  "should",
  "gonna",
  "going",
  "let's",
  "lets",
  "please",
  "pls",
  "first",
  "ok",
  "okay",
  "so",
  "oops",
  "move",
  "moved",
  "put",
  "set",
]);

type Word =
  | { kind: "team"; team: BanSide }
  | { kind: "verb"; verb: CommandVerb }
  | { kind: "seat"; seat: Seat }
  | { kind: "break" }
  | { kind: "filler"; token: string }
  | { kind: "text"; token: string };

// Any script, so words in another language are reported as unknown rather than vanishing.
const TOKEN = /[\p{L}\p{N}_]+(?:['-][\p{L}\p{N}_]+)*|[,;.:&+!?]/gu;

function classify(tokens: string[]): Word[] {
  const words: Word[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    // "off-lane" and "pos-1" are keywords; a hero's own hyphen is kept in `token`.
    const key = token.replace(/-/g, "");
    const next = tokens[i + 1]?.replace(/-/g, "");
    if ((key === "pos" || key === "position") && next && /^[1-5]$/.test(next)) {
      words.push({ kind: "seat", seat: Number(next) as Position });
      i++;
    } else if ((key === "hard" || key === "soft") && next && SEAT_WORDS[next] === "support") {
      words.push({ kind: "seat", seat: key === "hard" ? 5 : 4 });
      i++;
    } else if (key === "hard" && next === "carry") {
      words.push({ kind: "seat", seat: 1 });
      i++;
    } else if (key === "off" && (next === "lane" || next === "laner")) {
      words.push({ kind: "seat", seat: 3 });
      i++;
    } else if (key === "i" && next === "am") {
      // "am" is Anti-Mage everywhere except straight after "I".
      words.push({ kind: "team", team: "mine" });
      i++;
    } else if (TEAM_WORDS[key]) {
      words.push({ kind: "team", team: TEAM_WORDS[key] });
    } else if (VERB_WORDS[key]) {
      words.push({ kind: "verb", verb: VERB_WORDS[key] });
    } else if (SEAT_WORDS[key] !== undefined) {
      words.push({ kind: "seat", seat: SEAT_WORDS[key] });
    } else if (BREAK_WORDS.has(key)) {
      words.push({ kind: "break" });
    } else if (FILLER_WORDS.has(key)) {
      words.push({ kind: "filler", token });
    } else {
      words.push({ kind: "text", token });
    }
  }
  return words;
}

interface Run {
  tokens: string[];
  fillers: boolean[];
  seat: Seat | null;
}

interface Clause {
  team: BanSide | null;
  verb: CommandVerb | null;
  runs: Run[];
}

function toClauses(words: Word[]): Clause[] {
  const clauses: Clause[] = [];
  let clause: Clause = { team: null, verb: null, runs: [] };
  let open: Run | null = null;
  let pendingSeat: Seat | null = null;

  const closeRun = () => {
    if (!open) return;
    let start = 0;
    let end = open.tokens.length;
    while (start < end && open.fillers[start]) start++;
    while (end > start && open.fillers[end - 1]) end--;
    if (end > start) {
      clause.runs.push({
        tokens: open.tokens.slice(start, end),
        fillers: open.fillers.slice(start, end),
        seat: pendingSeat,
      });
      pendingSeat = null;
    }
    open = null;
  };

  const startClause = () => {
    clauses.push(clause);
    clause = { team: null, verb: null, runs: [] };
    pendingSeat = null;
  };
  // A hero or an action still to come; a seat alone ("as our mid") belongs to the clause it ends.
  const moreFollows = (from: number) => {
    for (let next = from; next < words.length; next++) {
      const kind = words[next]!.kind;
      if (kind === "text" || kind === "verb") return true;
      if (kind === "break") return false;
    }
    return false;
  };

  for (let w = 0; w < words.length; w++) {
    const word = words[w]!;
    if (word.kind === "text" || word.kind === "filler") {
      open ??= { tokens: [], fillers: [], seat: null };
      open.tokens.push(word.token);
      open.fillers.push(word.kind === "filler");
      continue;
    }
    closeRun();
    if (word.kind === "break") {
      startClause();
    } else if (word.kind === "team") {
      // "they banned lina we picked pl": a side named after a finished clause begins the next,
      // unless no hero or action follows it, as in "ban lina for them".
      if (clause.verb && clause.runs.length && moreFollows(w + 1)) startClause();
      clause.team ??= word.team;
    } else if (word.kind === "verb") {
      if (!clause.verb || VERB_RANK[word.verb] > VERB_RANK[clause.verb]) clause.verb = word.verb;
    } else {
      // A seat belongs to the hero just named ("lina mid"), else to the next one ("mid lina").
      const last = clause.runs[clause.runs.length - 1];
      if (last && last.seat === null && pendingSeat === null) last.seat = word.seat;
      else pendingSeat = word.seat;
    }
  }
  closeRun();
  clauses.push(clause);
  return clauses;
}

interface Resolved {
  heroes: Hero[];
  /** Words in the run that name no hero, phrase by phrase. */
  unknown: string[];
  /** The text of the last hero or unknown phrase, which is what the grid shows. */
  lastText: string;
}

/**
 * Scores 0–5 run from an exact name down to a prefix of a nickname. A substring
 * (6–7) is left to the search box: in a sentence it turns everyday words into
 * heroes, "back" into Bristleback and "more" into Shadow Fiend.
 */
const named = (score: number) => score <= 5 || score === TYPO;
const namedInFull = (score: number) => score <= 1 || score === TYPO;

/**
 * The run as one name first, which may be partial ("shadow f" as it is typed),
 * then split longest-first: "lina pl am". Split, every hero must be named in full
 * or as a typo of a full name: "shadow" in "shadow lina" would be a guess, and a
 * stray word after a hero, "lina night", would turn into Night Stalker. A word
 * that names nobody is set aside, not allowed to sink the heroes around it.
 */
function resolveRun(index: SearchIndexEntry[], run: Run): Resolved {
  const whole = run.tokens.join(" ");
  const hit = topHit(index, whole);
  if (hit && named(hit.score)) return { heroes: [hit.hero], unknown: [], lastText: whole };

  const heroes: Hero[] = [];
  const unknown: string[] = [];
  let phrase: string[] = [];
  let lastText = "";
  const closePhrase = () => {
    while (phrase.length && FILLER_WORDS.has(phrase[phrase.length - 1]!)) phrase.pop();
    if (phrase.length) unknown.push(phrase.join(" "));
    phrase = [];
  };

  let i = 0;
  while (i < run.tokens.length) {
    if (run.fillers[i]) {
      if (phrase.length) phrase.push(run.tokens[i]!);
      i++;
      continue;
    }
    let end = run.tokens.length;
    for (; end > i; end--) {
      if (i === 0 && end === run.tokens.length) continue;
      const text = run.tokens.slice(i, end).join(" ");
      const part = topHit(index, text);
      if (part && namedInFull(part.score)) {
        closePhrase();
        heroes.push(part.hero);
        lastText = text;
        break;
      }
    }
    if (end > i) {
      i = end;
      continue;
    }
    phrase.push(run.tokens[i]!);
    lastText = phrase.join(" ");
    i++;
  }
  closePhrase();
  return { heroes, unknown, lastText };
}

export function readCommand(index: SearchIndexEntry[], raw: string): CommandRead {
  const tokens = raw.toLowerCase().replace(/’/g, "'").match(TOKEN) ?? [];
  const words = classify(tokens);
  const keywords = words.filter((w) => w.kind !== "text" && w.kind !== "filler").length;
  const clauses = toClauses(words);
  const lastClause = clauses[clauses.length - 1];
  const lastRun = lastClause?.runs[lastClause.runs.length - 1] ?? null;

  const actions: CommandAction[] = [];
  const unknown: string[] = [];
  const held: string[] = [];
  let runs = 0;
  let heroes = 0;
  let searchText = "";
  let team: BanSide | null = null;
  let verb: CommandVerb | null = null;
  for (const clause of clauses) {
    // Side and action carry forward: "they banned lina, pl and am". A seat belongs to
    // a pick, so "their mid is pl" after a ban is a pick rather than another ban.
    team = clause.team ?? team;
    verb = clause.verb ?? (clause.runs.some((run) => run.seat !== null) ? null : verb);
    const found: CommandAction[] = [];
    const unread: string[] = [];
    for (const run of clause.runs) {
      runs++;
      const resolved = resolveRun(index, run);
      if (run === lastRun) searchText = resolved.lastText;
      unread.push(...resolved.unknown);
      resolved.heroes.forEach((hero, i) => {
        const seat = i === resolved.heroes.length - 1 ? run.seat : null;
        found.push({ verb, team, slug: hero.slug, seat });
      });
    }
    heroes += found.length;
    unknown.push(...unread);
    // Only the clause's own action counts here: in "they banned lina, pickd am" the
    // unknown word may be a different action misspelled.
    if (clause.verb === null && unread.length) held.push(...found.map((a) => a.slug));
    else actions.push(...found);
  }

  // A lone keyword is still a search: "we" finds Weaver and "ban" finds Bane. A hero
  // beside a word nobody knows is a command gone wrong, and the line should say so.
  const isCommand =
    (keywords > 0 && runs > 0) || keywords > 1 || heroes > 1 || (heroes > 0 && unknown.length > 0);
  return {
    isCommand,
    actions: isCommand ? actions : [],
    unknown: isCommand ? unknown : [],
    held: isCommand ? held : [],
    searchText: isCommand ? searchText : raw,
  };
}

export interface CommandContext {
  /** The slot a click would fill, which is what a command naming nobody means. */
  armed: Slot;
  /** Whose ban a ban naming nobody is. */
  banSide: BanSide;
  heroOf: (slug: string) => Hero | undefined;
}

export type OutcomeTone = "mine" | "enemy" | "ban-mine" | "ban-enemy" | "removed";

export interface CommandOutcome {
  slug: string;
  text: string;
  /** Null when this part of the command changed nothing, and `text` says why. */
  tone: OutcomeTone | null;
}

export interface CommandPlan {
  next: DraftState;
  outcomes: CommandOutcome[];
  changed: boolean;
}

const whose = (side: BanSide, capital = false) =>
  side === "mine" ? (capital ? "Your" : "your") : capital ? "Their" : "their";

function seatFor(hero: Hero | undefined, team: DraftPick[], seat: Seat | null): Position | null {
  if (typeof seat === "number") return seat;
  if (seat === "support") {
    const taken = new Set(team.map((p) => p.position));
    const free = ([4, 5] as Position[]).filter((p) => !taken.has(p));
    return (free.length ? free : ([4, 5] as Position[])).reduce((best, p) =>
      positionFit(hero, p) > positionFit(hero, best) ? p : best,
    );
  }
  return guessPosition(hero, team);
}

/**
 * Plays the actions onto a copy of the board through the draft reducer itself.
 *
 * The reducer toggles a hero off when they are assigned to the slot they already
 * hold, so every "already there" case has to be caught here before it reaches it.
 */
export function planCommand(
  draft: DraftState,
  actions: CommandAction[],
  ctx: CommandContext,
): CommandPlan {
  let state = draft;
  const outcomes: CommandOutcome[] = [];

  for (const action of actions) {
    const { slug } = action;
    const name = ctx.heroOf(slug)?.name ?? slug;
    const say = (text: string, tone: OutcomeTone | null) => outcomes.push({ slug, text, tone });
    const onTeam: BanSide | null = state.mine.some((p) => p.slug === slug)
      ? "mine"
      : state.enemy.some((p) => p.slug === slug)
        ? "enemy"
        : null;
    const ban = state.banned.find((b) => b.slug === slug);

    let verb = action.verb;
    let team = action.team;
    if (verb === null) {
      if (team !== null) verb = "pick";
      else if (onTeam) {
        if (action.seat === null) {
          say(`${name} is already ${whose(onTeam)} pick`, null);
          continue;
        }
        verb = "pick";
        team = onTeam;
      } else if (ban) {
        say(`${name} is banned`, null);
        continue;
      } else verb = ctx.armed === "banned" && action.seat === null ? "ban" : "pick";
    }

    if (verb === "remove") {
      if (!onTeam && !ban) {
        say(`${name} is not on the board`, null);
        continue;
      }
      state = draftReducer(state, { type: "remove", slug });
      say(`Removed ${name}`, "removed");
      continue;
    }

    if (verb === "ban") {
      const side = team ?? ctx.banSide;
      if (ban?.by === side) {
        say(`${name} is already ${whose(side)} ban`, null);
        continue;
      }
      if (!ban && state.banned.length >= MAX_BANS) {
        say("The ban list is full", null);
        continue;
      }
      state = draftReducer(state, { type: "assign", slug, slot: "banned", by: side });
      const note = onTeam ? ` (taken off ${whose(onTeam)} team)` : "";
      say(
        ban ? `${name} is now ${whose(side)} ban` : `${whose(side, true)} ban: ${name}${note}`,
        side === "mine" ? "ban-mine" : "ban-enemy",
      );
      continue;
    }

    const side = team ?? (ctx.armed === "banned" ? "mine" : ctx.armed);
    const picks = state[side];
    if (onTeam === side) {
      const current = picks.find((p) => p.slug === slug)?.position ?? null;
      const others = picks.filter((p) => p.slug !== slug);
      const wanted = action.seat === null ? current : seatFor(ctx.heroOf(slug), others, action.seat);
      const stays =
        wanted === null || wanted === current || (action.seat === "support" && (current === 4 || current === 5));
      if (stays) {
        say(`${name} is already ${whose(side)} pick`, null);
        continue;
      }
      state = draftReducer(state, { type: "setPosition", slug, position: wanted });
      say(`${name} moved to pos ${wanted}`, side);
      continue;
    }
    if (picks.length >= TEAM_SIZE) {
      say(`${whose(side, true)} team is full`, null);
      continue;
    }
    const position = seatFor(ctx.heroOf(slug), picks, action.seat);
    // Seated through setPosition rather than assign, so a named seat is taken from whoever held it.
    state = draftReducer(state, { type: "assign", slug, slot: side, position: null });
    if (position !== null) state = draftReducer(state, { type: "setPosition", slug, position });
    const note = onTeam ? ` (moved from ${whose(onTeam)} team)` : ban ? " (was banned)" : "";
    say(`${whose(side, true)} pick: ${name}${position ? `, pos ${position}` : ""}${note}`, side);
  }

  return { next: state, outcomes, changed: state !== draft };
}
