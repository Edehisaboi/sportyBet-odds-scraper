import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveFixture, scoreCandidate } from '../src/resolve.js';
import { canonicalName, nameSimilarity, toEpochMillis } from '../src/util.js';

const KICKOFF = Date.parse('2026-08-28T19:00:00Z');

function event(overrides = {}) {
  const home = overrides.homeTeam ?? 'Crystal Palace';
  const away = overrides.awayTeam ?? 'Man City';
  return {
    eventId: 'sr:match:1',
    homeTeam: home,
    awayTeam: away,
    kickoffMillis: KICKOFF,
    competitionKey: 'premier_league',
    homeCanonical: canonicalName(home),
    awayCanonical: canonicalName(away),
    ...overrides,
    homeTeam: home,
    awayTeam: away,
  };
}

// -- normalisation -------------------------------------------------------

test('canonicalName strips legal forms, punctuation and accents', () => {
  assert.equal(canonicalName('Bodoe/Glimt'), canonicalName('Bodo/Glimt'));
  assert.equal(canonicalName('Partizan (Srb)'), 'partizan');
  assert.equal(canonicalName('Venezia FC'), 'venezia');
  assert.equal(canonicalName('US Lecce'), 'lecce');
});

test('canonicalName folds the recurring spelling splits onto one form', () => {
  // German and English name the same cities differently, and every provider
  // abbreviates United the same way, so these are token rules rather than
  // per-club aliases.
  assert.equal(canonicalName('FC Bayern Munchen'), canonicalName('Bayern Munich'));
  assert.equal(canonicalName('1. FC Koln'), canonicalName('Cologne'));
  assert.equal(canonicalName('Manchester Utd'), canonicalName('Manchester United'));
  assert.equal(canonicalName('Sheffield Utd'), canonicalName('Sheffield United'));
});

test('canonicalName drops punctuation debris left as single characters', () => {
  // The apostrophe in M'gladbach leaves a stray "m" that contributes no
  // bigrams and only drags the alignment average down.
  assert.equal(canonicalName("M'gladbach"), 'gladbach');
  assert.equal(canonicalName('Borussia M´gladbach'), 'borussia gladbach');
});

test('canonicalName never reduces a name to nothing', () => {
  // Every token is club noise, so the noise filter has to back off.
  assert.notEqual(canonicalName('Athletic Club'), '');
});

test('nameSimilarity connects abbreviations to full names', () => {
  assert.ok(nameSimilarity('Manchester City', 'Man City') > 0.8);
  assert.ok(nameSimilarity('Tottenham Hotspur', 'Spurs') > 0.8);
  assert.ok(nameSimilarity('Bayer Leverkusen', 'Leverkusen') > 0.8);
  assert.ok(nameSimilarity('Wolverhampton Wanderers', 'Wolves') > 0.8);
});

test('nameSimilarity covers provider aliases observed in a real odds run', () => {
  const aliases = [
    ['QPR', 'Queens Park Rangers'],
    ['St. Truiden', 'St. Truidense VV'],
    ['Royale Union SG', 'Union Gilloise'],
    ['St. Liege', 'Standard Liege'],
    ['Ath Bilbao', 'Athletic Bilbao'],
    ['Atl. Madrid', 'Atletico Madrid'],
    ['Dep. A Coruna', 'RC Deportivo De La Coruna'],
    ['Celta Vigo B', 'RC Celta Fortuna'],
    ['St Etienne', 'Saint-Etienne'],
    ['Amedspor', 'Amed Sportif Faaliyetler'],
  ];

  for (const [requested, provider] of aliases) {
    assert.ok(nameSimilarity(requested, provider) >= 0.8, `${requested} should match ${provider}`);
  }
});

test('nameSimilarity separates different clubs that share a city', () => {
  assert.ok(nameSimilarity('Manchester City', 'Manchester United') < 0.72);
  assert.ok(nameSimilarity('AC Milan', 'Inter Milan') < 0.72);
});

// -- scoring -------------------------------------------------------------

test('scoreCandidate detects a fixture stored with the teams reversed', () => {
  const score = scoreCandidate(
    { homeTeam: 'Man City', awayTeam: 'Crystal Palace' },
    event(),
  );
  assert.equal(score.swapped, true);
  assert.ok(score.combined > 0.9);
});

// -- resolution ----------------------------------------------------------

test('resolves a fixture whose names differ from SportyBet spelling', () => {
  const result = resolveFixture(
    { homeTeam: 'Crystal Palace', awayTeam: 'Manchester City', kickoff: KICKOFF },
    [event()],
  );

  assert.equal(result.event?.eventId, 'sr:match:1');
  assert.equal(result.reason, 'name_match');
});

test('a supplied eventId short-circuits matching', () => {
  const result = resolveFixture(
    { homeTeam: 'nothing like it', awayTeam: 'nor this', eventId: 'sr:match:1' },
    [event()],
  );

  assert.equal(result.reason, 'event_id');
  assert.equal(result.score, 1);
});

test('a stale eventId falls back to name matching rather than failing', () => {
  const result = resolveFixture(
    { homeTeam: 'Crystal Palace', awayTeam: 'Man City', kickoff: KICKOFF, eventId: 'sr:match:gone' },
    [event()],
  );

  assert.equal(result.event?.eventId, 'sr:match:1');
  assert.equal(result.reason, 'name_match');
});

test('kickoff gates candidates: a match a day out is not this fixture', () => {
  const result = resolveFixture(
    { homeTeam: 'Crystal Palace', awayTeam: 'Man City', kickoff: KICKOFF + 24 * 60 * 60 * 1000 },
    [event()],
  );

  assert.equal(result.event, null);
  assert.equal(result.reason, 'no_candidate_in_kickoff_window');
});

