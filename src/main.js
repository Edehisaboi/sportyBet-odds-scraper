import { Actor, log } from 'apify';
import pLimit from 'p-limit';

import { fetchEvent } from './api.js';
import { buildEventRow, buildFixtureOddsRow, EVENT_FIELDS, FIXTURE_ODDS_FIELDS, summarizeCoverage } from './buildRow.js';
import { SPORT_ID } from './competitions.js';
import { fetchEventIndex } from './events.js';
import {
  DEFAULT_PROXY_CONFIGURATION,
  normalizeProxyConfiguration,
  resolveEventsRun,
  resolveFixtures,
  resolveMatchingOptions,
  resolveMode,
} from './input.js';
import { mapEventMarkets } from './markets.js';
import { resolveFixture } from './resolve.js';
import { logInfo, logWarning } from './util.js';

await Actor.main(async () => {
  const input = (await Actor.getInput()) ?? {};
  const mode = resolveMode(input);
  const maxConcurrency = Number.isInteger(input.maxConcurrency) ? input.maxConcurrency : 5;
  const proxyInput = normalizeProxyConfiguration(input.proxyConfiguration ?? DEFAULT_PROXY_CONFIGURATION);
  const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

  const context = { input, proxyConfiguration, maxConcurrency, log };

  if (mode === 'events') {
    await runEvents(context);
    return;
  }

  await runOdds(context);
});

/**
 * Discovery: what SportyBet is currently carrying.
 *
 * Exists to answer the questions that come up when a fixture fails to resolve
 * -- is the competition on the site at all, under what tournament id, spelling
 * its clubs how -- and to verify the tournament ids in the catalog against a
 * live slate.
 */
async function runEvents({ input, proxyConfiguration, log }) {
  const { competitions, windowDays } = resolveEventsRun(input);
  const startedAt = new Date().toISOString();

  await Actor.setStatusMessage('Fetching SportyBet upcoming events');
  const index = await fetchEventIndex({ sportId: SPORT_ID, proxyConfiguration, log });

  const horizonMillis = Date.now() + windowDays * 24 * 60 * 60 * 1000;
  const wantedKeys = new Set(competitions.map((competition) => competition.key));

  // Anything outside the catalog is dropped, including the ~290 tournaments
  // SportyBet carries that ParlayHux does not price: an event with no
  // competition key is not something the backend could use.
  const selected = index.events.filter((event) => {
    if (event.kickoffMillis !== null && event.kickoffMillis > horizonMillis) return false;
    return wantedKeys.has(event.competitionKey);
  });

  selected.sort((first, second) => (first.kickoffMillis ?? 0) - (second.kickoffMillis ?? 0));
  const rows = selected.map(buildEventRow);
  if (rows.length) await Actor.pushData(rows);

  // Reporting the catalog entries that matched nothing is the point of asking
  // for specific competitions: a zero here is how a stale tournament id shows.
  const foundKeys = new Set(selected.map((event) => event.competitionKey).filter(Boolean));
  const perCompetition = competitions.map((competition) => ({
    competition: competition.key,
    tournamentId: competition.tournamentId,
    events: selected.filter((event) => event.competitionKey === competition.key).length,
  }));
  const missing = competitions.filter((competition) => !foundKeys.has(competition.key)).map((item) => item.key);

  if (missing.length) {
    logWarning(log, 'Competitions with no events in the SportyBet slate', { missing });
  }

  const output = {
    mode: 'events',
    generatedAt: new Date().toISOString(),
    startedAt,
    windowDays,
    indexedEvents: index.events.length,
    reportedTotal: index.totalNum,
    pagesFetched: index.pagesFetched,
    indexFailures: index.failures,
    competitions: perCompetition,
    competitionsWithNoEvents: missing,
    totalRows: rows.length,
    columns: EVENT_FIELDS,
  };

  await Actor.setValue('OUTPUT', output);
  await Actor.setStatusMessage(`Finished: ${rows.length} events`);
  logInfo(log, 'Events run summary', output);
}

/**
 * The main job: prices for a named set of fixtures.
 *
 * The index is built once and shared by every fixture, so the per-fixture cost
 * is a single request for that event's markets. Resolution happens up front and
 * in full before any odds are fetched, which keeps the two failure modes --
 * "we could not find this match" and "we found it but the fetch failed" --
 * cleanly separated in the summary.
 */
