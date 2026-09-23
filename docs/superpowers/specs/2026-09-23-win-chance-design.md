# Win chance: a calibrated draft verdict

Status: design approved in conversation on 2026-09-23; awaiting spec review.

## The problem

Anti-Mage 1, Meepo 2, Sven 3, Lifestealer 4, Arc Warden 5 against Leshrac,
Lina, Enigma, Bounty Hunter and Earthshaker: five cores, nobody supports. The
Draft analysis panel reads it as **−1.47, "Slight edge to them"**.

Three things produce that number, and all three were measured before this
design was written (see [Evidence](#evidence)):

1. **The headline cannot see roles.** `draftBalance` is the lane-weighted mean
   matchup, plus the synergy difference, plus the early-cover term. How strong a
   hero is in the seat they are booked into (`positionWinRate`) is in the pick
   score and in Rebalance, never in the verdict. Lifestealer at 4 wins 39.6% of
   his games, Arc Warden at 5 45.3%, Sven at 3 46.3%; nothing on the board said so
   except a grey line inside a lane card.
2. **Hero strength is absent too.** The matchup advantages and the synergies are
   both strength-corrected, so a line-up of five 47% heroes and one of five 53%
   heroes read the same. Across real games hero strength is the largest single
   signal the data holds.
3. **The verdict scale was never calibrated.** One point of the headline is
   worth about nine points of real win rate, so "Slight edge to them" at −1.5
   describes drafts that win 37–40% of their games; and because the headline is a
   mean of pairwise effects, it grows calmer as the board fills.

## The decision

The headline becomes a **calibrated win chance**: a logistic model over a small
set of draft features, whose weights are fitted on real ranked games by a new
`npm run calibrate` step at the end of every refresh, and whose calibration is
checked on held-out games before the file is written.

In scope: the Draft analysis panel (headline, verdict, Game plan, Deep dive,
Copy briefing), the top-bar button, the hero card's "what the board becomes"
preview, and the Rebalance objective, which reads the same board figure.

Out of scope, deliberately: the pick and ban rankings, the Tuning sliders and
the early-game penalty inside the pick score. They keep their current
arithmetic. Moving them onto the same model is a separate piece of work.

## The model

`src/lib/winModel.ts` — pure, with `winModel.test.ts` beside it — is the one
place the model is written down. The app and the calibration script both import
it, so the figure a draft is shown and the figure its weights were fitted
against are the same arithmetic.

### Features

Every feature is **mine minus theirs**, so the model is antisymmetric by
construction: swapping the two line-ups turns a chance `p` into `1 − p`.
`matchup(a, b)` is already the exact negative of `matchup(b, a)` — both pages
averaged, damped by a noise term symmetric in the two heroes — so the matchup
sum needs no second side. Every other feature is computed once per side and
differenced.

| Key | Definition |
| --- | --- |
| `matchups` | Σ over every (my hero, their hero) pair of the damped Dotabuff advantage, `matchup(data, a, b).advantage`, for pairs with ≥ 200 matches. No lane weighting and no seat counters: see [What is left out](#what-is-left-out). |
| `cohesion` | Per side, Σ over the side's pairs of `synergy(data, a, b, posA, posB, 200).synergy` (core/support cells as booked), pairs with ≥ 200 games. |
| `heroes` | Per side, Σ over the side's heroes of `winRate − 50`, in the rank band on screen. |
| `seatPenalty` | Per side, Σ over the side's heroes of `min(0, positionWinRate(hero, seat) − winRate)`. A hero with no seat booked contributes 0. |
| `seatBonus` | Per side, Σ over the side's heroes of `max(0, positionWinRate(hero, seat) − winRate)`. |
| `roleDeficit` | Per side, `min(0, S / 5 + τ)²`, where `S` is the side's `seatPenalty + seatBonus`. Always divided by five, so undrafted heroes count as seated where they belong. `τ` comes from calibration. This is the convex term that makes "nobody supports" expensive while leaving ordinary flexes almost free. Its weight is negative. |
| `timing` | Per side, the negated early-cover shortfall at unit weight, `−earlyCoverPenalty(teamCover(side), 1)` — so the difference is their shortfall minus mine, exactly as `draftBalance` differences it. |

The chance is `σ(Σ weight × feature)`. The fit includes a side term (Radiant
wins 52.9% of these games); the app leaves it out, since a draft does not know
which side it will play.

Sample floors are fixed in `winModel.ts` as `WIN_MODEL_FLOORS` (200 matches, 200
synergy games) and the calibration script imports the same constant. The Tuning
sliders do not move the win chance: a probability computed under floors other
than the ones its weights were fitted with would no longer be calibrated. The
sliders go on tuning the pick list.

An empty board is exactly 50%. Each hero added moves the figure, so it sharpens
as the board fills — the opposite of the mean it replaces.

### Parts

The breakdown shows five groups: **Roles** (`seatPenalty`, `seatBonus`,
`roleDeficit`), **Matchups**, **Cohesion**, **Heroes**, **Timing**. Each group's
part is its exact Shapley value in points of win chance, so the parts add up to
`chance − 50` with nothing left over. Five groups are 32 evaluations of `σ`.

Each part carries one reason in words, built from the same numbers:

- Roles: heroes on either side in a seat that holds under 5% of their games,
  named with the share ("Lifestealer at 4 — 0.5% of his games"); plus "nobody
  on your side supports" when a complete side's summed position-4 and -5 shares
  are under 0.5, and "nobody on your side farms" when its summed position-1 to
  -3 shares are under 0.5. The enemy's off-role heroes are reported as good news.
- Matchups: the worst and the best pairing on the board.
- Cohesion: each side's best measured pair.
- Heroes: the strongest and weakest hero by win rate.
- Timing: the side short of early cover, when either is.

### Verdict and display

| Win chance | Verdict | Share of real games in the pilot |
| --- | --- | ---: |
| 45–55% | Coin flip | ~38% |
| 40–45 / 55–60% | Slight edge to them / you | ~30% |
| 33–40 / 60–67% | They are favoured / You are favoured | ~24% |
| 25–33 / 67–75% | They are well ahead / You are well ahead | ~7.6% |
| under 25 / over 75% | You are being run over / Dominant draft | ~0.8% |

Precisely, by the distance `d` of the chance from 50 points: `d < 5` coin
flip, `5 ≤ d < 10` slight edge, `10 ≤ d < 17` favoured, `17 ≤ d < 25` well
ahead, `d ≥ 25` run over or dominant.

The chance is printed as a whole percent. Outside the calibrated range — the
span of reliability bins holding at least 200 held-out team-games, 15–85% in the
pilot — the headline reads **"under 15%"** (or "over 85%") with the model's own
figure beside it: "under 15% (model 6%) — beyond the 15–85% the calibration can
vouch for". The parts still add up to the model's figure.

## Calibration

### `npm run calibrate`

- `scripts/calibrate.mjs` does the network and the files; `scripts/calibrate-math.mjs`
  holds the pure maths (logistic regression by IRLS with standard errors, the
  threshold grid, the reliability table, the guardrails) with
  `calibrate-math.test.mjs` beside it.
- It builds the dataset from `public/data/` with `buildDataset` and imports
  `winModel.ts` through the TypeScript loader the tests already use:
  `node --experimental-strip-types --import ./scripts/register-ts-resolve.mjs scripts/calibrate.mjs`.
- **Which games.** Ranked All Pick (`lobby_type 7`, `game_mode 22`) from
  OpenDota's `public_matches`, **strictly older** than the lower bound of both
  `synergies.json`'s and `timings.json`'s `matchIdRange`. The weights are
  therefore never fitted on the games the synergies and timings were measured
  on. Default 300,000 matches (`--matches=` to change). Windows are walked
  backwards with the adaptive width the synergy collector uses; the raw line-ups
  are cached under `scripts/.cache/` so a rerun that only needs a refit does not
  download them again (`--fresh` to ignore the cache).
- **Positions** for each line-up come from `scripts/assign.mjs` with the
  `positions.json` shares, as in the synergy collector.
- **Fit.** One row per match from Radiant's side, with a side term. `τ` is
  chosen from {0.5, 1, 1.5, 2, 2.5, 3} by two-fold held-out log-loss (folds by
  match id parity); the final weights are then fitted on all games at that `τ`.
- **Reliability.** Out-of-fold predictions, read from both seats so the table is
  side-neutral, in 5-point bins: games, mean prediction, actual win rate.

### Guardrails

The step writes nothing, keeps the previous `calibration.json` and exits non-zero
when any of these fails:

- fewer than 100,000 usable matches;
- held-out log-loss not at least 0.005 below the side-only baseline;
- any reliability bin holding 1,000 or more games off by more than 3 points;
- a sign that makes no sense: `matchups`, `cohesion`, `heroes`, `seatPenalty`
  and `seatBonus` must be positive and `roleDeficit` must not be positive.
  `timing` may take either sign; it measured near zero.

### `public/data/calibration.json`

The shape, with illustrative values:

```jsonc
{
  "generatedAt": "…",
  "source": "https://api.opendota.com/api/explorer (public_matches)",
  "note": "…what every field means…",
  "matches": 300000,
  "matchIdRange": [lo, hi],
  "rankBand": "all",
  "inputs": { "matchups": "<generatedAt>", "positions": "…", "synergies": "…", "timings": "…" },
  "tau": 1.5,
  "weights": { "matchups": 0.046, "cohesion": 0.018, "heroes": 0.052, "seatPenalty": 0.028,
               "seatBonus": 0.020, "roleDeficit": -0.065, "timing": 0.01 },
  "se": { "…": "same keys" },
  "side": 0.124,
  "holdout": { "logLoss": 0.672, "baseline": 0.691, "auc": 0.61 },
  "reliability": [[0.15, 0.20, 354, 0.184, 0.198], "…"],
  "range": [0.15, 0.85]
}
```

`inputs` names the four data files the features read. `lanes.json` is not among
them: nothing in the model reads it.

### In the refresh and the app

- `refresh.mjs` runs `calibrate` after `portraits` and before `readme`. Steps
  gain an optional `nodeArgs` for the loader flags. Its summary line reads the
  sample, the held-out log-loss against the baseline, and the range.
- `dataset.ts` loads `calibration.json` beside the other five files and
  validates it: every feature key present and finite, `range` inside (0, 1).
  Anything else is treated as absent.
- **Absent:** the panel shows today's comparison signal and verdict, labelled as
  it is now, with "no calibration — run `npm run calibrate`" in the header.
  `draftBalance` is untouched, so this path costs nothing to keep.
- **Present but older than the data:** when any `inputs` timestamp differs from
  the loaded file's `generatedAt`, the win chance still shows and the header
  says, in amber, that the calibration predates the data. A failed `calibrate`
  after a good refresh lands here.
- `readme-status.mjs` gains a data-table row, "Win model | OpenDota | window |
  N matches | patch", from `calibration.json`'s match id range, read the way the
  synergy and timing rows are; `readme-sync.test.mjs` then covers it. The window
  takes part in the data-patch badge like every other row.
- `NOTICE.md` gains `public/data/calibration.json` on the OpenDota row: it is
  derived from their public match records.

## Interface

- **Top bar.** The Draft analysis chip shows the chance — `38%`, or `<15%` —
  coloured by verdict side. The tooltip gives the verdict, the parts and the
  calibration sample.
- **Game plan.** The "Draft edge" block becomes **Win chance**: the figure, the
  verdict, and one line of evidence from the reliability table — "drafts rated
  35–40% won 37.8% of 74,115 held-out games". "What moves the draft score"
  becomes "What moves the win chance": the five parts with their reasons.
- **Strategic headline.** When Roles is the largest negative part and costs at
  least 5 points, the headline leads with it — "Fix the roles first" — and its
  description is the Roles reason with its cost in points. The playbook gains a
  ROLES item whenever Roles costs 2 points or more.
- **Deep dive** gains a **Roles** card: every hero on both sides with the seat,
  the share of their games in it, and their win rate there against their own,
  then each side's seat total and the deficit term.
- **Hero card.** The preview reads `win chance 38% → 44% (+6)`; the lane line
  under it is unchanged. `DraftImpact` gains a `unit` (`"chance"` or
  `"points"`) so the fallback keeps working.
- **Copy briefing and talking points** open with the win chance and its parts;
  the Roles point leads the talking points when Roles costs 5 points or more.
- Mid-draft the figure is labelled provisional, as the panel already labels
  incomplete drafts.
- `DraftAnalysis` gains `win: WinRead | null`. Every headline consumer shows
  `win` when it is present and the existing `advantage`/`verdict` when it is not.

## Rebalance

- An arrangement is scored by the win chance of the board arranged that way.
  `seatPenalty`, `seatBonus` and `roleDeficit` are inside the model, so the
  separate `fit` term leaves the objective; `advantage` leaves it too.
- The lane read is not a model feature (it measured nothing), so it leaves the
  objective, but not the panel: the "rescues a lane" rule still qualifies an
  arrangement that takes a losing lane out of the fire while costing less than
  a point of win chance (the qualifying floor), and lane shifts still print
  under every option. With no lane-dependent
  term in the model, swapping lanes leaves the chance where it was, so a lane
  swap is now offered only as a lane rescue. The docs say so.
- Thresholds move into points of win chance: an arrangement qualifies on score
  at +1 point, and a seat fix may cost up to 2 points (`MAX_SEAT_COST`). The
  panel prints each gain as points of win chance with its Shapley parts.
- Without calibration, `readArrangement` keeps today's objective, so the
  existing Rebalance tests go on exercising it unchanged.

## What is left out

Each of these was tried in the pilot and measured as adding nothing, or as
making the fit worse:

- **Doubling lane pairings.** Fitted separately, a lane pairing is worth 1.06×
  a pairing across the map (0.0475 against 0.0447 per point), not 2×.
- **Seat counters** (`laneCounter`) inside the matchup sum. They are read from
  one side only, and with them the held-out log-loss rose from 0.67187 to 0.67237.
- **The lane cards' readings.** The laning game edge weighed in at 0.0017 ± 0.0028,
  form at −0.0002 ± 0.0018 and duo at −0.0060 ± 0.0035. The lane cards keep
  printing all three; they no longer pretend to move the verdict.
- **A support-count term** (summed position-4 and -5 shares, convex below 2):
  once seat terms are in, it adds nothing. The seat deficit is the better shape.

`timing` stays in with its measured weight, currently indistinguishable from
zero (0.015 ± 0.026 in the pilot), and every calibration re-measures it. The
case in `docs/scoring.md` that motivated the early-cover penalty — Phantom
Lancer, Ancient Apparition, Arc Warden, Silencer, Axe into Bristleback, Lich,
Enigma, Lion, Sniper — reads about 72% under the pilot model: its 25 matchups add
up to a lot, and the missing early cover did not predict losses in 389,352 games.
The docs say that plainly.

## Evidence

A pilot on 389,352 ranked All Pick games from 2026-09-22 (OpenDota
`public_matches`, match ids 9,010,548,808–9,011,748,808), scored with the app's
own code and the data files committed at `318fd00`, whose synergy and timing
samples end on 2026-09-19. Positions were assigned per line-up with
`scripts/assign.mjs`. Fitted on even match ids, evaluated on odd.

| | Held-out log-loss | AUC |
| --- | ---: | ---: |
| Side only | 0.69145 | 0.50 |
| Today's headline | 0.68656 | 0.557 |
| Today's three terms, weighted freely | 0.68600 | 0.559 |
| The model above (symmetric seat term, τ = 1.5) | 0.67188 | ≈ 0.61 |

- Weights per point, from half the games: matchups 0.0458, cohesion 0.0179,
  heroes 0.0524; seat penalty 0.0279 ± 0.0023, seat bonus 0.0203 ± 0.0028.
  Bonuses from seats under 15% of a hero's games weigh the same as the rest,
  0.0189 ± 0.0066, so a rare seat's high win rate is not specially inflated.
- The weights on summed matchups and summed hero strength land near what an
  additive log-odds model predicts, 0.04 per point at an even game.
- Out-of-fold calibration, both seats: predicted 18.4 / actual 19.8 (354
  team-games), 23.2 / 23.8 (2,717), 28.0 / 27.6 (12,174), 32.9 / 32.9 (35,441),
  37.7 / 37.8 (74,115), 42.6 / 42.7 (117,615), 47.5 / 47.7 (146,917).
  Recalibration slope 0.997.
- Off-role line-ups in real games: teams whose summed position-4 and -5 shares
  are under 0.25 won 36.0% (261); 0.25–0.5, 40.6% (1,437). Teams whose mean seat
  delta is below −4 won 25% (8); −4 to −3, 30.3% (89); −3 to −2, 41.1% (1,176).
  The model without the convex term under-predicted every one of these bins;
  with it they fall within noise.

### Sanity cases

These are the acceptance checks for the finished feature, with the pilot's
figures. Exact numbers move with each calibration; the direction and the
leading part should not.

| Draft | Today | Pilot model | Leading part |
| --- | --- | --- | --- |
| The draft above, as booked | −1.47 slight edge to them | under 15% (model 6–8%) · run over | Roles ≈ −32 |
| Same enemy; Anti-Mage, Meepo, Axe, Rubick, Crystal Maiden | −1.48 slight edge to them | 27% · they are well ahead | Matchups ≈ −11 |
| The early-game case above | −0.43 coin flip | 72% · you are well ahead | Matchups ≈ +12 |
| Five supports into Juggernaut, Invoker, Mars, Tusk, Lich | −0.01 coin flip | 26% · they are well ahead | Roles ≈ −29 |
| Faceless Void, Storm Spirit, Centaur, Hoodwink, Warlock into Phantom Assassin, Puck, Underlord, Nyx, Jakiro | −0.09 coin flip | 38% · they are favoured | Heroes ≈ −9 |
| The same with Snapfire mid (26% of her games) | +0.33 coin flip | 46% · coin flip | Roles within ±2 |
| The same with Slark mid (16% of his games) | +0.32 coin flip | 50% · coin flip | Roles within ±2 |

## Known limits

- **Positions in calibration are inferred** from each line-up; on the board they
  are booked. A booked arrangement the assignment would never choose is exactly
  the case the convex term is about, and the tail bins above say it holds, but
  the tail is thin: under 15% there were 19 team-games.
- **All ranks only.** The weights are fitted at all ranks and applied to
  whichever rank band is on screen, whose win rates feed `heroes` and the seat
  terms. Per-band weights are a later step if the Divine+ and Immortal samples
  prove large enough.
- **STRATZ labels positions partly by outcome.** A hero who ended the game
  poorest is filed as a support, so rare-seat win rates carry some of the
  result. The fitted seat weights, about half the weight of hero strength,
  absorb that on average.
- **Public games.** Organised play drafts differently; nothing here is
  calibrated for it.
- **Pairs, not trios.** The model sees what pairs and seats do; three heroes that
  only work together remain invisible, as they are everywhere else in the app.

## Tests

- `winModel.test.ts`: antisymmetry; an empty board is 50%; a partial board fills
  undrafted seats neutrally; Shapley parts sum to `chance − 50`; settings do not
  move the chance; verdict bands; the out-of-range display; the Roles reasons,
  including "nobody supports" and enemy off-role as good news; the sanity cases'
  directions on a fixture calibration.
- `calibrate-math.test.mjs`: IRLS recovers planted weights and sensible standard
  errors from simulated games; the `τ` grid picks a planted threshold; the
  reliability table and the range; each guardrail rejects a fit built to fail it.
- A pure `calibrationWindow(synergies, timings)` in the calibration script,
  tested: the walk starts strictly below both `matchIdRange` lower bounds.
- `dataset.test.ts`: `calibration.json` validation, and absence.
- `analysis.test.ts`: `win` present with a calibration and null without; the
  headline consumers fall back.
- `rebalance.test.ts`: the calibrated objective, the point thresholds, lane
  rescue under a model with no lane terms; the existing tests keep covering the
  uncalibrated path.
- `readme-status.test.mjs`: the Win model row.

## Documentation

- `docs/scoring.md`: a new "Win chance" section with the derivation, the
  features, the evidence and the exclusions; "Scoring an arrangement" rewritten
  for Rebalance; the "Early game" section gains the calibrated result.
- `docs/ui.md`: "Reading the draft" and "Rebalancing your five", including the
  retirement of "There is no expected win rate".
- `README.md`: a Win chance bullet under "What it weighs"; the data row comes
  from `npm run readme`.
- `docs/refreshing-data.md`, `.claude/skills/refresh-data/SKILL.md`, `AGENTS.md`:
  the new step and command.
- `NOTICE.md`: the new file on the OpenDota row.