test('a kickoff moved by a couple of hours still resolves', () => {
  const result = resolveFixture(
    { homeTeam: 'Crystal Palace', awayTeam: 'Man City', kickoff: KICKOFF + 2 * 60 * 60 * 1000 },
    [event()],
  );
  assert.equal(result.event?.eventId, 'sr:match:1');
});

test('both teams must clear the threshold, not just one', () => {
  // The home side matches perfectly, the away side is a different club: this
  // is exactly the shape of a reverse-fixture mismatch.
  const result = resolveFixture(
    { homeTeam: 'Crystal Palace', awayTeam: 'Brentford', kickoff: KICKOFF },
    [event()],
  );

  assert.equal(result.event, null);
  assert.equal(result.reason, 'below_name_threshold');
  assert.equal(result.nearest.eventId, 'sr:match:1', 'the near miss is reported for diagnosis');
});

test('an unrelated event near the kickoff is not reported as a spelling near-match', () => {
  const result = resolveFixture(
    { homeTeam: 'Arsenal', awayTeam: 'Chelsea', kickoff: KICKOFF },
    [event({ homeTeam: 'Everton', awayTeam: 'Man Utd' })],
  );

  assert.equal(result.event, null);
  assert.equal(result.reason, 'no_plausible_name_candidate');
  assert.ok(result.nearest);
});

test('real-run aliases resolve without relaxing the safety thresholds', () => {
  const cases = [
    ['QPR', 'Cardiff', 'Queens Park Rangers', 'Cardiff City'],
    ['St. Truiden', 'Royale Union SG', 'St. Truidense VV', 'Union Gilloise'],
    ['St. Liege', 'Antwerp', 'Standard Liege', 'Royal Antwerp FC'],
    ['Ath Bilbao', 'Atl. Madrid', 'Athletic Bilbao', 'Atletico Madrid'],
    ['Villarreal', 'Dep. A Coruna', 'Villarreal', 'RC Deportivo De La Coruna'],
    ['Celta Vigo B', 'Castellon', 'RC Celta Fortuna', 'CD Castellon'],
    ['Dijon', 'St Etienne', 'Dijon', 'Saint-Etienne'],
    ['Amedspor', 'Trabzonspor', 'Amed Sportif Faaliyetler', 'Trabzonspor'],
  ];

  for (const [homeTeam, awayTeam, providerHome, providerAway] of cases) {
    const result = resolveFixture(
      { homeTeam, awayTeam, kickoff: KICKOFF },
      [event({ homeTeam: providerHome, awayTeam: providerAway })],
    );
    assert.equal(result.reason, 'name_match', `${homeTeam} vs ${awayTeam}`);
  }
});

test('two equally plausible candidates are reported ambiguous, not guessed', () => {
  const result = resolveFixture(
    { homeTeam: 'Racing Club', awayTeam: 'Athletic', kickoff: KICKOFF },
    [
      event({ eventId: 'sr:match:1', homeTeam: 'Racing Club', awayTeam: 'Athletic' }),
      event({ eventId: 'sr:match:2', homeTeam: 'Racing Club', awayTeam: 'Athletic' }),
    ],
  );

  assert.equal(result.event, null);
  assert.equal(result.reason, 'ambiguous_match');
});

test('the competition narrows the pool but does not exclude a fixture we cannot place', () => {
  const events = [
    event({ eventId: 'sr:match:1', competitionKey: 'premier_league' }),
    event({ eventId: 'sr:match:2', competitionKey: null, homeTeam: 'Somebody', awayTeam: 'Else' }),
  ];

  // An uncatalogued competition key matches no event, so the whole slate is
  // scored instead of nothing being considered.
  const result = resolveFixture(
    { homeTeam: 'Crystal Palace', awayTeam: 'Man City', kickoff: KICKOFF, competitionKey: 'not_in_catalog' },
    events,
  );

  assert.equal(result.event?.eventId, 'sr:match:1');
});

test('a fixture with no kickoff still resolves on names alone', () => {
  const result = resolveFixture(
    { homeTeam: 'Crystal Palace', awayTeam: 'Man City' },
    [event()],
  );
  assert.equal(result.event?.eventId, 'sr:match:1');
});

test('an empty slate resolves nothing', () => {
  const result = resolveFixture({ homeTeam: 'A', awayTeam: 'B', kickoff: KICKOFF }, []);
  assert.equal(result.event, null);
  assert.equal(result.candidates, 0);
});

// -- time parsing --------------------------------------------------------

test('toEpochMillis reads the forms ParlayHux and SportyBet each use', () => {
  assert.equal(toEpochMillis('2026-08-28T19:00:00Z'), KICKOFF);
  assert.equal(toEpochMillis('2026-08-28T19:00:00+00:00'), KICKOFF);
  assert.equal(toEpochMillis(KICKOFF), KICKOFF);
  assert.equal(toEpochMillis(String(KICKOFF)), KICKOFF);
  assert.equal(toEpochMillis(new Date(KICKOFF)), KICKOFF);
  assert.equal(toEpochMillis(null), null);
  assert.equal(toEpochMillis('not a date'), null);
});

test('a naive timestamp is read as UTC, not as host local time', () => {
  assert.equal(toEpochMillis('2026-08-28T19:00:00'), KICKOFF);
  assert.equal(toEpochMillis('2026-08-28 19:00:00'), KICKOFF);
});

test('a ten-digit timestamp is seconds', () => {
  assert.equal(toEpochMillis(Math.floor(KICKOFF / 1000)), KICKOFF);
});
