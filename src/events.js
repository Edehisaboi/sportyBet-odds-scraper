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

// One walk of the pages does not see the whole slate. `pcUpcomingEvents` is
// served from replicas that disagree about how much data exists -- consecutive
// requests report totals of 1191, 1211 and 1558 -- and pagination is by offset
// over a dataset whose size and ordering differ per replica, so page 4 from one
// node re-serves rows page 2 already took from another. Measured: 1300 events
// fetched, 903 unique, and single-pass coverage swinging between 977 and 1247
// against a true slate of ~1558.
//
// The union across repeated walks does converge, because a different draw
// exposes different rows. Five passes is the measured cost of reaching the full
// slate; the loop stops as soon as a whole pass adds nothing, so a feed that
// ever becomes consistent settles in two.
//
// This is not tuning. An index short of the slate reports every fixture in the
// gap as not offered by the bookmaker, which is what put 73 of 75 fixtures on
// one run's unmatched list.
const MAX_INDEX_PASSES = 8;

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
 * One walk of the pages, collected into `byEventId`.
 *
 * Pages are fetched in order and stop after two consecutive empty responses.
 * One empty response can be a transient upstream hole; requiring confirmation
 * prevents it from silently truncating the pass. A page that still fails after
 * the API client's retries fails the run because continuing would misreport the
 * missing page as dozens of fixtures absent from the bookmaker.
 *
 * Every page of a pass leaves from one proxy session. A session per page spread
 * the walk across exit IPs and so across more of the disagreeing replicas,
 * which is the opposite of what a single logical unit of work wants.
 */
async function walkPages(byEventId, { sessionId, ...options }) {
  const {
    sportId = SPORT_ID,
    maxPages = MAX_PAGES,
    emptyPageStopCount = EMPTY_PAGE_STOP_COUNT,
    fetchPage = fetchUpcomingPage,
    log,
  } = options;
  let pagesFetched = 0;
  let consecutiveEmptyPages = 0;
  let totalNum = null;

  for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
    let page;
    try {
      page = await fetchPage({ sportId, pageNum }, { ...options, sessionId });
    } catch (error) {
      logWarning(log, `Upcoming index page ${pageNum} failed`, { message: error.message });
      error.pageNum = pageNum;
      throw error;
    }

    pagesFetched += 1;
    const reported = Number(page?.totalNum);
    // The largest any replica claims, not the first. The first page's figure is
    // routinely the smallest of the three on offer, and measuring the shortfall
    // against it understated a 578-event gap as 211.
    if (Number.isFinite(reported) && (totalNum === null || reported > totalNum)) {
      totalNum = reported;
    }

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

  return { pagesFetched, totalNum };
}

/**
 * Walk the whole upcoming index, repeating until a pass adds nothing new.
 *
 * See MAX_INDEX_PASSES above for why one pass is not enough.
 */
export async function fetchEventIndex(options = {}) {
  const { maxIndexPasses = MAX_INDEX_PASSES, log } = options;
  const byEventId = new Map();
  const failures = [];
  let pagesFetched = 0;
  let passes = 0;
  let totalNum = null;

  for (let pass = 1; pass <= maxIndexPasses; pass += 1) {
    const before = byEventId.size;
    let walked;
    try {
      walked = await walkPages(byEventId, { ...options, sessionId: `index_${pass}` });
    } catch (error) {
      failures.push({ pass, pageNum: error.pageNum ?? null, message: error.message });
      // A first pass that cannot complete leaves nothing to resolve against, so
      // it still fails the run. A later one has a usable index behind it
      // already, and losing the remaining passes is better than losing the run.
      if (pass === 1) throw error;
      break;
    }

    passes += 1;
    pagesFetched += walked.pagesFetched;
    if (walked.totalNum !== null && (totalNum === null || walked.totalNum > totalNum)) {
      totalNum = walked.totalNum;
    }
    if (byEventId.size === before) break;
  }

  const events = [...byEventId.values()];
  logInfo(log, 'Built SportyBet event index', {
    events: events.length,
    passes,
    pagesFetched,
    reportedTotal: totalNum,
    failedPasses: failures.length,
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
      passes,
      pagesFetched,
    });
  }

  return { events, passes, pagesFetched, totalNum, failures };
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
