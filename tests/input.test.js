import assert from 'node:assert/strict';
import test from 'node:test';

import { competitionKeyForTournament, getCompetition, resolveCompetitions } from '../src/competitions.js';
import { flattenPage } from '../src/events.js';
import {
  normalizeProxyConfiguration,
  resolveEventsRun,
  resolveFixtures,
  resolveMatchingOptions,
  resolveMode,
} from '../src/input.js';
import { buildFixtureOddsRow, summarizeCoverage } from '../src/buildRow.js';

// -- mode ----------------------------------------------------------------

test('resolveMode defaults to odds and rejects unknown modes', () => {
  assert.equal(resolveMode({}), 'odds');
  assert.equal(resolveMode({ mode: 'events' }), 'events');
  assert.throws(() => resolveMode({ mode: 'fixtures' }), /Unknown mode/);
});

// -- fixtures ------------------------------------------------------------

test('resolveFixtures accepts both camelCase and snake_case keys', () => {
  const [fixture] = resolveFixtures({
    fixtures: [{
      fixture_id: 'abc',
      external_id: 'fs-1',
      competition_key: 'premier_league',
      home_team: 'Crystal Palace',
      away_team: 'Man City',
      kickoff_utc: '2026-08-28T19:00:00Z',
    }],
  });

  assert.equal(fixture.fixtureId, 'abc');
  assert.equal(fixture.externalId, 'fs-1');
  assert.equal(fixture.competitionKey, 'premier_league');
  assert.equal(fixture.kickoff, Date.parse('2026-08-28T19:00:00Z'));
});

test('resolveFixtures rejects a run it cannot do anything with', () => {
  assert.throws(() => resolveFixtures({}), /non-empty/);
  assert.throws(() => resolveFixtures({ fixtures: [] }), /non-empty/);
  assert.throws(() => resolveFixtures({ fixtures: [{ homeTeam: 'A' }] }), /both homeTeam and awayTeam/);
  assert.throws(
    () => resolveFixtures({ fixtures: [{ homeTeam: 'A', awayTeam: 'B', kickoff: 'soon' }] }),
    /unparseable kickoff/,
  );
});

test('resolveFixtures drops duplicates so an event is not fetched twice', () => {
  const fixtures = resolveFixtures({
    fixtures: [
      { fixtureId: 'a', homeTeam: 'A', awayTeam: 'B' },
      { fixtureId: 'a', homeTeam: 'A', awayTeam: 'B' },
      { homeTeam: 'A', awayTeam: 'B' },
      { homeTeam: 'C', awayTeam: 'D' },
    ],
  });

  assert.equal(fixtures.length, 3);
});

test('a fixture may omit kickoff', () => {
  const [fixture] = resolveFixtures({ fixtures: [{ homeTeam: 'A', awayTeam: 'B' }] });
  assert.equal(fixture.kickoff, null);
});

// -- matching options ----------------------------------------------------

test('resolveMatchingOptions overrides only what was supplied', () => {
  const settings = resolveMatchingOptions({ matching: { minMargin: 0.2 } });
  assert.equal(settings.minMargin, 0.2);
  assert.equal(settings.minNameScore, 0.72, 'untouched defaults survive');
});

test('resolveMatchingOptions rejects nonsense thresholds', () => {
  assert.throws(() => resolveMatchingOptions({ matching: { minMargin: 'lots' } }), /non-negative/);
  assert.throws(() => resolveMatchingOptions({ matching: { minNameScore: -1 } }), /non-negative/);
});

// -- competitions --------------------------------------------------------

test('the competition catalog round-trips key <-> tournament id', () => {
  assert.equal(getCompetition('premier_league').tournamentId, 'sr:tournament:17');
  assert.equal(competitionKeyForTournament('sr:tournament:17'), 'premier_league');
  assert.equal(competitionKeyForTournament('sr:tournament:999999'), null);
  assert.equal(getCompetition('nope'), null);
});

test('resolveCompetitions expands "all" and rejects unknown keys', () => {
  assert.ok(resolveCompetitions('all').length >= 18);
  assert.deepEqual(resolveCompetitions(['serie_a']).map((item) => item.key), ['serie_a']);
  assert.throws(() => resolveCompetitions(['ligue_9']), /Unknown competition/);
});

