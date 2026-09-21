# The interface in detail

What each panel shows, and how to read it. The keyboard shortcuts and the basics
are in the [README](../README.md#using-it).

## Numbers on the tiles

Once the enemy has heroes on the board, every remaining tile carries its average
advantage against that line-up in one corner. Under **Best to pick** or **Best
to ban** that corner switches to the ranking score itself, and the leading three heroes get an ordinal. Both are read from
the whole pool, not from what the search box left on screen: type a few letters
and the tiles narrow, but a "1" still means first in the ranking — the same
first the suggestion panel counts from — so the two lists can never appear to
disagree about which hero is best. A hero the ranking excludes, because they do
not play the position being sorted for, is dimmed and shows no number at all
rather than a differently-defined one in the same corner.

## The hero card

A tile only has room for one number, so each one carries an **i** in its corner.
Hovering it opens the same read-out the suggestion panels give — and then some:
the score taken apart into every term it is the sum of — matchups, synergy,
meta, their plan, early game — and they *do* add up to the headline,
because the card renders the same list `evaluate` adds up rather than a second
copy of it. Then every head-to-head pairing with its sample size rather than the
strongest two or three, every synergy pairing, and the hero's position spread.
It follows the grid's sort and the grid's position filter, so under **Best to
ban** the numbers are flipped to your side just like the ban list — and the line
under the headline says which seat it was scored for, because the panel beside
it may well be scoring a different one. Click the **i** to pin the card
open; `Esc` or a click elsewhere closes it. Heroes already drafted or filtered
out of the suggestions still explain themselves. The two tiles in its top corner
open the hero in your browser: the arrow on Dotabuff, **D2PT** on
Dota2ProTracker's builds page. Scored as pos 1, D2PT opens on the carry builds;
otherwise on the hero's most popular role.

A pairing where the two heroes would stand in the same lane carries a second
figure beside the name — `seat +2.72` — and the row's advantage already
includes it. That is what STRATZ's lane table says about this hero *at this
seat* against that opponent, beyond the whole-game matchup everyone else in the
list is scored on; the tooltip gives the lanes it rests on. Most pairings do not
have one, either because the two would never meet in a lane or because the
table has no row that thick. [How it is measured](scoring.md#counters-by-seat).

The card also answers the question the score raises but cannot settle: **what
the board becomes if you take them.** `draft −0.4 → +1.9 (+2.3)`, plus the lane
that pick moves most. A score is an average over pairings, so a hero worth +2
overall can still be the pick that hands away the safe lane — and a merely
average hero can be the one that fixes it. Both halves are the same
`draftBalance` arithmetic the headline uses, run twice, so the preview always
agrees with the number it is previewing.

## Off-role answers

Under the pick list, on the boards that have one, sits a second short list:
heroes the **role threshold** removed, put back by one measured pairing. Pudge
is a pos 1 in 1.8% of his games, so he is never in the list above — but against
an Axe in the offlane, the 3,948 lanes where he was one say he wins 55.7% of
those games, +2.7 beyond what his seat and their whole-game matchup predict.

Each row gives the hero, the pairing that earns the stretch, the share of their
games actually played in that seat, and the score they reach *after* being
charged up to 2.5 points for playing out of position. The block is absent on
most boards, and that is the honest answer for most boards. It is a pick list
only — [what it takes to appear there](scoring.md#off-role-answers) — and the
sample beside each one is printed because the whole claim rests on it.

## Countered by

Every other list in the app is a read on the board in front of you. **Countered
by** is the one that is not: the five heroes with the worst matchups into the one
you are looking at, whatever has been picked so far. Anti-Mage's row is Huskar,
Meepo, Axe, Slardar, Troll Warlord — the answers the enemy still has to a hero
you are about to commit to, which makes it the only part of the card that is
useful before the first enemy pick, and that is exactly when a ban is still
cheap. **Click a face to ban it**; click it again to take the ban back.

Faces rather than another table, because the action it feeds is aimed at a
portrait. Each figure is on screen at once — a row of unlabelled faces is a
ranking you can only trust, one with numbers under it is a ranking you can argue
with — and hovering adds the sample underneath in a line below, rather than
opening a second popover over the one you are reading.

Both figures are shown there, because either alone misleads: **Pudge wins 54.9%
of his games against Timbersaw and it is still his worst matchup in the game.**
The win rate on its own reads as a hero doing fine; "3.1 below par" on its own
reads as a hero losing. Read through the same `matchup()` as everything else —
same sample floor, same shrinkage, same averaging of Dotabuff's two pages — so a
hero listed here at 5.1 is the same 5.1 that appears in the matchup breakdown
once they are actually on the board. The row is allowed to come back short, or
empty: a hero whose worst matchup is a fifth of a point does not have a counter,
and padding the row out to five would say they did.

Heroes already banned or drafted stay in the row, dimmed and marked. A list that
silently reshuffled as you banned would make it impossible to tell which face you
just clicked, and "this threat is already handled" is worth seeing.

## Best with

The mirror, directly underneath, and the answer to the other question the pick
list raises but cannot settle: it can tell you a hero is the strongest thing on
the board and still leave you with no plan for the next four slots. **Best with**
is the plan — Juggernaut's row is Magnus, Outworld Destroyer, Gyrocopter,
Underlord, Centaur — and it is a property of the hero rather than of the draft,
so like the counters it can be read before anything has been taken. **Click a
face to put that hero on your team**, with a position guessed the same way a
click on a tile guesses one.

Two things to keep in mind reading the numbers:

- **They are much smaller than matchup edges, and that is not the same as being
  less important.** Synergy is what a pairing adds *beyond* what the two heroes
  are worth apart, so it is measured against a baseline that already contains
  most of each hero. A full point is roughly the 99th percentile of the whole
  table, where matchup advantages routinely run past five. The same `NOISE`
  floor therefore bites much harder here: a typical hero has 10–25 candidates
  over it, fourteen or so have fewer than five, and three have none at all.
- **The pair's win rate can sit below 50 anyway.** Io and Drow Ranger is the best
  pairing Io has (+1.75) and the two of them win 47.6% together. Both figures are
  in the read-out for the same reason both are in the counter row: the edge alone
  reads as a pair winning, the win rate alone reads as a pair that does not work.

The row quotes the pairing's **blended** figure, not one of its core/support
cells. A cell answers "what are these two worth played this way round", which
needs both positions decided — and this row is read before either hero is on the
board, so picking a cell would mean inventing the arrangement to quote it from.
Once both heroes are actually drafted the score and the breakdown do use the
cell, and that number can honestly differ from this one.

A **★** beside a suggestion means the hero stays in the top five however the
tuning sliders are set — counter-heavy, meta-heavy, synergy-heavy, lane-blind or
lane-obsessed. Without it a ranked list quietly conflates "the data likes this
hero" with "your current weights like this hero". A star is a conclusion; an
unstarred hero near the top may be a setting.

## Reading the draft

**Draft analysis** is the first of the top bar's actions. It carries the
draft's signed score and opens the analysis above the board; until both teams
have a hero it is greyed out and its tooltip says what it needs. The score is a
comparison signal built from weighted matchup, synergy and early-cover terms,
not a predicted win probability.

The analysis opens on **Game plan**:

- A draft-specific strategic headline, followed by the best timing window,
  opening lane pressure, widest enemy threat, and the share of sampled games
  ending before your first favorable timing window. First favorable and peak
  timing are deliberately separate.
- An evidence-backed playbook: timing priorities, lanes to protect or pressure,
  enemies affecting several teammates, severe individual counters, favorable
  matchups and the strongest measured partnership. **Why this matters** opens
  the supporting figures. Advice is an interpretation of historical results;
  it does not infer ability interactions, item builds or live power spikes.
- An interactive timing chart. Select a game-length window to inspect both
  teams' relative skews and how often games end there.
- Three lane cards separating **expected lane share** from the **composite game
  outlook**. A positive game outlook never turns a statistically losing opening
  into a lane to pressure.

**Matchup map** shows every drafted hero against every opponent. Select a cell
for its sample size, deployment and disagreement between source readings. The
lane filter keeps confirmed lane opponents. Missing cells show a dash and
unassigned heroes remain visible. Values inside the noise floor stay neutral.

**Deep dive** retains the full numerical breakdown below. **Compact** keeps a
short actionable briefing; **Copy briefing** exports the plan and supporting
measurements. **Close**, the button again, or `Esc` while the panel has focus
puts it away. **Evidence & coverage** lists source dates and denominators.
Coverage is not prediction confidence. Incomplete drafts are provisional, and
whole-draft timing advice requires every drafted hero to have data in every
window. Missing records are never treated as neutral opponents.

The detailed measurements are:

- **Lanes.** Safe, mid and offlane scored separately from the heroes who would
  stand opposite each other — your 1 and 5 against their 3 and 4, and so on —
  plus **across the map**, the pairings that never meet in a lane at all. That
  last row is there because on a full board it holds 16 of the 25 figures and
  most of the headline's weight; while it was hidden, the three lane numbers
  could not be reconciled with the headline by any arithmetic you could see.

  The first row, **laning**, is who takes the laning stage: each side's expected
  share of it — lanes won plus half of those drawn — from STRATZ's lane
  outcomes for the heroes actually standing opposite each other, beside what
  those particular pairings are **worth** in games. A lane at 53–47 or wider
  also gets a line saying who takes it and naming the widest pairing. See
  [Lane outcomes](scoring.md#lane-outcomes).

  The lane number itself is what the lane is worth in games, a blend of four
  readings weighted by how much each is actually about a lane: **laning**'s
  worth and **form** first — form being the win rate of the heroes standing
  there in games played *from that lane*, shrunk towards their overall figure
  when they rarely stand in it, and shrunk again when only part of a side was
  scraped; then **duo**, the chemistry between the two who share it, which is
  the 2v2 the lane really is but measured over whole games; then **matchups**,
  the head-to-head mean, which is whole-game and on a 2v2 also averages in the
  support-versus-carry pairings that say nothing about laning. Each is printed
  as its own row with the **edge** between the two sides, so the headline can
  always be taken apart. Then the reasons — the pairing that is losing, the
  weaker half of your own lane, and anyone standing somewhere they almost never
  stand.

  Form and laning answer different questions and often disagree: a lane bully
  wins the laning stage without winning more games from that lane, and the
  numbers bear that out across the whole pool. Read laning for the first ten
  minutes and the lane number for what the lane is worth.

  The matchup mean used to *be* the headline, and that is the failure this
  weighting exists to fix: four whole-game numbers can average to `+0.1` while
  the two heroes actually standing there are two points worse from that lane
  than the two opposite — and `+0.1` was the figure set in large green type.
  The same lane now reads `−0.9`. Where the matchups and form still disagree the
  card says so in as many words.

  With no lane rows and no duo sample the blend has nothing to weigh and the
  score is the matchup mean exactly, as it always was — which is also what the
  across-the-map row is, since nobody stands anywhere in it.

  The obvious way for this weighting to be wrong is a **structural tilt**: your
  safe lane is read from the `safe` rows and the pair opposite it from the `off`
  rows, so if safe-lane win rates simply ran higher across the pool, every safe
  lane would print green for no reason connected to the draft. Measured on the
  current table, weighted by how often heroes actually stand there, the gap is
  **0.02 points** — a twenty-fifth of the noise floor. Over 4,000 simulated 5v5
  drafts the score comes out at mean −0.01 with 36% of lanes red and 35% green,
  and per-lane means of −0.16 / +0.04 / +0.09 for safe, mid and off. Worth
  re-measuring after a patch that moves the lane meta; the check lives in the
  antisymmetry test, which fails if the blend ever favours the side asking.

  What does change is how often a lane says anything at all. The matchup mean
  is a low-variance statistic — four whole-game figures between four heroes
  largely cancel — so it used to leave half of all lanes inside the noise floor
  and greyed out. The blend has a standard deviation of 1.54 against its 0.99,
  and roughly two lanes in three change colour, nearly all of that grey turning
  into a call. The direction is even: 9.4% of lanes go green-to-red and 8.8%
  red-to-green.
- **Game length.** Where each line-up's window is, from `timings.json`, drawn as
  two curves. The question is where the lines cross — before that point you want
  fights, after it they do — and that is the one thing a column of numbers is
  bad at. The per-window figures are still listed underneath.
- **Our five.** Every hero of yours scored against their line-up and beside
  your own, best contributor to hardest game — the strong link and the weak one.
- **Pairings that matter.** The five head-to-heads hurting you most and the five
  going your way, with sample sizes.
- **Cohesion.** Your pairings against theirs, best and worst named.

At the top is a short list of the things worth saying out loud — the weak lane
and its cause, the lane to play through, the window you win in, the hero having
the hardest game, the enemy to watch. It is capped at five and it stays quiet
when the draft has nothing to say, which is the point: a picker that always
finds a narrative teaches you to ignore it.

Every section fills in as heroes go on the board rather than waiting for 5v5,
and the header carries the coverage — `18/25 matchups · 14/20 pairings` — so a
confident-looking number built on six pairings is visibly that. Anything without
a big enough sample is left out rather than guessed.

**Copy briefing** puts the whole read-out on the clipboard as text — verdict, talking
points, lanes, timings, threats and the coverage line. A draft plan is worth
nothing if the other four cannot see it, and the coverage travels with the
numbers because the person receiving a paste cannot ask how many pairings were
behind them.

If any data file is more than a month old the header says so in amber. Dota
patches move these numbers, and nothing else in the app would mention that the
confident decimals are describing a previous game.

**Half a point is nothing, everywhere.** One noise floor — `NOISE`, 0.5
percentage points — decides what gets a colour, what gets named as a threat or
an edge, and what the talking points will mention. Below it the panel stays
grey and says nothing. This used to be inconsistent: the verdict used 0.5 while
every other figure used 0.05, so the same screen could call −0.3 a coin flip
and paint +0.1 green two inches below it. Dotabuff's own two pages disagree by
more than half a point on roughly one pairing in ten, so anything smaller is
inside the error of the source before the model gets to it.

**There is no expected win rate.** The headline is a signed comparison between
two line-ups in percentage points, and it is labelled as one. It was briefly
printed as `≈49.7% expected win rate`, which it is not: the figure is the *mean*
of up to 25 pairwise deltas plus a mean synergy delta, and a mean of marginal
effects is not the combined effect of all of them — if you believed they were
additive you would sum, not average. Averaging also pulls it towards zero as
the board fills, so the number got calmer the more it knew. Use it to rank two
drafts against each other, not to predict a match.

**Compact** drops the tables and keeps the verdict and the talking points, which
is the shape you want mid-draft: the panel shrinks to a few lines, so the hero
grid below stays usable and you can keep picking while the numbers move.

## Positions

Every hero you put on either team is booked into a position 1–5. The app guesses
it — their most-played position among the ones that team still needs — and the
dropdown next to each hero lets you correct it, which is the point: you know who
is playing what, the data only knows what is usual. Each option shows the share
of that hero's games spent there, so an unusual call is visible rather than
silent. A position is exclusive within a team; assigning it takes it off whoever
held it.

That drives four things:

- **The pick list targets a position.** It follows the first slot your team is
  missing, and the `Any 1 2 3 4 5` row above the list overrides that. Underlined
  numbers are the slots still open. Heroes who do not play the selected position
  drop out of the suggestions and dim in the grid — no more five carries.
- **Lane opponents count double.** A pos 3 is scored mainly against the enemy
  pos 1 and pos 5 it will stand in front of, not against their mid. Those
  matchups are marked ⚔ in the suggestion. The `Lane weight` slider controls
  how much extra they get.
- **Win rates become position-specific.** Drow Ranger's mid win rate is several
  points above her overall one; the pick list uses the figure for the position
  you are drafting for. A role the hero barely plays is shrunk back towards
  their overall figure, so a handful of games at pos 1 cannot decide a support's
  score. Positions and these win rates come from STRATZ's counts for the rank
  picked in the top bar — All ranks, Divine+ or Immortal — and the win-rate
  tag's tooltip names it; see [Where positions come from](scoring.md#where-positions-come-from).
- **Synergy is read by role.** What two heroes are worth together depends on who
  is farming, so the same pairing can score differently at pos 2 and pos 4. See
  [Synergy by role](scoring.md#synergy-by-role).

The ban list has the same position filter, so you can go looking specifically
for the pos 2 that would ruin your mid.

Search understands community shorthand — `pa`, `kotl`, `qop`, `wk`, `np` — as
well as Valve's internal names (`nevermore`, `furion`, `wisp`, `zuus`).

The draft, the rank and the tuning sliders survive a page reload.

## Rebalancing your five

Every other panel helps you choose the *next* hero. **Rebalance** is for the
moment when there is no next hero: the picks are locked, they answered your
first-pick mid, and the only thing still free is which of your five takes which
seat.

That move is real and it is genuinely hard to do by eye. Five heroes have 120
role arrangements; the lane swap doubles it; and each one reweights every lane
pairing on the board and re-cuts every synergy figure on the core/support line.
Nobody works that out in the thirty seconds a draft gives you, so the search
just runs all of it — 240 arrangements in well under a millisecond — every time
the board changes.

The button lives in the top bar and stays quiet until there is something to say.
When the search finds an arrangement worth more than the noise floor it turns
amber and carries the figure: `Rebalance +1.4`. That is the warning half of the
feature — the case worth catching is the one you did not think to look for.

Two kinds of move are on the table:

- **Seats.** Your heroes exchange positions. Earth Spirit walks out of the mid
  lane they just countered and takes pos 4; whoever was there takes mid.
- **Lanes.** Nobody changes position, but the duos walk the other way: your safe
  pair goes up against *their* safe pair and your offlane pair against theirs.
  Carry meets carry. Roles and farm priority are untouched — only who stands
  opposite whom, which is exactly what the lane weighting and the lane form
  figures are measured against.

Both can be applied with one click, and the toggle in the panel header switches
the deployment on its own whenever you want to try it by hand. A swapped board
says so throughout: the read-out gains a `lanes swapped` tag, the lane cards
retitle themselves *Safe vs safe (swapped)* and *Off vs off (swapped)*, and each
of **your** heroes' lane records is read from the lane they are now standing in
rather than the one their position implies. Theirs are not, and the asymmetry is
the point: a swap is something one side does. You walked over; they are standing
where they always stand, and their carry keeps his safe-lane record.

An arrangement earns its place on the list one of three ways:

- **It puts somebody back on a seat they play.** The panel used to apply its role
  threshold to every arrangement it *considered* and never once to the board it
  was sitting on. A five with Earth Spirit booked at position 1 — 0.15% of his
  games, flagged in red in the read-out, a seat this search would refuse to
  suggest to anybody — came back *"no arrangement beats the board"*, because the
  only seatings that put him somewhere he plays cost half a point of score. Half
  a point is not the price of a carry who cannot carry. So the board is now held
  to the same threshold as everything it is compared against: heroes in seats
  they do not play are named at the top of the panel, and the arrangements that
  free them are offered whether or not the figure improves, with the cost printed
  on each. This is the only kind of row on the panel allowed to lose score, and
  it may lose at most `MAX_SEAT_COST`, about half of what the stretch it is
  undoing is priced at. When nothing fixes it, the panel says *that*
  instead of saying nothing: *"no rearrangement of these five fixes it — that is
  a draft problem, not a seating one."*
- **It is worth more overall** — `total` beats the board's by more than the
  [noise floor](#reading-the-draft).
- **It rescues a lane.** A single scalar over 25 pairings can hide an enormous
  change to four of them: moving a countered mid is worth two points *in that
  lane*, costs most of it back across the map, and nets out under the floor. The
  original rule reported "the five are already where they should be" about a
  draft whose mid was being run over. So a lane that was losing past the floor
  and improves past it counts, as long as the whole-board figure does not drop.

Because those lead with *different quantities*, every figure in the panel
prints the thing it measures underneath itself — `+1.8 board` against
`+2.3 mid` — and the supporting line carries the rest: `board +0.5 · draft −0.1
· coin flip · Safe lane +1.2`. The distinction used to be carried by colour
alone, which explains nothing, is the first thing lost to a cropped screenshot,
and left a bare amber `+2.5` sitting over a draft that was losing.

Three things then keep the list honest:

- **The role threshold prunes, and says that it pruned.** A hero is only offered
  a position they play at least `Role threshold` of the time — the same slider
  the suggestion lists use, default 5%. Arrangements it rejects are *set aside*
  rather than deleted, under **Beyond your role threshold**, because "no better
  arrangement exists" and "none exists that respects your 5% threshold" are
  different sentences and often only the second is true. A line-up with exactly
  one hero who plays position 1 has two legal seatings out of 120 — so the panel
  prints that count and names the seat: *"2 of 120 seatings clear your 5% role
  threshold — Shadow Fiend is the only one of your five who plays position 1."*
- **The small moves come first, all of them.** Before the arrangement list the
  panel prints **One move at a time**: every single trade that already makes the
  board better — two heroes exchanging seats, or the duos walking the other way,
  and nothing else. Not a shortlist. These all cost the same trivial amount of
  upheaval, so there is nothing to trade off and no reason to pick between them
  for you. Taking one re-runs the search on the board it leaves, so a line-up two
  or three trades away from where it should be gets there by steps you can each
  refuse on their own — which is the difference between advice and a permutation
  table. Trades that need somebody below the role threshold stay on this list and
  are flagged rather than filed away, because at this size *"swap your 4 and your
  5"* is a sentence somebody who knows the players can accept or refuse on sight.
- **One arrangement per amount of upheaval, and the cheapest is never dropped.**
  The biggest gain is almost always a four-way shuffle, and a reader offered
  only that will take none of it. Trading the carry and the mid, the mid and the
  offlane, the two supports, or simply walking the duos the other way are all
  one or two heroes changing seats — the moves people actually make — so the
  smallest arrangement keeps its slot however the ranking goes. Two heroes
  trading seats is described as what it is: *"Swap Shadow Fiend and Earth
  Spirit"*, not "move 2 heroes". What is left after the small-move list has taken
  its own is shown under **All at once** — the reseatings no sequence of single
  trades reaches in one step.
- **Nothing under half a point is offered on the score.** Same floor as
  everywhere else in the app. Rearranging your draft to gain 0.2 is not advice —
  fixing a lane you are losing is, which is what the second rule is for.

What the model cannot see is who on your team can actually play the seat. It
knows Earth Spirit is a pos 4 in 66% of *all* games; it does not know that your
pos 4 has never touched him. That is why the panel is a shortlist with the
stretch made visible rather than a button that reshuffles the draft for you.

Scored in `src/lib/rebalance.ts`, tested in `src/lib/rebalance.test.ts`. On
random full boards it finds something worth applying about one time in six, at a
mean gain of 0.8 points.
