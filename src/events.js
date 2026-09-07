/**
 * Building the index of SportyBet events that fixtures are resolved against.
 *
 * `pcUpcomingEvents` pages through every upcoming football event on the site --
 * on the order of 1,300 across 200+ tournaments, covering about seven weeks
 * ahead -- in a dozen or so pages with no overlap between them. Pulling the
 * whole index once per run and matching in memory is both cheaper and more
 * reliable than a lookup per fixture, and it is what lets a fixture in an
 * uncatalogued competition still resolve.
 *
 * `fetchUpcomingPage` asks for the complete list rather than the site's
 * highlights view; see the comment there for what that is worth.
 */

import { competitionKeyForTournament, SPORT_ID } from './competitions.js';
import { fetchUpcomingPage } from './api.js';
import { canonicalName, logInfo, logWarning } from './util.js';

// The feed reports pageSize but honours it loosely -- it pages by tournament,
// so a page holds 40-100 events. This is a stop, not an expectation.
const MAX_PAGES = 60;
const EMPTY_PAGE_STOP_COUNT = 2;

/** Flatten one page's tournament groups into plain event records. */
export function flattenPage(page) {
  const events = [];

  for (const tournament of page?.tournaments ?? []) {
    for (const event of tournament.events ?? []) {
      const category = event.sport?.category ?? {};
      events.push({
        eventId: event.eventId,
        gameId: event.gameId ?? null,
        homeTeam: event.homeTeamName ?? '',
        awayTeam: event.awayTeamName ?? '',
        homeTeamId: event.homeTeamId ?? null,
        awayTeamId: event.awayTeamId ?? null,
        kickoffMillis: Number(event.estimateStartTime) || null,
        matchStatus: event.matchStatus ?? '',
        status: Number(event.status ?? 0),
        totalMarketSize: Number(event.totalMarketSize ?? 0),
        tournamentId: tournament.id ?? category.tournament?.id ?? null,
        tournamentName: tournament.name ?? category.tournament?.name ?? '',
        categoryId: tournament.categoryId ?? category.id ?? null,
        categoryName: tournament.categoryName ?? category.name ?? '',
        competitionKey: competitionKeyForTournament(tournament.id ?? category.tournament?.id),
        // Precomputed once here rather than per comparison: resolving a slate
        // of 200 fixtures against 1,300 events is 260,000 comparisons.
        homeCanonical: canonicalName(event.homeTeamName),
        awayCanonical: canonicalName(event.awayTeamName),
      });
    }
  }

  return events;
}

/**
 * Walk the whole upcoming index.
 *
 * Pages are fetched in order and stop after two consecutive empty responses.
 * One empty response can be a transient upstream hole; requiring confirmation
 * prevents it from silently truncating the index. A page that still fails after
 * the API client's retries fails the run because continuing would misreport the
 * missing page as dozens of fixtures absent from the bookmaker.
 */
export async function fetchEventIndex(options = {}) {
  const {
    sportId = SPORT_ID,
    maxPages = MAX_PAGES,
    emptyPageStopCount = EMPTY_PAGE_STOP_COUNT,
    fetchPage = fetchUpcomingPage,
    log,
  } = options;
  const byEventId = new Map();
  let pagesFetched = 0;
  let consecutiveEmptyPages = 0;
  let totalNum = null;
  const failures = [];

  for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
    let page;
    try {
      page = await fetchPage({ sportId, pageNum }, { ...options, sessionId: `index_${pageNum}` });
    } catch (error) {
      logWarning(log, `Upcoming index page ${pageNum} failed`, { message: error.message });
      failures.push({ pageNum, message: error.message });
      throw error;
    }

    pagesFetched += 1;
    if (totalNum === null && Number.isFinite(Number(page?.totalNum))) totalNum = Number(page.totalNum);

    const events = flattenPage(page);
    if (!events.length) {
      consecutiveEmptyPages += 1;
      if (consecutiveEmptyPages >= emptyPageStopCount) break;
      continue;
    }
    consecutiveEmptyPages = 0;

    for (const event of events) {
      if (event.eventId) byEventId.set(event.eventId, event);
    }
  }

  const events = [...byEventId.values()];
  logInfo(log, 'Built SportyBet event index', {
    events: events.length,
    pagesFetched,
    reportedTotal: totalNum,
    failedPages: failures.length,
  });

  // The feed tells us how many events it has. An index short of that is a
  // truncated index, and every fixture in the gap is about to be reported as
  // not offered by the bookmaker -- which is exactly how a request parameter
  // capping each tournament at ten events went unnoticed. Say so loudly rather
  // than let the resolution rate absorb it.
  if (totalNum !== null && events.length < totalNum) {
    logWarning(log, 'SportyBet index is short of the reported total', {
      collected: events.length,
      reportedTotal: totalNum,
      missing: totalNum - events.length,
      pagesFetched,
    });
  }

  return { events, pagesFetched, totalNum, failures };
}

/** Group an index by competition key, for per-competition reporting. */
export function indexByCompetition(events) {
  const grouped = new Map();
  for (const event of events) {
    const key = event.competitionKey ?? `_${event.tournamentId}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(event);
  }
  return grouped;
}
