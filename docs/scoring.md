# How the ranking works

Dotabuff publishes, for every hero pair, an **advantage** figure: how many
percentage points a hero's win rate moves when that specific opponent is in the
game. It is already corrected for how strong each hero is overall, so it
isolates the matchup itself.

That figure is then **damped by its own sample size** before anything is done
with it, the same way the synergies are. A pairing seen 700 times and one seen
70,000 times both print to one decimal and look equally certain; they are not.
The spread of *real* matchup edges across the table is estimated by subtracting
the known sampling noise from the observed spread — it comes out at about 1.4
points — and each advantage keeps `signal / (signal + its own noise)` of what
was printed. On the live table that is 95% or more for a typical pairing and
about a third for the thinnest one. This is what lets the sample floor sit at
200 games rather than 500: thin evidence is now graded rather than either
trusted whole or thrown away.

The second half of a draft is your own line-up, which Dotabuff says nothing
about, so **synergies** come from OpenDota instead — see below.

- **Pick score** = lane-weighted average advantage against the enemy heroes
  drafted so far, plus `synergyWeight × average synergy with your own picks`,
  plus `metaWeight × (seat worth − 50)`, minus an **early-game
  penalty** if the line-up this hero would join has nobody who functions before
  the median game length.
- **Ban score** = the same ranking run from the enemy's seat: matchups against
  *your* heroes, synergy with *theirs*, and `+ 0.2 × pick rate` at the chosen
  rank folded into the meta term. Whatever tops the enemy's own wish-list is the
  hero to take away — and the pick-rate term keeps the list on heroes people
  actually take, since banning a strong hero nobody picks is a wasted ban.

The lane weighting is a weighted mean: an enemy you would share a lane with
counts `1 + laneWeight` (2× by default), everyone else counts once. Losing your
lane is a concrete problem in the first ten minutes; a bad matchup against their
pos 5 across the map is a slower one.

