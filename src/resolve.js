/**
 * Matching a ParlayHux fixture to a SportyBet event.
 *
 * The two systems share no identifier. ParlayHux fixtures are keyed by
 * Flashscore match id; SportyBet is a Sportradar shop keyed by `sr:match:N`.
 * So a fixture is identified by what both sides do agree on -- the two club
 * names and the kickoff time -- and the job here is to do that without ever
 * confidently returning the wrong match.
 *
 * Three rules keep it honest:
 *
 *   1. Kickoff is a gate, not a score. A candidate outside the time window is
 *      not considered at all, however well its names read.
 *   2. Both teams must clear the name threshold. One strong side is how a
 *      derby gets mismatched onto the reverse fixture.
 *   3. The winner must beat the runner-up by a margin. Two candidates that
 *      score alike mean the evidence does not actually distinguish them, and
 *      an ambiguous result is reported unresolved rather than guessed.
 *
 * Everything a rejection turns on is reported back on the row, so an
 * unmatched fixture can be diagnosed from the dataset without a re-run.
 */

import { nameSimilarity, toEpochMillis } from './util.js';

export const DEFAULT_RESOLUTION = Object.freeze({
  // Kickoff times agree closely between providers; the slack is for a fixture
  // moved after our last fixtures ingest, not for timezone error.
  kickoffToleranceMinutes: 360,
  // Below this a name pair is not evidence of anything.
  minNameScore: 0.72,
  // And the pair average has to be comfortably better than the floor.
  minCombinedScore: 0.80,
  // Below this, even the best event in the kickoff window is just a coincidental
  // neighbour rather than a meaningful name near-match. Keeping this separate
  // from the acceptance thresholds makes "not listed" distinguishable from an
  // alias or spelling problem.
  minPlausibleScore: 0.40,
  // How far clear of the runner-up the winner must be.
  minMargin: 0.06,
});

/** Score one fixture against one candidate event, ignoring the time gate. */
export function scoreCandidate(fixture, event) {
  const straight = {
    home: nameSimilarity(fixture.homeTeam, event.homeTeam),
    away: nameSimilarity(fixture.awayTeam, event.awayTeam),
    swapped: false,
  };

  // Also scored the other way round so a fixture stored with the teams
  // reversed is detected and reported, rather than silently scoring badly.
  const reversed = {
    home: nameSimilarity(fixture.homeTeam, event.awayTeam),
    away: nameSimilarity(fixture.awayTeam, event.homeTeam),
    swapped: true,
  };

  const best = (straight.home + straight.away) >= (reversed.home + reversed.away) ? straight : reversed;

  return {
    homeScore: best.home,
    awayScore: best.away,
    combined: (best.home + best.away) / 2,
    weakest: Math.min(best.home, best.away),
    swapped: best.swapped,
  };
}

/**
 * Find the SportyBet event for one fixture.
 *
 * Returns { event, score, reason } with `event` null when nothing qualified.
 * `reason` names the rule that stopped it.
 */
export function resolveFixture(fixture, events, options = {}) {
  const settings = { ...DEFAULT_RESOLUTION, ...options };
  const kickoffMillis = toEpochMillis(fixture.kickoff);

  // A caller that already knows the event id -- because a previous run
  // resolved it and ParlayHux stored it -- skips matching entirely. This is
  // the cheap, exact path, and it is why resolution cost falls away over time.
  if (fixture.eventId) {
    const known = events.find((event) => event.eventId === fixture.eventId);
    if (known) {
      return {
        event: known,
        score: 1,
        homeScore: 1,
        awayScore: 1,
        weakestScore: 1,
        reason: 'event_id',
        swapped: false,
        candidates: 1,
      };
    }
    // A supplied id that is not in the upcoming index is stale (the match has
    // started, or been removed); fall through and try to match it afresh.
  }

  const scoped = scopeToCompetition(fixture, events);
  const outcome = attempt(fixture, scoped, kickoffMillis, settings);

  // A scoped failure is retried against the whole slate. The competition is a
  // hint, not a fact: our key may be missing from the catalog, SportyBet files
  // qualifiers and cup ties under tournaments of their own, and a fixture can
  // simply be bucketed somewhere we did not predict. Narrowing first and then
  // giving up inside that narrow pool reported "not on the slate" for events
  // that were on it all along. The thresholds below are unchanged, so widening
  // the pool cannot lower the bar -- only widen what is considered.
  if (!outcome.event && scoped.length !== events.length) {
    return attempt(fixture, events, kickoffMillis, settings);
  }
  return outcome;
}