async function runOdds({ input, proxyConfiguration, maxConcurrency, log }) {
  const fixtures = resolveFixtures(input);
  const matching = resolveMatchingOptions(input);
  const startedAt = new Date().toISOString();

  await Actor.setStatusMessage(`Resolving ${fixtures.length} fixture(s) against SportyBet`);
  const index = await fetchEventIndex({ sportId: SPORT_ID, proxyConfiguration, log });

  if (!index.events.length) {
    // Without an index nothing can resolve, and emitting a full set of
    // "unmatched" rows would misreport a fetch failure as SportyBet not
    // carrying any of these matches.
    throw new Error('SportyBet returned no upcoming events; cannot resolve any fixture.');
  }

  const resolutions = fixtures.map((fixture) => ({
    fixture,
    resolution: resolveFixture(fixture, index.events, matching),
  }));

  const matched = resolutions.filter((entry) => entry.resolution.event);
  logInfo(log, 'Fixture resolution complete', {
    requested: fixtures.length,
    matched: matched.length,
    unmatched: fixtures.length - matched.length,
  });

  const limit = pLimit(maxConcurrency);
  const failures = [];

  await Actor.setStatusMessage(`Fetching odds for ${matched.length} matched fixture(s)`);

  const rows = await Promise.all(resolutions.map(({ fixture, resolution }) => limit(async () => {
    if (!resolution.event) {
      logWarning(log, `Unresolved fixture: ${fixture.homeTeam} vs ${fixture.awayTeam}`, {
        reason: resolution.reason,
        nearest: resolution.nearest,
        runnerUp: resolution.runnerUp,
      });
      return buildFixtureOddsRow({
        fixture,
        resolution,
        capturedAt: new Date().toISOString(),
      });
    }

    const eventId = resolution.event.eventId;
    try {
      const event = await fetchEvent(eventId, { proxyConfiguration, log });
      const quotes = mapEventMarkets(event?.markets);
      const capturedAt = new Date().toISOString();

      if (!quotes.length) {
        // Resolved but unpriced: the event exists and has markets, none of
        // which are ones we price. Worth distinguishing from a failed fetch.
        logWarning(log, `No priceable markets for ${eventId}`, {
          fixture: `${fixture.homeTeam} vs ${fixture.awayTeam}`,
          totalMarketSize: event?.markets?.length ?? 0,
        });
      }

      return buildFixtureOddsRow({
        fixture,
        resolution,
        event: {
          gameId: event?.gameId ?? null,
          totalMarketSize: event?.markets?.length ?? null,
        },
        quotes,
        capturedAt,
      });
    } catch (error) {
      failures.push({ eventId, fixture: `${fixture.homeTeam} vs ${fixture.awayTeam}`, message: error.message });
      logWarning(log, `Odds fetch failed for ${eventId}`, { message: error.message });

      return buildFixtureOddsRow({
        fixture,
        resolution,
        quotes: [],
        capturedAt: new Date().toISOString(),
        error: error.message,
      });
    }
  })));

  if (rows.length) await Actor.pushData(rows);

  const priced = rows.filter((row) => row.quote_count > 0);
  const output = {
    mode: 'odds',
    generatedAt: new Date().toISOString(),
    startedAt,
    finishedAt: new Date().toISOString(),
    fixturesRequested: fixtures.length,
    fixturesMatched: matched.length,
    fixturesUnmatched: fixtures.length - matched.length,
    fixturesPriced: priced.length,
    // Matched, fetched, and still without a single quote we price.
    fixturesUnpriced: matched.length - priced.length - failures.length,
    fetchFailures: failures.length,
    failures,
    unmatched: rows
      .filter((row) => !row.matched)
      .map((row) => ({
        fixture: `${row.requested_home_team} vs ${row.requested_away_team}`,
        kickoff: row.requested_kickoff_utc,
        competition: row.competition_key,
        reason: row.match_reason,
      })),
    totalQuotes: rows.reduce((total, row) => total + row.quote_count, 0),
    marketCoverage: summarizeCoverage(rows),
    indexedEvents: index.events.length,
    indexPagesFetched: index.pagesFetched,
    indexFailures: index.failures,
    totalRows: rows.length,
    columns: FIXTURE_ODDS_FIELDS,
  };

  await Actor.setValue('OUTPUT', output);
  await Actor.setStatusMessage(
    `Finished: ${priced.length}/${fixtures.length} fixtures priced, ${output.totalQuotes} quotes`,
  );
  logInfo(log, 'Odds run summary', output);
}