What a seat is worth to a hero is the hero's record *in that seat* — there is no
separate term for being stretched into one, because the win rate already carries
it. A seat's estimate is the hero's overall figure, plus what seats of that
share of a hero's games are measured to be worth across the whole table, plus
whatever this hero's own reading says beyond that, weighted by how well measured
it is. See [Where positions come from](#where-positions-come-from).

That measurement is the off-role effect itself: on the live table the seats a
hero is almost never put in run about 7.4 points below their own figure, and the
effect is flat above roughly a fifth of their games. So Crystal Maiden reads
39.5% at pos 1 and is nowhere near the safe-lane list. Flexing someone off-role
is a real drafting move, and the suggestion shows their position share so you
can see the stretch.

A seat that reads *above* the hero's own record is scored at less than face
value. STRATZ files positions partly by outcome — a mid Leshrac who ends the
game richest is booked as pos 1 — so a surplus carries some of the result it is
meant to predict. The **seat worth** the meta term uses is the seat's win rate
with any surplus over the hero's own record multiplied by
`seatBonus / heroes` from the [calibration](#win-chance), the share of a point
of seat bonus the fitted model finds is worth a point of hero strength: 0.23 in
the committed fit. A seat below the hero's record is charged in full. At
Divine+, Leshrac wins 61.7% of 2,397 pos 1 games against 51.9% overall; the
seat estimate keeps 60.3%, and the meta term scores it as 53.8% — level with
Spectre's 53.8% over 118,824 games rather than six points clear. The tile shows
the measured figure and the card shows both. Without `calibration.json` the
seat's win rate is scored as it stands.

Being the *usual* occupant of a seat earns nothing. Above about a fifth of a
hero's games the measured effect is flat, so a hero played somewhere 95% of the
time rather than 40% gets no credit for it — otherwise the pos 1 list would rank
carries by how stereotyped they are.

With an empty draft both lists fall back to meta strength, which is what you
want for a first-phase ban.

## Win chance

The Draft analysis headline is a chance of winning, and it is calibrated: a
model over a handful of draft features whose weights are fitted on real ranked
games and whose predictions are checked on games it was not fitted on. The
arithmetic is `src/lib/winModel.ts`; the fit is `npm run calibrate`, the last
data step of every refresh; its output is `public/data/calibration.json`.

It replaced a comparison signal — the lane-weighted mean matchup, plus the
synergy difference, plus the early-cover term — that could see neither roles
nor hero strength. The draft that retired it: Anti-Mage, Meepo, Sven,
Lifestealer and Arc Warden, five cores, against Leshrac, Lina, Enigma, Bounty
Hunter and Earthshaker. It read **−1.47, "Slight edge to them"**. Lifestealer at
4 wins 39.6% of his games there and Arc Warden at 5 45.3%, and nothing in the
headline knew. The calibrated model puts it at 16%, *You are being run over*,
with the seats the largest part of the deficit.

### The features

Every feature is mine minus theirs, so swapping the line-ups turns `p` into
`1 − p` exactly.

| Feature | What it adds up |
| --- | --- |
| Matchups | every cross pairing's damped Dotabuff advantage, pairs with ≥ 200 matches |
| Cohesion | each side's pair synergies with the core/support cells as booked, pairs with ≥ 200 games |
| Heroes | each hero's win rate − 50, at the rank band the calibration was fitted at |
| Seat penalty, seat bonus | each hero's `positionWinRate` at the booked seat minus their own win rate, split by sign |
| Role deficit | `min(0, S/5 + τ)²` per side, `S` the side's summed seat deltas |
| Timing | the early-cover shortfall, theirs minus mine |

The chance is `σ(Σ weight × feature)`. Sums, not means: a pairwise edge is a
marginal effect, and the combined effect of 25 of them is their sum. Fitted
freely, the weights on summed matchups and summed hero strength land near 0.046
and 0.054 per point, against the 0.04 an additive log-odds model predicts for
an even game. The mean was what made the old figure grow calmer as the board
filled.

The role deficit is the term that sees a line-up rather than five heroes. An
ordinary flex costs almost nothing — Snapfire mid moves the chance by a fraction
of a point — while a side whose heroes sit far from their seats loses steeply.
In the pilot's 389,352 games, teams whose summed position-4 and -5 shares came
to under a quarter of a hero won 36% (261 team-games), and teams whose seats
averaged four points or more below their heroes' own records won 25% (8 team-games). In the
pilot the convex
term brought those tail bins within noise; in the committed calibration its
weight fitted positive at every threshold and is pinned at zero, so the seat
penalty's linear weight (0.031 per point, about three times the bonus's 0.011)
carries the whole off-role cost — and the five-cores draft still reads 16%.
Each refresh re-fits it; the term is kept so a fit that finds a convex cost can
use it.

Seat bonuses are weighted apart from seat penalties because STRATZ files
positions partly by outcome: a Leshrac who ends the game richest is a pos 1
Leshrac, so rare seats' win rates carry some of the result. Fitted separately, a
point of bonus is worth about a third of a point of penalty in the committed fit
(0.011 against 0.031); in the pilot, bonuses from seats under 15% of a hero's
games were worth no less than the rest.

The Tuning sliders do not move the chance. The weights were fitted under fixed
sample floors (`WIN_MODEL_FLOORS`), and a probability computed under others
would no longer be the calibrated one. The sliders tune the pick list.

Nor does the rank band. The chance, and the seats the Roles card prints, are
always read at the band `calibration.json` records (`rankBand`, all ranks)
whatever band Tuning shows: a band's win rates are another sample with another
spread, and the five-cores draft's Heroes part reads +4.4 points at all ranks
but −6.3 at Immortal. The band goes on choosing the pick list's positions.

### The calibration

- **Games.** Ranked All Pick from OpenDota's `public_matches`, strictly older
  than both the synergy and the timing samples (their `matchIdRange`), so no
  weight is fitted on the games those figures were measured on. 300,000 by
  default.
- **Positions** for each line-up come from `scripts/assign.mjs`, as in the
  synergy collector.
- **Fit.** τ is chosen from 0.5 to 3 by two-fold held-out log-loss, folds by
  match id parity; the weights are then fitted on every game by logistic
  regression, with a Radiant term the app leaves out. A role-deficit weight that
  fits positive is pinned at zero.
- **Reliability.** Out of fold and read from both seats, in 5-point bins. The
  headline prints a figure only inside the span of bins holding at least 200
  team-games and says "under 15%" or "over 85%" beyond it, with the model's own
  figure beside.
- **Guardrails.** The step writes nothing when the sample is under 100,000
  games, when the held-out log-loss is not at least 0.005 below the Radiant term
  alone, when any bin of 1,000 or more team-games misses by more than 3 points,
  or when a weight that can only be positive is not.

At the time of writing, the committed calibration: 418,183 games, τ = 0.5 — a tie across the six
thresholds tried, since the deficit weight fits positive and is pinned at zero
whichever one is picked — held-out log-loss 0.6712 against 0.6914 for the
Radiant term alone, AUC 0.61, figures shown between 15% and 85%. Out of fold,
drafts near 23.2% won 22.0% of theirs (3,218 team-games), near 32.9% won 33.2%
(39,061), and near 42.6% won 42.6% (125,854).

The breakdown under the headline gives each group — roles, matchups, cohesion,
heroes, timing — its exact Shapley value in points of win chance, so the parts
add up to the headline minus 50 with nothing left over.

### What was tried and left out

Measured on the pilot, 389,352 games from 2026-09-22 scored against the data
committed at `318fd00`:

- **Doubling lane pairings.** A lane pairing is worth 1.06 of a pairing across
  the map (0.0475 against 0.0447 per point), not two.
- **The seat counters inside the matchup sum.** Read from one side only, they
  made the held-out fit worse (0.67237 against 0.67187).
- **The lane cards' readings.** Laning game edge 0.0017 ± 0.0028, form −0.0002 ±
  0.0018, duo −0.0060 ± 0.0035. The cards still print all three; they do not
  move the verdict.
- **A count of support bodies.** Once the seat terms are in, it adds nothing.

The pilot's held-out log-loss was 0.69145 with the Radiant term alone, 0.68656
for the old headline and 0.67188 for this model; AUC 0.557 against about 0.61.
Out of fold, drafts rated 18% won 19.8%, 23% won 23.8%, 28% won 27.6%, 33% won
32.9% and 38% won 37.8%: a recalibration slope of 0.997.

### What it does not know

Positions in calibration are inferred from each line-up, where the board books
them; the weights are fitted at all ranks and applied to whichever band is on
screen; the games are public pubs; and the model sees pairs and seats, not
trios. Each is a reason the figure is a chance rather than a certainty. The calibration games are only guaranteed older than the synergy and timing samples; hero win rates, seat records and matchups come from windows that may include them after a refresh, a small in-sample effect.

## Early game

Every term above judges a hero. None of them can see that the four heroes
already on the board have, between them, nothing that plays before the median
game — so the picker used to recommend the fifth scaling hero as happily as the
first, each pick defensible on its own and the five together a draft with no
first half.

A real case, and the reason this exists. Phantom Lancer, Ancient Apparition,
Arc Warden, Silencer and Axe into Bristleback, Lich, Enigma, Lion and Sniper.
Every pick came off the top of the suggestion list. The panel read **+0.6,
slight edge to you** — and the game-length card, right below it, said *before
25′ is theirs (−4.0)* and *45′ and up is yours (+1.8)* as though the two
cancelled. They do not, and two facts out of the timing table say why.

**Games do not end uniformly.** 2.1% finish before 25′, 24.2% between 25 and 35,
41.1% between 35 and 45, 32.6% after that. The card weighted all four windows
the same. Priced by how often games actually reach each one, that draft's
timing edge is **−0.01** — not the advantage the headline implied, and a full
point below the flat mean of the same four numbers.

**Scaling is nearly one-dimensional.** Across the pool a hero's skew in the
25–35 window correlates **−0.93** with their skew after 45 minutes. Stacking
heroes who are good late is not a neutral act with late-game upside; it is a
purchase, paid for in the windows where a quarter of games are decided.

The measure is a **count, not an average**, because the average is exactly what
hides the problem. Five heroes at −3 and one hero at −15 beside four at zero
have the same mean early skew and are not the same draft — the second can still
contest two lanes. So each hero is worth between 0 and 1 *bodies* of early
game, from their game-length-weighted skew over the windows that close before
the median game, saturating ±3 points either side of an average hero. A side
needs **two**. That figure is a judgement rather than a fit, and the one number
here worth disagreeing with: nothing in `public_matches` says how much early
game a draft needs, because that would take per-draft outcomes and the sample
per composition is one.

| | cover | penalty |
| --- | ---: | ---: |
| Phantom Lancer 0.00 · Ancient Apparition 0.14 · Arc Warden 0.09 · Silencer 0.05 · Axe 0.25 | **0.52** of 5 | −1.09 |
| Bristleback 0.34 · Lich 0.25 · Enigma 0.28 · Lion 0.00 · Sniper 1.00 | **1.87** of 5 | −0.01 |

Not one hero on the first side plays before 25 minutes. The penalty is
`earlyWeight × (shortfall / 2)²` — **convex**, so the first scaling hero is free
and the second nearly so (they are supposed to be there; a linear penalty would
talk you out of the one carry every draft needs) and the third, fourth and
fifth cost 2.25, 4 and 6.25 times what the second did. That is the shape the
problem actually has: nobody loses for owning a Medusa, they lose for owning a
Medusa and four heroes who cannot buy her the twenty minutes.

Applied to that draft it comes to **−1.08**, and the headline goes from +0.6 to
**−0.48**. The panel now also prints the figure a captain can act on directly:
**26% of games are over before you are ahead.**

Mid-draft the term is charged against the *projected* five, with undrafted slots
valued at the pool average — so an empty board costs nothing, candidates still
separate by their own cover from the first pick, and the cost arrives gradually
as the hole is actually dug. A hero the timing collector never saw is treated as
*unknown*, not average: they neither create nor fill a hole. Set **early weight**
to 0 and the ranking is exactly what it was before.

Two caveats, both real. The skew in a window is measured *conditional on games
ending there* — it is a scaling signal, not a stopwatch reading at minute ten —
and the duration weights are the population's, not this draft's, when a side
that dominates early is itself part of why games end early. Correcting the
second would need per-draft durations, which the table does not carry. The bias
it leaves runs against late-heavy drafts being flattered, which is the safe
direction for a figure whose whole job is to warn about them.

**What the calibration says.** The win-chance model carries the early-cover
shortfall as a feature and fits its weight like any other. In the pilot it came
out indistinguishable from zero (0.015 ± 0.026) — in 389,352 real games a
missing first half did not predict losses — and the draft above, Phantom
Lancer, Ancient Apparition, Arc Warden, Silencer and Axe, read about 72%. In the
committed calibration the term carries a real weight, 0.116 ± 0.035 per unit of
shortfall, and that draft still reads about 72% under it: its 25 matchups add
up to a lot. The penalty stays in the pick score, where it orders candidates,
and every calibration re-measures its weight in the verdict.

Each pairing is read from both heroes' pages and averaged, which cancels most of
the rounding noise. Matchups with fewer games than the **Min. sample** slider
(500 by default) are ignored.

Open **Tuning** in the header to change the weights:

- **Meta weight** — 0 is pure counter-picking; higher values favour heroes that
  are strong regardless of the matchup.
- **Synergy weight** — how much your own line-up counts next to countering
  theirs. At 1 a point of synergy is worth a point of matchup advantage; 0 goes
  back to counter-picking alone.
- **Lane weight** — 0 treats the whole enemy team equally; 1 counts your lane
  opponents double.
- **Early weight** — what a line-up is charged for having nobody who works
  before the median game length. Convex, so the first two scaling heroes are
  free and only a genuinely stacked draft pays; 0 turns it off entirely and
  restores the old ranking.
- **Role threshold** — how much of a specialist a hero must be to be offered for
  a position. Raise it to see only dedicated heroes.
- **Min. sample** — raise it if you only trust heavily-played pairings. Thin
  pairings are already damped towards zero by sample size, so this is a hard
  cut-off on top of that rather than the only defence.
- **Min. synergy sample** — the same floor for pairings, on top of the
  shrinkage.
- **Min. win rate** — drops weak heroes out of the suggestions entirely.

## Synergies

Dotabuff publishes counters for free but not synergies, so these come from
OpenDota's `public_matches` table — one row per ranked game with both hero
line-ups — aggregated through their open SQL endpoint. `npm run synergy` walks
backwards through it and writes `public/data/synergies.json`. Counters still
come from Dotabuff, where the samples are an order of magnitude larger.

The raw number — "win rate of A and B together" — is close to useless. Two 55%
heroes win about 59% of games side by side simply because they are both good,
and a pairing seen 40 times can read +8 points from noise alone. Two corrections
turn it into something you can draft on:

1. **Subtract what the pair was expected to do.** Hero strength adds up on the
   log-odds scale, so the expectation for A+B is `logit(p_a) + logit(p_b)`, and
   synergy is whatever the pair beat that by. What is left is chemistry rather
   than quality.
2. **Shrink the residual towards zero by how noisy it is.** The strength is not
   a constant to guess at: the spread of *real* synergy across all pairings is
   estimated from the data itself, by subtracting the known sampling noise from
   the observed spread. A pairing seen 5,000 times keeps nearly everything it
   measured; one seen 60 times keeps almost nothing. Collect more matches and
   everything shrinks less, automatically.

The result is reported in percentage points at a 50% baseline, so `+2` means
"about two extra win-rate points beyond what these two are worth apart" — the
same units as the matchup advantages, which is what lets the two be added.

### Synergy by role

A pairing's headline figure averages over every way the two heroes were actually
played, and that average is mixed far more than it looks. Across the live table
the median pairing blends **3.45** different position arrangements, only 0.3% of
pairs are as much as 90% one arrangement, and just 28 of 127 heroes are pinned to
a single position. Windranger + Tiny is the extreme: its most common arrangement,
pos 3 with pos 4, accounts for 11% of their games together.

So the table is cut by whether each hero *farmed*: `cc`, `cs`, `sc`, `ss`. Ask
for a pairing with both positions known and you get the cell; ask without, or
ask for a pairing with nothing position-specific to say, and you get the blended
figure exactly as before.

Positions are not in `public_matches`, and cannot be bought — the parsed rows
that carry `lane_role` cover roughly **80 player rows per million match ids**
against about 330,000 matches in the same range, so that route is closed. They
are inferred from the line-up instead. A team is not five independent heroes:
exactly one of them plays each position, and that constraint carries most of the
information. On its own Windranger's history says pos 2 / 4 / 5; standing next to
a locked-mid Invoker and a locked-pos-5 Lich, she is the pos 4. `scripts/assign.mjs`
scores all 120 ways to hand out the five positions and takes the likeliest, using
each hero's position shares as its only prior — STRATZ's counts for the rank band
matching `--min-rank`, or the Dotabuff reconstruction when `positions.json` is
missing ([Where positions come from](#where-positions-come-from)). The source is
written into `synergies.json` as `positionsFrom`.

Cells are shrunk the same way pairings are, but towards the pairing's own number
rather than towards zero — a cell starts by agreeing with its pair and is only
moved by what its own games show. Cells that end up agreeing anyway are left out
of the file entirely, so `synergies.json` only carries the splits that say
something.

The noise a cell is judged against is `var(cell) − var(pair)`, not `var(cell)`.
A cell's games are a *subset* of its pair's, so the two readings share every
game the cell has and their errors move together; charging the cell the full
variance overstated its noise roughly threefold for the cells with the most
data, and that inflated figure then deflated the estimated signal, shrinking
every cell a second time. Against a simulation with known planted splits, the
correction lifts recovery of a noise-free ±3pp split from 31% to 65%.

**Ambiguous line-ups are used anyway, and this was measured rather than
assumed.** Five flexible heroes produce a "most likely" arrangement that is
barely likelier than the next one, and filing that guess into a cell is plainly
impure — so an earlier version refused those line-ups, counting them in the pair
totals and leaving them out of the cells. It made the output worse: rejecting
46% of line-ups turned an 11% error improvement over having no cells at all into
a 7% regression, because the surviving cells were too thin for the write
threshold to select on anything but noise, and what did get written came out
overstated by half again. A wrong guess dilutes symmetrically and pulls a cell
towards the blend, which is the safe direction; starvation does not. The run now
*reports* what share of line-ups were near coin flips instead of dropping them.

This is why `npm run synergy` now fetches line-ups rather than pre-aggregated
pairs. The traffic is close to what it was: the old query returned about 8,000
rows per window whatever its width, and two team rows per match works out within
about 25% of that over a full run. A saved run from before this change cannot be
resumed and will restart on its own — as will a run saved *without* position
priors, since its cells would be short of the games its pairs claim and every
deviation measured against them would be biased, and a run saved under a
different position source, whose cells were assigned from different shares.

One known bias is left in: each hero's own win rate includes the games where
their partner was on the team, so the heroes quietly absorb about 6% of every
pairing's effect before it is subtracted. Removing it means solving all 8,000
pairs jointly for a correction far smaller than the sampling noise, so the
numbers simply run ~6% conservative.

```bash
npm run synergy                     # ~300k ranked matches, resumes if interrupted
npm run synergy -- --matches=800000 # bigger sample, tighter numbers
npm run synergy -- --probe          # one window, print what came back, stop
npm run synergy -- --min-rank=70    # Divine+ only (avg_rank_tier)
npm run synergy -- --fresh          # ignore saved progress
```

The endpoint has a statement timeout, so the collector walks `match_id` in
windows and lets the window size find its own level — too slow and it halves,
comfortably fast and it doubles. Progress is saved after every window, so an
interrupted or rate-limited run picks up where it stopped — within a day of
stopping. A run that finished is never continued: the next one collects fresh
matches, so a refresh always means newer data. If you hit the rate
limit often, a free key from <https://www.opendota.com/api-keys> raises it:
`OPENDOTA_API_KEY=... npm run synergy`.

The app works without the file — it just falls back to pure counter-picking, and
the header says `no synergy data`.

## Game length

Counters say who beats whom and synergies say who belongs together. Neither says
*when* a line-up is meant to win, which is the thing a captain actually has to
tell four other people. `npm run timings` fills that in from the same OpenDota
table the synergies come from — `public_matches` carries a duration on every row
— and writes `public/data/timings.json`.

What is stored is not the win rate in a bucket but the **skew**: how far the
hero's win rate in that window sits from their *own* overall win rate. A hero
who wins 54% everywhere is not a late-game hero; a hero who wins 46% before
twenty-five minutes and 53% after forty-five is, and only the difference from
their own baseline shows it. Thin buckets are shrunk towards zero the same way
synergies are — forty games at 100% is arithmetic, not a read.

Four windows, wide enough to say out loud: before 25′, 25–35′, 35–45′, 45′ and
up. The panel averages each side's five and reports the difference, so
"your window is before 25′ (+1.4 on them); 45′ and up is theirs (−2.1)" is a
statement about shape rather than about which team is better.

```bash
npm run timings                     # ~300k ranked matches, resumes if interrupted
npm run timings -- --probe          # one window, print what came back, stop
npm run timings -- --matches=800000 # bigger sample, tighter numbers
npm run timings -- --min-rank=70    # Divine+ only (avg_rank_tier)
```

Same windowing, resume and rate-limit behaviour as the synergy collector. The
app works without the file; the game-length card says so and everything else
carries on.

## Lane outcomes

The lane card's **laning** row reads the laning stage itself. `npm run lanes`
collects STRATZ's lane outcomes: for every hero at every seat, how often they
won, drew and lost the lane against each opponent standing in it, over the last
four complete weeks at every rank (`public/data/lanes.json`). A pairing's lane
score is its share of the laning stage,

```
laneScore = (wins + draws / 2) / (wins + draws + losses)
```

— about 14% of the lanes STRATZ counts are none of the three, and it does not
say what they are, so they are left out of the denominator.

**Expectation.** Each hero has a record at their seat, pooled over every
opponent. Those records already carry their seat's typical result — offlaners
as a group lose more lanes than they win — so subtracting one from the other
counts the seat twice; measured that way the average pairing missed by three
points in opposite directions at pos 1 and pos 3. Each hero is instead taken
relative to their seat's baseline `L`, and the two seats meet halfway:

```
logit(expected) = logit(record_a) − logit(record_b) − (L_seatA − L_seatB) / 2
```

which reads the same from either side of the pairing, and leaves every seat's
mean residual within 0.7 points of zero.

**The pairing's own effect** is what the pair did beyond that, read from both
directions of the table and weighted by their lanes. The two directions share
most of their games, so together they are credited with the precision of the
better one alone. The effect is then shrunk exactly as synergies are: the spread
of *real* pairing effects at each seat is the observed spread minus the known
sampling noise, and each pairing keeps `signal / (signal + its own noise)` of
its deviation. Real spreads on the live table, in lane points: 2.5 at pos 1,
6.5 at mid, 2.7 at pos 3, 2.2 at pos 4, 1.9 at pos 5 — the mid 1v1 is by far the
most matchup-specific lane. One bias is left in, as with synergies: each hero's
record includes the pairing being measured, so it absorbs about one opponent's
share of it — 1–2% against a real pool.

**What reaches the score.** Two measurements decide this.

- Across heroes, a hero's lane record barely relates to how they do in games:
  against the Dotabuff lane win rate the card calls *form*, the correlation is
  0.00 in the safe lane, 0.08 mid and 0.17 offlane. Winning lanes is a style,
  not a result — the heroes who dominate the laning stage do not win more games
  for it.
- The part specific to a pairing does carry into games. A pairing that lanes one
  point better than the two records predict wins 0.46 points more of its games
  at pos 1, 0.30 mid, 0.47 at pos 3, 0.34 at pos 4 and 0.35 at pos 5 — the slope
  of game residual on lane residual, correlations between 0.43 and 0.71. The same
  regression without the expectations is flat at pos 1.

So the **laning** row shows the whole predicted result — who takes the laning
stage — while the score takes only the pairing effect in game points,
`gameEdge = gamePerLane × residual`, averaged over the cross pairings that have
lanes of their own on record. Each pairing uses the mean of its two seats'
figures — spread, centre and `gamePerLane` — so it reads as the exact mirror
from the other side. A pairing with none has an expected result
and nothing else; its zero is not evidence and is not averaged in.

Dragon Knight against Invoker in mid is the worked case: 12,226 lanes at 71.9%.
Their records, 56.4% and 42.6%, predict about 63.5%; the other eight and a half
points are this pairing, and at 0.30 they are worth +2.5 in games.

The lane card blends that at the same weight as form (`LANE_WEIGHTS`: laning 1,
form 1, duo 0.5, matchup 0.5), scaled by the share of cross pairings on record.
A lane at 53–47 or wider gets a note naming who takes it and the widest pairing;
a lost lane at 55–45 or wider makes the talking points as one to survive rather
than win.

What the rows cannot say: the opponent's seat is not recorded, so the fit
assumes each opponent held whichever facing seat they play most; STRATZ offers
no game-mode filter here, so Turbo lanes are in; and the 2v2 is read as four
1v1 pairings averaged, not as a unit.

## Counters by seat

The same file answers a second question, and it is the only position-specific
matchup number in the app. Each row carries `gameWins` — the games the row's
hero went on to win out of those lanes — so the table says what happened to a
hero who stood in *this* seat against *this* opponent, rather than to that hero
across every seat they play. Dotabuff's advantage cannot say it: it is measured
over games where two heroes were in the match on opposite sides, whoever they
were and wherever they stood.

Four things move a row's game win rate and only one of them is news:

| in the row | who already owns it |
| --- | --- |
| the hero's own record at that seat | the meta term, via `positionWinRate` |
| the opponent's strength | a fact about them, in every draft they are in |
| the whole-game matchup | `matchup()`, from Dotabuff |
| **the pairing at this seat** | nothing, until now |

`fitLaneCounters` fits the first two as fixed effects — one level per (hero,
seat), one per opponent — and the third as a slope on the damped advantage the
score already adds, by alternating least squares weighted by lanes. Twelve
rounds is the whole of the fit; by round ten no cell moves by another 0.0002
points.

What is left is published against a slope of **one** rather than the fitted
slope, so that `advantage + edge` is exactly the fit's prediction rather than a
sum of two models. The fitted slope is **1.159**: a point of whole-game matchup
edge is worth about a sixth more when the two heroes stand in the same lane,
and that sixth rides along in the published number.

Each reading is then damped like everything else — `signal / (signal + its own
noise)`, against a spread of real pairing effects measured the same way the
synergies and the lane residuals are.

**On the live table.** 32,937 pairings, one per unordered pair and seat; the
spread of real seat-specific effects is **1.01 points of win rate**, which is
the same order as the whole matchup table's 1.4. It is quiet on most pairings —
8.5% of readings reach a point after damping, 1.2% reach two — and loud on a
few: Pudge at pos 1 against Axe is +2.7 over 3,948 lanes, Viper at mid against
Huskar +3.1, Slark at mid against Earth Spirit +2.7.

**It replicates.** Fitted separately on the first two weeks of the window and
the last two, the same pairing's reading correlates at r = 0.52 over pairs with
1,000 lanes in each half, and 0.60 over pairs with 3,000. The slopes come out
1.151 and 1.169. This is the test that
[rejected band-specific matchups](#why-matchups-and-synergies-stay-all-ranks),
where the same correlation was 0.07.

**Where it enters.** Inside the pairing, not beside it: `pairEdge` adds the
reading to that opponent's advantage, and the lane weight then doubles the pair
as it always did. One lane pairing has no business swinging a score five times
harder than the other four matchups together, which is what a term of its own
would do.

`pairEdge` is the single place that sum is written, and the suggestion list,
the board headline (`draftBalance`) and the [Rebalance](ui.md#rebalancing-your-five)
search all read it. The hero card prints a candidate's score and what the board
becomes if you take them two inches apart, and a second copy of this arithmetic
would be two numbers disagreeing about the same pairing in the same panel.
Rebalance gains something more than consistency from it: moving a hero to
another seat now moves what the table says they do to the enemy in that lane,
which is the whole question that panel asks.

The lane card's **matchups** and **duo** rows stay the whole-game figures they
have always been. That card already reads the lane itself in its **laning**
row, from the same file by a different route, and adding the seat reading to
the row beside it would count one measurement twice in one blend.

**What the number contains beyond the pairing.** Three things, and all three
are in it deliberately or unavoidably:

- **The opponent's seat is not recorded.** A row for Phantom Assassin at pos 1
  against Lifestealer is 7,828 lanes in which Lifestealer was an offlaner,
  because that is who stands there — so the reading prices "their carry is in
  the wrong lane" along with the pairing. The app otherwise has no figure for
  an off-role opponent at all; the [off-role note](#what-it-does-not-model)
  says one is happening and prices nothing.
- **Counter-picks as drafted.** These lanes were chosen by people counter-picking,
  so part of an edge belongs to the player who knew to take it and not to the
  hero. Splitting the window in half cannot see this — the same players do the
  same thing in both halves — and nothing in the data can.
- **It is read from one side only.** `laneCounter` reads the candidate's own
  row and never averages in the mirror. The mirror is the same games, but it is
  conditioned on the *other* hero's seat and pools every seat the candidate
  played: Axe at 3 against Pudge is 62,550 lanes of mostly pos 5 Pudge, and
  averaging it in turns a +4.4 reading of a pos 1 Pudge into +1.5 of somebody
  else's game. So the two sides of one lane need not be exact opposites. The
  ban list reads the enemy's row, which is the correctly conditioned figure for
  the question it asks.

### Off-role answers

`minRoleFit` throws out every hero who plays a seat in less than 5% of their
games, and the pick list is better for it. But that floor is a statement about
how heroes are *usually* deployed, and an off-meta counter-pick is by definition
not usual: Pudge is a pos 1 in 1.8% of his games, and in the 3,948 lanes where
he was one against an Axe he won 55.7% of those games.

`offRolePicks` is the short list of what the floor is hiding. It re-runs the
ranking with the floor lifted and keeps heroes who are *below* it, whose
seat-specific reading against a hero already on the board clears the app's 0.5
noise floor, and who still score positively once their record in that seat has
been counted — which for a seat this thin is several points below their own
figure. Most boards produce nothing,
which is the point. Pick mode only: a hero nobody picks in a seat is not a hero
to spend a ban on.

## Scoring an arrangement

The [Rebalance](ui.md#rebalancing-your-five) search ranks whole line-ups rather
than candidates, so it needs a figure for "what is this board worth arranged
*this* way". With a calibration it is the win chance of the board so arranged:
the same `winRead` the headline uses. Seat penalties, seat bonuses and the role
deficit are inside it, so where a hero sits is priced by the model that was
fitted on how seats actually go.

Nothing lane-shaped is in the model — the lane readings measured nothing on real
games — so a lane swap leaves the chance where it was. The panel still reads
every lane: an arrangement that takes a losing lane out of the fire while
costing less than a point of win chance is offered for that lane, and every
option prints the lane shifts under it.

An arrangement is offered on its figure when it adds at least one point of win
chance (`CHANCE_GAIN`); one that puts a stranded hero back on a seat they play
may cost up to five (`MAX_SEAT_CHANCE_COST`). That is a ceiling, not a price:
the model charges for a bad seat, so freeing a hero usually adds chance, and
five sits just under what it charges for a hero in the thinnest seats (7.4 points
below their own figure, about five and three-quarter points of win chance on an
even board) and above every repair the panel showed across 900 scrambled boards.
Gains print as points of win chance with the parts that moved.

Without `calibration.json` the search keeps the objective it had before: the
comparison signal, plus the lane cards' laning, form and duo readings averaged
over the contested lanes, plus each hero's seat record at the meta weight, with
the half-point noise floor as its threshold and two points (`MAX_SEAT_COST`) as
the most a seat repair may cost.

## Where positions come from

Positions are counted. `npm run positions` asks STRATZ how many ranked All Pick
games each hero played in each position over the last four complete weeks, and
how many of those they won, for three rank bands: every rank, Divine and
Immortal, and Immortal alone (`public/data/positions.json`). A hero's share of a
position is that count over their total. Their win rate there is built from
three things:

```
positionWinRate = overall + mean(share) + (raw − overall − mean(share)) × k
                                     k = spread(share) / (spread(share) + noise)
```

`mean(share)` and `spread(share)` are measured across the whole table, in share
bands: the average gap between a seat's win rate and its hero's own figure, and
how much that gap really varies once binomial sampling noise is subtracted from
the observed variation. On the live all-ranks table the mean runs from −7.4
points in the thinnest band to +0.4 above 45%, and it is flat from about a fifth
of a hero's games upward. `noise` is the seat's own binomial variance, so `k` is
the same `signal / (signal + noise)` factor an advantage is damped by.

How *rare* a seat is sets where the estimate is pulled towards; how *well
measured* it is sets how far. Those are different questions, and a single
share-weighted prior answers neither: Necrophos's pos 1 is 207,113 games known
to a tenth of a point and is only 10% of his games, while a 31-game Immortal
cell can be a larger share of a rarely-played hero. The prior is always read
from the all-ranks band, whose cells never fall below a few hundred games, and
applied to whichever band is on screen — Divine and Immortal cells run down to a
dozen games, where the noise term would swamp the measurement itself.

A position counts as one they play (`topPositions`) from 12% of their games,
which is the threshold the reconstruction below uses too. The shrinkage is not
shared with it: the reconstruction reads one win rate per *lane* and hands it to
both the core and the support standing there, so a thin seat's figure describes
somebody else and shrinking it by share is the right correction. These counts
are per position already.

The rank switch in the top bar picks the band. It moves positions, position win
rates, the overall win rate the meta term reads and the pick rate the ban score
reads. The choice is not cosmetic. Over the same four weeks Dragon Knight mids
in 32% of his games at all ranks, 49% at Divine and above and 53% at Immortal —
and the band decides both how ordinary a mid he is and what his record there is
measured against.

Pick rate is a hero's share of the band's matches, ten heroes to a match. At all
ranks it tracks Dotabuff's own figure (r = 0.991); higher up it is a different
list — Sniper is in 19% of matches at all ranks and 7% at Immortal, Bounty
Hunter in 9% and 17%. Ban rate, which only the hero card shows, is Dotabuff's
across every rank.

### Why matchups and synergies stay all ranks

Matchups and synergies are all-rank figures whichever band is chosen, because
at the sample sizes on offer the all-rank figure is the better estimate of a
pairing at any rank. Measured on STRATZ's `matchUp` for the same four weeks, all
ranks against Divine and Immortal, with each band's own hero win rates taken out
so that only the pairing itself is compared (points of win rate, standard
deviations across pairs):

| | Spread of the pair effect | True all-rank → Divine+ shift | Sampling noise at Divine+ |
| --- | --- | --- | --- |
| Matchups | 1.45 | 0.49 | 1.38 |
| Synergies | 1.06 | 0.59 | 1.59 |

The shift is real but small next to what four weeks of Divine+ games can
resolve: a raw Divine+ table would add 1.38 points of noise to find 0.49 points
of signal, and shrunk by its own noise the shift moves 16 of 15,884 matchups by
more than a point and none by two. The two halves of the month agree on it at r = 0.07, and
at 0.24 among pairs with 3,000 Divine+ games in each half. STRATZ offers these
tables no finer than Divine and Immortal together, so there is no Immortal table
to read in any case.

Lane outcomes and timings are all-rank figures too. They have not been measured
by band.

Counting replaced a reconstruction that was wrong often enough to matter.
Against STRATZ's counts it misfiled 14.3% of the average hero's games; 71 of
127 heroes were off by 10% or more and 29 by 20% or more. Bounty Hunter was the
worst: Jinada and Track make a support's gold look like a core's, so the GPM
split below filed a hero who is a pos 4 in 75% of his games as a pos 3.

### Without positions.json

The picker falls back to reconstructing positions, and so does any hero the
file does not cover. Dotabuff's own position filter is a Plus feature, but
`/heroes/lanes` is free and carries enough to reconstruct positions. It gives, per lane, how often each
hero stands there and what they farm while doing it:

- the **lane** says where the hero is — mid, safe, off, jungle, roaming;
- the **GPM** says whether they are the core or the support standing there.

A pos 1 and a pos 5 both live in the safe lane, but their gold per minute does
not overlap. So for each lane the scraper splits the GPM distribution in two
(Otsu's method — the cut that minimises variance within each half) and reads
lane + side of the cut as a position: safe lane splits into 1 and 5, the offlane
into 3 and 4, mid is 2, roaming is a support. Heroes near the cut count
partially for both, so flex heroes keep both positions instead of being forced
one way. The threshold is learned from each patch's own data rather than
hard-coded, so it does not go stale.

Check the result with `npm run scrape -- --dump-roles`; the normal run also
prints a sanity line for a few heroes nobody argues about.

## What it does *not* model

**Lanes, as lanes.** This is the one worth knowing before trusting the lane
card. Dotabuff's advantage figure is measured over games where the two heroes
were *in the match* on opposite sides, not over games where they stood in the
same lane; synergy is measured over games where two heroes were on the same
team, whoever they happened to face. So the **matchups** and **duo** rows are
four independent whole-game matchup numbers and two whole-game pairing numbers,
arranged by lane — not a measurement of that lane. Grouping by position decides
which numbers are put in front of you and how much weight they get; it does not
make any of them lane-specific.

The suggestion list is the exception, and only where the lane table has a row:
a candidate facing an enemy in their own lane is scored on the advantage *plus*
what that seat did against that opponent — see [Counters by seat](#counters-by-seat).
The lane card's matchup and duo rows are still the whole-game figures described
above.

The **form** row is taken from a lane, but not from the laning stage: Dotabuff's
`/heroes/lanes` publishes a win rate per lane, so "the heroes in your safe lane
win 48.4% of their games from it" is a measurement of *games* played from that
lane. It says nothing about who they face, and — measured against STRATZ's lane
outcomes — next to nothing about whether they win the lane itself. The laning
stage is the **laning** row's job ([Lane outcomes](#lane-outcomes)); form stays
in the blend as what these heroes' games from this lane are worth.

The panel no longer leaves you to notice that yourself. `formEdge` is your side's
lane record minus theirs, and when it disagrees with the lane's matchup figure by
more than the noise floor the card prints the disagreement and the talking points
lead with it. A worked case, from a real game that this picker called a coin flip
and its author lost:

| Safe lane pairing | figure |
| --- | ---: |
| Shadow Fiend vs Bristleback — the actual lane fight | −0.45 |
| Shadow Fiend vs Lich | −0.24 |
| Dark Willow vs Bristleback | −0.42 |
| **Dark Willow vs Lich** — support against support | **+1.46** |
| mean → the lane's headline figure | **+0.09** |

Three pairings of four are negative and the sign is set by the one pair who
decide nothing in a lane; meanwhile `form` had that lane at ours −1.1 against
theirs +0.9. The mean is not wrong, it is just not an answer to "who wins this
lane" — the laning row is.

There is a sharper version of the same failure, and the card now names it. When
one side is standing somewhere they do not normally stand, Dotabuff publishes no
lane row for them at all — so the form term drops out, the duo term was never
there on a 1v1 mid, and the lane's whole reading collapses back to the
whole-game head-to-head. Shadow Fiend against a mid Enigma reads **+0.0**, and
the figure is honest about what it measured: −0.05 over 61,305 games in which
Enigma was a pos 4 in nearly all of them. It is not a claim that the lane is
even; it is 61,305 games that were never about a mid lane.

Two notes exist for exactly this. **`unmeasured`** fires when a contested lane's
figure is the matchup mean and nothing lane-shaped was available, and says which
side's lane record is missing. **`off-role`** now runs over *both* line-ups
rather than only yours — "Their Enigma is off-role at 2 — 0% of their games,
which no figure in this card prices". Neither invents a number. An enemy playing
a position 0% of the time is the best thing that can happen to a lane and the
data cannot say by how much, so the card tells you it is happening and prices
nothing. On normally drafted boards neither note fires; across random ones the
`unmeasured` note appears on about 5% of contested lanes.

The laning stage between two particular heroes is measured now — STRATZ
publishes it pre-aggregated, and the laning row reads it. What is still not
measured is the 2v2 as a unit: the row averages four 1v1 pairings, and a specific
four-hero arrangement shows up a handful of times in a million games, too few to
read on its own.

**Everything else about how the game is played.** Item timings, and the reasons
behind any of it. The game-length read says *when* a line-up wins, not *why* —
it cannot tell you that you have no stun, no dispel or no way to break a
defensive formation, because none of that is in the data. Synergy is measured
pairwise, so a trio that only works as a trio is invisible — there are not
enough games per triple to say anything about it, and pretending otherwise would
be noise. Nor does any of it know why two heroes work together, only that they
do. Treat it as one input to the draft, not the whole read.

## How the synergy maths is checked

The synergy pipeline is tested against simulated drafts
(`scripts/synergy-pipeline.test.mjs`): a quarter of a million matches are
generated from known hero strengths and known planted pairings, reduced to
exactly the rows the collector's query returns, and pushed through the real
aggregation. The recovered synergies have to correlate with the planted ones,
put the planted extremes at the extremes, leave neutral pairings quiet, and —
the one that matters most — never come out *larger* than the truth. Nothing in
the pipeline is told which pairs are special; it has to find them in the
win/loss record alone.