test('resolveEventsRun bounds the lookahead window', () => {
  assert.equal(resolveEventsRun({}).windowDays, 14);
  assert.equal(resolveEventsRun({ windowDays: 3 }).windowDays, 3);
  assert.throws(() => resolveEventsRun({ windowDays: 90 }), /windowDays must be between/);
});

test('resolveEventsRun with no competitions means the whole slate', () => {
  assert.deepEqual(resolveEventsRun({}).competitions, []);
});

// -- feed flattening -----------------------------------------------------

test('flattenPage lifts events out of their tournament groups', () => {
  const events = flattenPage({
    tournaments: [{
      id: 'sr:tournament:17',
      name: 'Premier League',
      categoryId: 'sr:category:1',
      categoryName: 'England',
      events: [{
        eventId: 'sr:match:1',
        gameId: '37166',
        homeTeamName: 'Crystal Palace',
        awayTeamName: 'Man City',
        estimateStartTime: 1787943600000,
        totalMarketSize: 1519,
        sport: { category: { id: 'sr:category:1', tournament: { id: 'sr:tournament:17' } } },
      }],
    }],
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].competitionKey, 'premier_league');
  assert.equal(events[0].kickoffMillis, 1787943600000);
  assert.equal(events[0].homeCanonical, 'crystal palace');
});

test('flattenPage tolerates an empty page', () => {
  assert.deepEqual(flattenPage({}), []);
  assert.deepEqual(flattenPage(undefined), []);
});

// -- rows ----------------------------------------------------------------

test('an unmatched fixture still produces a row explaining itself', () => {
  const row = buildFixtureOddsRow({
    fixture: { fixtureId: 'a', homeTeam: 'A', awayTeam: 'B', kickoff: null, competitionKey: 'serie_a' },
    resolution: { event: null, reason: 'below_name_threshold', score: 0.4, swapped: false },
    capturedAt: '2026-08-28T18:00:00.000Z',
  });

  assert.equal(row.matched, false);
  assert.equal(row.match_reason, 'below_name_threshold');
  assert.equal(row.quote_count, 0);
  assert.equal(row.event_id, null);
  assert.equal(row.requested_home_team, 'A');
  assert.equal(row.bookmaker, 'sportybet');
});

test('a matched row reports SportyBet names alongside the requested ones', () => {
  const row = buildFixtureOddsRow({
    fixture: { fixtureId: 'a', homeTeam: 'Crystal Palace', awayTeam: 'Manchester City', kickoff: null },
    resolution: {
      event: {
        eventId: 'sr:match:1',
        homeTeam: 'Crystal Palace',
        awayTeam: 'Man City',
        kickoffMillis: Date.parse('2026-08-28T19:00:00Z'),
        competitionKey: 'premier_league',
        tournamentId: 'sr:tournament:17',
      },
      reason: 'name_match',
      score: 0.94,
      swapped: false,
    },
    quotes: [
      { market: 'match_result', selection: 'home', line: null, price: 5.38 },
      { market: 'btts', selection: 'yes', line: null, price: 1.72 },
    ],
    capturedAt: '2026-08-28T18:00:00.000Z',
  });

  assert.equal(row.matched, true);
  assert.equal(row.away_team, 'Man City');
  assert.equal(row.requested_away_team, 'Manchester City');
  assert.equal(row.kickoff_utc, '2026-08-28T19:00:00.000Z');
  assert.equal(row.quote_count, 2);
  assert.equal(row.markets_covered, 2);
});

test('summarizeCoverage counts quotes per market across the run', () => {
  const coverage = summarizeCoverage([
    { quotes: [{ market: 'match_result' }, { market: 'match_result' }, { market: 'btts' }] },
    { quotes: [{ market: 'btts' }] },
    { quotes: [] },
  ]);

  assert.equal(coverage.match_result, 2);
  assert.equal(coverage.btts, 2);
  assert.equal(coverage.corners_over_under, 0, 'every market is reported, including the empty ones');
});

// -- proxy ---------------------------------------------------------------

test('normalizeProxyConfiguration maps apifyProxyGroups onto groups', () => {
  assert.deepEqual(
    normalizeProxyConfiguration({ useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] }),
    { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'], groups: ['RESIDENTIAL'] },
  );
  assert.equal(normalizeProxyConfiguration(null).useApifyProxy, true);
});