/** The fixture's own competition, when we know it and SportyBet carries it. */
function scopeToCompetition(fixture, events) {
  if (!fixture.competitionKey) return events;
  const scoped = events.filter((event) => event.competitionKey === fixture.competitionKey);
  return scoped.length ? scoped : events;
}

/** Gate by kickoff, score what is left, and apply the acceptance rules. */
function attempt(fixture, candidates, kickoffMillis, settings) {
  let pool = candidates;

  if (kickoffMillis !== null) {
    const toleranceMillis = settings.kickoffToleranceMinutes * 60 * 1000;
    const withinWindow = pool.filter((event) => (
      event.kickoffMillis !== null && Math.abs(event.kickoffMillis - kickoffMillis) <= toleranceMillis
    ));
    if (!withinWindow.length) {
      return {
        event: null,
        score: 0,
        reason: 'no_candidate_in_kickoff_window',
        swapped: false,
        candidates: 0,
        // Scored only on this path, so the common case still pays for the time
        // gate first. Without it the rejection said nothing at all, and every
        // one of them had to be diagnosed by hand: this names the closest
        // event by name whatever its kickoff, which is what separates "not
        // listed by the bookmaker" from "listed, but our kickoff is wrong".
        nearest: nearestByName(fixture, pool, kickoffMillis),
      };
    }
    pool = withinWindow;
  }

  if (!pool.length) {
    return { event: null, score: 0, reason: 'no_candidates', swapped: false, candidates: 0 };
  }

  const scored = pool
    .map((event) => ({ event, ...scoreCandidate(fixture, event) }))
    .sort((first, second) => second.combined - first.combined);

  const best = scored[0];
  const runnerUp = scored[1];

  if (best.weakest < settings.minNameScore || best.combined < settings.minCombinedScore) {
    return {
      event: null,
      score: best.combined,
      homeScore: best.homeScore,
      awayScore: best.awayScore,
      weakestScore: best.weakest,
      reason: best.combined < settings.minPlausibleScore
        ? 'no_plausible_name_candidate'
        : 'below_name_threshold',
      swapped: best.swapped,
      candidates: scored.length,
      nearest: describe(best, kickoffMillis),
    };
  }

  if (runnerUp && (best.combined - runnerUp.combined) < settings.minMargin) {
    return {
      event: null,
      score: best.combined,
      homeScore: best.homeScore,
      awayScore: best.awayScore,
      weakestScore: best.weakest,
      reason: 'ambiguous_match',
      swapped: best.swapped,
      candidates: scored.length,
      nearest: describe(best, kickoffMillis),
      runnerUp: describe(runnerUp, kickoffMillis),
    };
  }

  return {
    event: best.event,
    score: best.combined,
    homeScore: best.homeScore,
    awayScore: best.awayScore,
    weakestScore: best.weakest,
    reason: best.swapped ? 'name_match_teams_swapped' : 'name_match',
    swapped: best.swapped,
    candidates: scored.length,
  };
}

/** The best name match on a slate, ignoring kickoff entirely. */
function nearestByName(fixture, events, kickoffMillis) {
  if (!events.length) return null;
  let best = null;
  for (const event of events) {
    const scored = { event, ...scoreCandidate(fixture, event) };
    if (!best || scored.combined > best.combined) best = scored;
  }
  return describe(best, kickoffMillis);
}

function describe(candidate, kickoffMillis = null) {
  const eventKickoff = candidate.event.kickoffMillis;
  return {
    eventId: candidate.event.eventId,
    homeTeam: candidate.event.homeTeam,
    awayTeam: candidate.event.awayTeam,
    kickoffMillis: eventKickoff,
    // How far this candidate sits from the fixture we were asked about. The
    // one number that says whether a rejection was about names or about time.
    kickoffDeltaMinutes: (kickoffMillis === null || eventKickoff === null)
      ? null
      : Math.round((eventKickoff - kickoffMillis) / 60000),
    competitionKey: candidate.event.competitionKey,
    tournamentName: candidate.event.tournamentName,
    homeScore: Number(candidate.homeScore.toFixed(3)),
    awayScore: Number(candidate.awayScore.toFixed(3)),
    weakestScore: Number(candidate.weakest.toFixed(3)),
    combined: Number(candidate.combined.toFixed(3)),
  };
}
