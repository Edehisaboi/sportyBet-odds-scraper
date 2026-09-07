/**
 * The SportyBet JSON API.
 *
 * Everything this actor needs is served as plain JSON with no authentication,
 * which is why there is no browser anywhere in this actor. Two endpoints carry
 * the whole job:
 *
 *   factsCenter/pcUpcomingEvents  paginated index of every upcoming football
 *                                 event -- ids, teams, kickoff, tournament --
 *                                 which is what fixtures are resolved against.
 *   factsCenter/event             every market on one event, ~700 of them for
 *                                 a Premier League fixture.
 *
 * A third, factsCenter/pcEvents, returns one tournament's events but is a POST
 * that answers 403 to anything but the site's own client, so the index is
 * filtered by tournament on our side instead.
 */

import { gotScraping } from 'got-scraping';
import { logWarning, sleep } from './util.js';

export const API_BASE = 'https://www.sportybet.com/api/ng';
export const SITE_REFERER = 'https://www.sportybet.com/ng/sport/football';

const MAX_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 600;
// SportyBet answers 200 with a bizCode envelope rather than an HTTP error, so
// success is a bizCode check, not a status check.
const BIZ_CODE_OK = 10000;

export class SportyBetApiError extends Error {
  constructor(message, { statusCode, bizCode, path } = {}) {
    super(message);
    this.name = 'SportyBetApiError';
    this.statusCode = statusCode;
    this.bizCode = bizCode;
    this.path = path;
  }
}

function isRetryableStatus(statusCode) {
  return statusCode === 0 || statusCode === 408 || statusCode === 429 || statusCode >= 500;
}

/**
 * GET one API path and return its `data` payload.
 *
 * `sessionId` pins a proxy session so the requests making up one logical unit
 * of work (a fixture's index lookup and its odds fetch) leave from the same IP,
 * which is what a rate limiter expects to see.
 */
export async function apiGet(path, options = {}) {
  const { proxyConfiguration, sessionId, log, timeoutMs = 30000 } = options;
  const url = `${API_BASE}/${path}${path.includes('?') ? '&' : '?'}_t=${Date.now()}`;

  let lastError = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    // Apify proxy session ids must match /^[\w.~]+$/, so hyphens and colons --
    // both of which appear in Sportradar ids -- have to go.
    const proxySession = sessionId ? `sb_${String(sessionId).replace(/[^\w.~]/g, '')}` : undefined;
    const proxyUrl = proxyConfiguration?.newUrl
      ? await proxyConfiguration.newUrl(proxySession)
      : undefined;

    try {
      const response = await gotScraping({
        url,
        proxyUrl,
        responseType: 'text',
        timeout: { request: timeoutMs },
        throwHttpErrors: false,
        retry: { limit: 0 },
        headers: {
          accept: '*/*',
          'accept-language': 'en-US,en;q=0.9',
          referer: SITE_REFERER,
        },
      });

      const statusCode = typeof response === 'string' ? 200 : response.statusCode;
      const body = typeof response === 'string' ? response : response.body;

      if (isRetryableStatus(statusCode)) {
        lastError = new SportyBetApiError(`HTTP ${statusCode}`, { statusCode, path });
      } else if (statusCode >= 400) {
        // A 4xx that is not rate limiting is a bad request, and repeating it
        // will not fix it.
        throw new SportyBetApiError(`HTTP ${statusCode} for ${path}`, { statusCode, path });
      } else {
        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          // Almost always an interstitial or block page rather than JSON.
          lastError = new SportyBetApiError('Response was not JSON', { statusCode, path });
          payload = null;
        }

        if (payload) {
          if (Number(payload.bizCode) !== BIZ_CODE_OK) {
            throw new SportyBetApiError(
              `SportyBet rejected ${path}: ${payload.message || payload.innerMsg || payload.bizCode}`,
              { statusCode, bizCode: payload.bizCode, path },
            );
          }
          return payload.data;
        }
      }
    } catch (error) {
      if (error instanceof SportyBetApiError && error.bizCode !== undefined) throw error;
      if (error instanceof SportyBetApiError && error.statusCode >= 400 && !isRetryableStatus(error.statusCode)) {
        throw error;
      }
      lastError = error;
    }

    if (attempt < MAX_ATTEMPTS - 1) {
      await sleep(RETRY_BASE_DELAY_MS * (attempt + 1));
    }
  }

  logWarning(log, `SportyBet request failed after ${MAX_ATTEMPTS} attempts`, { path, message: lastError?.message });
  throw lastError ?? new SportyBetApiError(`Could not fetch ${path}`, { path });
}

/**
 * One page of the upcoming-events index.
 *
 * `marketId=1` asks for the 1X2 market only. The index is used to find events,
 * not to price them, and requesting a single market keeps each page around
 * 120 KB instead of several megabytes.
 *
 * `option=2` is the whole list; `option=1` is the site's highlights view, which
 * returns at most **ten events per tournament** however large the page size --
 * `pageSize` and `pageNum` page tournaments, not events, so there is no way to
 * ask for the eleventh. On a full slate that silently dropped 239 of 1,315
 * events, always the ones furthest out: every competition ended at ten and the
 * later matchdays were simply absent. Fixtures in that hole were reported as
 * not offered by the bookmaker, which is why this parameter is worth a comment
 * this long.
 */
export async function fetchUpcomingPage({ sportId, pageNum, pageSize = 100 }, options = {}) {
  const query = new URLSearchParams({
    sportId,
    marketId: '1',
    pageSize: String(pageSize),
    pageNum: String(pageNum),
    option: '2',
  });
  return apiGet(`factsCenter/pcUpcomingEvents?${query}`, options);
}

/** Every market on one event, addressed by its `sr:match:N` id. */
export async function fetchEvent(eventId, options = {}) {
  const query = new URLSearchParams({ eventId, productId: '3' });
  return apiGet(`factsCenter/event?${query}`, { sessionId: eventId, ...options });
}
