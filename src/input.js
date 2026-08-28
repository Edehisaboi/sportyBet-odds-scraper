/**
 * Input parsing and validation.
 *
 * Validation is strict and happens before any request goes out: a run that has
 * been given a fixture with no teams cannot do anything useful with it, and
 * failing at the top is much easier to diagnose than a dataset that is quietly
 * missing rows.
 */

import { resolveCompetitions } from './competitions.js';
import { DEFAULT_RESOLUTION } from './resolve.js';
import { toEpochMillis } from './util.js';

export const MODES = Object.freeze(['odds', 'events']);
const DEFAULT_MODE = 'odds';

export const DEFAULT_PROXY_CONFIGURATION = Object.freeze({
  useApifyProxy: true,
  apifyProxyGroups: ['BUYPROXIES94952'],
});

export function resolveMode(input = {}) {
  const mode = String(input.mode ?? '').trim();
  if (!mode) return DEFAULT_MODE;
  if (!MODES.includes(mode)) {
    throw new Error(`Unknown mode "${mode}". Expected one of: ${MODES.join(', ')}`);
  }
  return mode;
}

/**
 * Normalise the fixtures to price.
 *
 * Only the two team names are strictly required. `kickoff` is all but
 * required in practice -- without it the time gate cannot run and matching
 * falls back to names alone across the whole slate -- so its absence is
 * recorded on the fixture and surfaced in the run summary.
 */
export function resolveFixtures(input = {}) {
  const raw = Array.isArray(input.fixtures) ? input.fixtures : [];
  if (!raw.length) {
    throw new Error('odds mode requires a non-empty "fixtures" list');
  }

  const seen = new Set();
  const fixtures = [];

  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Fixture at index ${index} must be an object`);
    }

    const homeTeam = String(entry.homeTeam ?? entry.home_team ?? '').trim();
    const awayTeam = String(entry.awayTeam ?? entry.away_team ?? '').trim();
    if (!homeTeam || !awayTeam) {
      throw new Error(`Fixture at index ${index} needs both homeTeam and awayTeam`);
    }

    const kickoffRaw = entry.kickoff ?? entry.kickoffUtc ?? entry.kickoff_utc ?? null;
    const kickoffMillis = toEpochMillis(kickoffRaw);
    if (kickoffRaw && kickoffMillis === null) {
      throw new Error(`Fixture at index ${index} has an unparseable kickoff "${kickoffRaw}"`);
    }

    const fixture = {
      fixtureId: entry.fixtureId ?? entry.fixture_id ?? null,
      externalId: entry.externalId ?? entry.external_id ?? null,
      competitionKey: entry.competitionKey ?? entry.competition_key ?? null,
      eventId: entry.eventId ?? entry.event_id ?? null,
      homeTeam,
      awayTeam,
      kickoff: kickoffMillis,
    };

    // De-duplicate on whatever identity the caller supplied, falling back to
    // the natural key. Fetching one event's 700 markets twice in a run is pure
    // waste and would also write the same odds twice.
    const identity = fixture.eventId
      || fixture.fixtureId
      || fixture.externalId
      || `${homeTeam}|${awayTeam}|${fixture.kickoff ?? ''}`;
    if (seen.has(identity)) return;
    seen.add(identity);

    fixtures.push(fixture);
  });

  return fixtures;
}

/** Competition scope and lookahead for `events` mode. */
export function resolveEventsRun(input = {}) {
  const windowDays = Number.isInteger(input.windowDays) ? input.windowDays : 14;
  if (windowDays < 1 || windowDays > 45) {
    throw new Error(`windowDays must be between 1 and 45, got "${input.windowDays}"`);
  }

  // No competitions means the whole slate, which is the useful default here:
  // `events` mode exists to discover what SportyBet actually carries.
  const requested = input.competitions;
  const hasScope = requested === 'all' || (Array.isArray(requested) && requested.length);
  const competitions = hasScope ? resolveCompetitions(requested) : [];

  return { competitions, windowDays };
}

/** Matching thresholds, overridable per run for tuning against a real slate. */
export function resolveMatchingOptions(input = {}) {
  const supplied = input.matching && typeof input.matching === 'object' ? input.matching : {};
  const settings = { ...DEFAULT_RESOLUTION };

  for (const key of Object.keys(DEFAULT_RESOLUTION)) {
    if (supplied[key] === undefined) continue;
    const value = Number(supplied[key]);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`matching.${key} must be a non-negative number, got "${supplied[key]}"`);
    }
    settings[key] = value;
  }

  return settings;
}

export function normalizeProxyConfiguration(proxyConfiguration) {
  if (!proxyConfiguration || typeof proxyConfiguration !== 'object') {
    return DEFAULT_PROXY_CONFIGURATION;
  }
  if (proxyConfiguration.apifyProxyGroups && !proxyConfiguration.groups) {
    return { ...proxyConfiguration, groups: proxyConfiguration.apifyProxyGroups };
  }
  return proxyConfiguration;
}
