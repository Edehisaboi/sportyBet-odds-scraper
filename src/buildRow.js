/**
 * Dataset row shapes.
 *
 * One row per requested fixture, matched or not. Emitting the unmatched ones
 * is deliberate: the caller asked about a specific fixture and "SportyBet does
 * not have this" is an answer it needs, whereas a silently short dataset looks
 * identical to a run that half failed.
 *
 * Quotes are nested rather than flattened to one row per selection. A fixture
 * yields 40-60 quotes, and the caller writes them as a batch against one
 * fixture id, so the natural unit of transfer is the fixture.
 */

import { MARKET } from './markets.js';
import { toIso } from './util.js';

export const BOOKMAKER = 'sportybet';

export const FIXTURE_ODDS_FIELDS = Object.freeze([
  'fixture_id', 'external_id', 'competition_key', 'bookmaker',
  'event_id', 'game_id', 'home_team', 'away_team', 'kickoff_utc',
  'requested_home_team', 'requested_away_team', 'requested_kickoff_utc',
  'matched', 'match_reason', 'match_score', 'teams_swapped',
  'tournament_id', 'tournament_name', 'category_name',
  'total_market_size', 'quote_count', 'markets_covered',
  'captured_at', 'quotes', 'error',
]);

export const EVENT_FIELDS = Object.freeze([
  'event_id', 'game_id', 'competition_key', 'tournament_id', 'tournament_name',
  'category_id', 'category_name', 'home_team', 'away_team',
  'home_team_id', 'away_team_id', 'kickoff_utc', 'match_status', 'total_market_size',
]);

/** A row describing one SportyBet event, for `events` mode. */
export function buildEventRow(event) {
  return {
    event_id: event.eventId,
    game_id: event.gameId,
    competition_key: event.competitionKey,
    tournament_id: event.tournamentId,
    tournament_name: event.tournamentName,
    category_id: event.categoryId,
    category_name: event.categoryName,
    home_team: event.homeTeam,
    away_team: event.awayTeam,
    home_team_id: event.homeTeamId,
    away_team_id: event.awayTeamId,
    kickoff_utc: toIso(event.kickoffMillis),
    match_status: event.matchStatus,
    total_market_size: event.totalMarketSize,
  };
}

/**
 * A row carrying one fixture's odds, or the reason there are none.
 *
 * `markets_covered` is the count of distinct markets actually priced, which is
 * the quickest way to spot a fixture that resolved but came back thin -- a
 * lower-division match with no corners or first-half team totals, say.
 */
export function buildFixtureOddsRow({ fixture, resolution, event, quotes, capturedAt, error }) {
  const matchedEvent = resolution?.event ?? null;
  const distinctMarkets = new Set((quotes ?? []).map((quote) => quote.market));

  return {
    fixture_id: fixture.fixtureId,
    external_id: fixture.externalId,
    competition_key: fixture.competitionKey ?? matchedEvent?.competitionKey ?? null,
    bookmaker: BOOKMAKER,

    event_id: matchedEvent?.eventId ?? null,
    game_id: event?.gameId ?? matchedEvent?.gameId ?? null,
    // The names and kickoff SportyBet holds, which is what the odds actually
    // belong to -- kept separate from what the caller asked for so a marginal
    // match can be audited after the fact.
    home_team: matchedEvent?.homeTeam ?? null,
    away_team: matchedEvent?.awayTeam ?? null,
    kickoff_utc: toIso(matchedEvent?.kickoffMillis),

    requested_home_team: fixture.homeTeam,
    requested_away_team: fixture.awayTeam,
    requested_kickoff_utc: toIso(fixture.kickoff),

    matched: Boolean(matchedEvent),
    match_reason: resolution?.reason ?? null,
    match_score: resolution?.score !== undefined ? Number(resolution.score.toFixed(3)) : null,
    teams_swapped: Boolean(resolution?.swapped),

    tournament_id: matchedEvent?.tournamentId ?? null,
    tournament_name: matchedEvent?.tournamentName ?? null,
    category_name: matchedEvent?.categoryName ?? null,

    total_market_size: event?.totalMarketSize ?? matchedEvent?.totalMarketSize ?? null,
    quote_count: quotes?.length ?? 0,
    markets_covered: distinctMarkets.size,

    captured_at: capturedAt,
    quotes: quotes ?? [],
    error: error ?? null,
  };
}

/** Per-market quote counts across a run, for the summary. */
export function summarizeCoverage(rows) {
  const coverage = Object.fromEntries(Object.values(MARKET).map((market) => [market, 0]));

  for (const row of rows) {
    for (const quote of row.quotes ?? []) {
      if (coverage[quote.market] !== undefined) coverage[quote.market] += 1;
    }
  }

  return coverage;
}
