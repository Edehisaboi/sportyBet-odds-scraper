# SportyBet Odds Scraper

Apify Actor that reads SportyBet (Nigeria) football odds for the eleven markets
ParlayHux prices, and hands them back keyed to the fixtures it was asked about.

The caller supplies fixtures the way ParlayHux holds them — team names, kickoff,
competition key. The actor finds each one on SportyBet, pulls that event's full
market list, and returns only the markets and selections the backend has a
vocabulary for.

## How it works

SportyBet serves its whole odds catalog as unauthenticated JSON, so there is no
browser anywhere in this actor — it is `got-scraping` and `JSON.parse`, on the
plain `apify/actor-node` image. Two endpoints carry the job:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/ng/factsCenter/pcUpcomingEvents` | Paginated index of every upcoming football event (~1,600 across 300+ tournaments, about four weeks ahead), in ~20 pages with no overlap. |
| `GET /api/ng/factsCenter/event?eventId=sr:match:N` | Every market on one event — 600–850 of them for a top-flight fixture. |

A run builds the index once, resolves every requested fixture against it in
memory, then spends exactly one request per matched fixture. A five-fixture run
takes about fifteen seconds.

There is a third endpoint, `factsCenter/pcEvents`, that returns a single
tournament's events, but it is a POST that answers `403` to anything but
SportyBet's own client. The index is filtered by tournament on our side instead.

## Modes

### `odds` (default)

Prices a named list of fixtures.

```json
{
  "mode": "odds",
  "fixtures": [
    {
      "fixtureId": "d1f0c6b2-…",
      "externalId": "flashscore-match-id",
      "competitionKey": "premier_league",
      "homeTeam": "Crystal Palace",
      "awayTeam": "Manchester City",
      "kickoff": "2026-08-28T19:00:00Z"
    }
  ],
  "maxConcurrency": 5
}
```

Only `homeTeam` and `awayTeam` are required. `kickoff` is close to required in
practice — it gates which events are even considered. `competitionKey` narrows
the candidate pool. `eventId`, if you have one from a previous run, skips
matching altogether.

One row comes back per requested fixture, **including the ones that did not
match** — the caller asked about a specific fixture, and "not listed yet" or
"needs a name alias" are answers it needs. A short dataset would be
indistinguishable from a run that half failed.

### `events`

Lists what SportyBet is currently carrying. This is the diagnostic mode: use it
to find out whether a competition is on the site at all, under which tournament
id, spelling its clubs how — and to check the tournament ids in
`src/competitions.js` against a live slate.

```json
{ "mode": "events", "competitions": "all", "windowDays": 30 }
```

Competitions in the catalog that matched no events are called out in the run
summary as `competitionsWithNoEvents`.

## Market mapping

SportyBet is a Sportradar shop, so market and outcome ids are stable numeric
identifiers rather than display text. `src/markets.js` keys on those ids, not on
descriptions — the descriptions are localised, re-worded, and carry the line
inside them (`"Over 2.5"`), while the ids do not move.

| ParlayHux market | SportyBet market | Notes |
| --- | --- | --- |
| `match_result` | `1` (1X2) | outcomes 1/2/3 |
| `double_chance` | `10` | outcomes 9/10/11 |
| `btts` | `29` (GG/NG) | outcomes 74/76 |
| `over_under_goals` | `18` | line from `total=` |
| `team_total_goals` | `19` home, `20` away | line from `total=` |
| `goal_range` | `548` (Multigoals) | outcomes 1736 (`2-4`), 1740 (`3-5`) |
| `win_either_half` | `50` home, `51` away | Yes side only |
| `first_half_result` | `60` | outcomes 1/2/3 |
| `first_half_over_under` | `68` | line from `total=` |
| `first_half_team_total` | `69` home, `70` away | line from `total=` |
| `corners_over_under` | `166` | line from `total=` |

Two of those are worth explaining:

- **Goal range** comes from *Multigoals* (548), not from the market SportyBet
  actually labels "Goal Range" (25). Market 25 partitions goals into
  0-1/2-3/4-6/7+, which contains neither band we price; 548 quotes every band,
  including 2-4 and 3-5.
- **Win either half** is two separate yes/no markets. Only the Yes side maps.
  Taking a No as the other team's Yes would be wrong — both teams can fail to
  win a half.

Whole-number totals lines (`total=2` alongside `total=2.5`) are kept: they push
rather than lose, and the backend grades a push.

A top-flight fixture yields ~85 quotes across all eleven markets. Lower
divisions carry fewer markets — corners in particular are top-league only — and
the row's `markets_covered` count makes a thin fixture obvious at a glance.

## Fixture resolution

The two systems share no identifier: ParlayHux fixtures are keyed by Flashscore
match id, SportyBet by `sr:match:N`. So a fixture is identified by what both
sides agree on — the two club names and the kickoff time.

The naming gap is real. Flashscore says *Manchester City*, *Nottingham*,
*FC Koln*; SportyBet says *Man City*, *Nottingham Forest*, *Cologne*. Exact
matching resolves about half a slate. `src/util.js` closes the rest by
normalising accents and punctuation, dropping legal forms (`FC`, `US`, `Calcio`),
applying token rules for the divergences that recur across many clubs
(`Utd`→`United`, `Munchen`→`Munich`, `Koln`→`Cologne`), and keeping a small
alias table for the handful of names that share no words at all
(*Spurs*/*Tottenham*, *PSG*/*Paris Saint-Germain*).

Three rules then keep matching honest:

1. **Kickoff is a gate, not a score.** A candidate outside the window is not
   considered, however well its names read.
2. **Both teams must clear the threshold.** One strong side is how a fixture
   gets matched onto its own reverse.
3. **The winner must beat the runner-up by a margin.** Two candidates scoring
   alike means the evidence does not distinguish them, so the result is reported
   ambiguous rather than guessed.

Scoring aligns names token by token rather than comparing whole strings. Whole-
string bigrams are dominated by shared characters, which scores *Manchester
City* against *Manchester United* at 0.74 — a mismatch waiting to happen.
Aligning puts `city` against `united` and scores 0.63, below threshold.

Against a live slate, 47 of 47 hand-written Flashscore-style names for the top
five leagues resolved to the correct event, with no mismatches and no swaps.

Every rejection reports why (`match_reason`) and persists its nearest event and
individual team scores in the `nearest_*` fields, so an unresolved fixture can
be diagnosed from the dataset without a re-run. `no_plausible_name_candidate`
means events existed near that kickoff but none resembled the requested teams;
`below_name_threshold` is reserved for a meaningful near-match that may need an
alias. Thresholds are tunable per run via `matching`:

```json
{ "matching": { "kickoffToleranceMinutes": 360, "minPlausibleScore": 0.40, "minNameScore": 0.72, "minCombinedScore": 0.80, "minMargin": 0.06 } }
```

## Output

One row per requested fixture:

```json
{
  "fixture_id": "d1f0c6b2-…",
  "external_id": "flashscore-match-id",
  "competition_key": "premier_league",
  "bookmaker": "sportybet",
  "event_id": "sr:match:72221220",
  "home_team": "Crystal Palace",
  "away_team": "Man City",
  "kickoff_utc": "2026-08-28T19:00:00.000Z",
  "requested_home_team": "Crystal Palace",
  "requested_away_team": "Manchester City",
  "matched": true,
  "match_reason": "name_match",
  "match_score": 1,
  "match_home_score": 1,
  "match_away_score": 1,
  "match_weakest_score": 1,
  "quote_count": 85,
  "markets_covered": 11,
  "captured_at": "2026-08-28T18:11:34.913Z",
  "quotes": [
    {
      "market": "match_result",
      "selection": "away",
      "line": null,
      "price": 1.67,
      "probability": 0.590187,
      "source_market_id": "1",
      "source_specifier": "",
      "source_outcome_id": "3"
    }
  ]
}
```

The names SportyBet holds are kept separate from the ones the caller asked
about, so a marginal match can be audited after the fact. `probability` is
SportyBet's own pre-margin implied probability, carried through because it is
strictly more information than the price and costs nothing to keep.

Quotes are nested rather than flattened to one row per selection: a fixture
yields 40–90 of them and the caller writes them as one batch against one fixture
id, so the fixture is the natural unit of transfer.

## Backend integration note

`quotes[].market` and `quotes[].selection` already use the backend's
`Market` / `Selection` vocabulary, so they map onto `OddsMarketQuote` directly.
One gap remains: `app/domain/enums.py::Bookmaker` has no `sportybet` member —
it currently enumerates the UK books The Odds API serves — and `odds_snapshots`
stores that column as a native Postgres enum. Adding the value needs an enum
migration before these rows can be written.

## Development

```bash
npm install
npm test
```

Run locally against the live site (no proxy, no Apify account):

```bash
APIFY_LOCAL_STORAGE_DIR=./storage node src/main.js
```

with the input in `storage/key_value_stores/default/INPUT.json`.
