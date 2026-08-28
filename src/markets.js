/**
 * SportyBet market/outcome ids -> the markets and selections ParlayHux prices.
 *
 * SportyBet is a Betradar/Sportradar shop, so both the market id ("18") and the
 * outcome id ("12") are stable Sportradar identifiers rather than display text.
 * Keying on them instead of on `desc` is what keeps this table stable: the
 * descriptions are localised, re-worded, and carry the line inside them
 * ("Over 2.5"), while the ids do not move.
 *
 * The line lives in the market's `specifier`, a pipe-delimited key=value string
 * ("total=2.5", "hcp=-1.5", "goalnr=1|type=prematch"). Only `total` matters
 * here; every market we take is either lineless or a totals line.
 */

// -- our vocabulary, mirroring backend app/domain/enums.py --------------
export const MARKET = Object.freeze({
  MATCH_RESULT: 'match_result',
  DOUBLE_CHANCE: 'double_chance',
  BTTS: 'btts',
  OVER_UNDER_GOALS: 'over_under_goals',
  TEAM_TOTAL_GOALS: 'team_total_goals',
  GOAL_RANGE: 'goal_range',
  WIN_EITHER_HALF: 'win_either_half',
  FIRST_HALF_RESULT: 'first_half_result',
  FIRST_HALF_OVER_UNDER: 'first_half_over_under',
  FIRST_HALF_TEAM_TOTAL: 'first_half_team_total',
  CORNERS_OVER_UNDER: 'corners_over_under',
});

export const SELECTION = Object.freeze({
  HOME: 'home',
  DRAW: 'draw',
  AWAY: 'away',
  HOME_OR_DRAW: 'home_or_draw',
  HOME_OR_AWAY: 'home_or_away',
  DRAW_OR_AWAY: 'draw_or_away',
  OVER: 'over',
  UNDER: 'under',
  YES: 'yes',
  NO: 'no',
  HOME_OVER: 'home_over',
  HOME_UNDER: 'home_under',
  AWAY_OVER: 'away_over',
  AWAY_UNDER: 'away_under',
  GOALS_2_4: 'goals_2_4',
  GOALS_3_5: 'goals_3_5',
});

// Sportradar outcome ids reused across every 1X2-shaped market.
const RESULT_OUTCOMES = { 1: SELECTION.HOME, 2: SELECTION.DRAW, 3: SELECTION.AWAY };
// ...and across every over/under-shaped market.
const TOTALS_OUTCOMES = { 12: SELECTION.OVER, 13: SELECTION.UNDER };
const YES_NO_OUTCOMES = { 74: SELECTION.YES, 76: SELECTION.NO };

/**
 * One SportyBet market id -> one of our markets.
 *
 * `lined: true` means a row is only usable with a `total=` specifier, so a
 * variant of the market carrying some other specifier is dropped rather than
 * emitted with a null line that would collide with every other variant.
 *
 * `outcomes` maps Sportradar outcome id -> our selection.
 */
export const MARKET_MAP = Object.freeze({
  // -- Full time ---------------------------------------------------
  1: { market: MARKET.MATCH_RESULT, outcomes: RESULT_OUTCOMES },
  10: {
    market: MARKET.DOUBLE_CHANCE,
    outcomes: { 9: SELECTION.HOME_OR_DRAW, 10: SELECTION.HOME_OR_AWAY, 11: SELECTION.DRAW_OR_AWAY },
  },
  29: { market: MARKET.BTTS, outcomes: YES_NO_OUTCOMES },
  18: { market: MARKET.OVER_UNDER_GOALS, lined: true, outcomes: TOTALS_OUTCOMES },
  19: {
    market: MARKET.TEAM_TOTAL_GOALS,
    lined: true,
    outcomes: { 12: SELECTION.HOME_OVER, 13: SELECTION.HOME_UNDER },
  },
  20: {
    market: MARKET.TEAM_TOTAL_GOALS,
    lined: true,
    outcomes: { 12: SELECTION.AWAY_OVER, 13: SELECTION.AWAY_UNDER },
  },

  // Goal range comes from "Multigoals" (548) rather than the market SportyBet
  // actually calls "Goal Range" (25). 25 is a partition into 0-1/2-3/4-6/7+,
  // which contains neither of the two bands we price; 548 quotes every band
  // including 2-4 and 3-5. Its outcome ids are bare integers with no meaning
  // outside this market, so they are named explicitly.
  548: {
    market: MARKET.GOAL_RANGE,
    outcomes: { 1736: SELECTION.GOALS_2_4, 1740: SELECTION.GOALS_3_5 },
  },

  // "Home/Away To Win Either Half" are two separate yes/no markets. Only the
  // Yes side is ours: a No is not one of our selections, and reading it as the
  // other team's Yes would be wrong -- both teams can fail to win a half.
  50: { market: MARKET.WIN_EITHER_HALF, outcomes: { 74: SELECTION.HOME } },
  51: { market: MARKET.WIN_EITHER_HALF, outcomes: { 74: SELECTION.AWAY } },

  // -- First half --------------------------------------------------
  60: { market: MARKET.FIRST_HALF_RESULT, outcomes: RESULT_OUTCOMES },
  68: { market: MARKET.FIRST_HALF_OVER_UNDER, lined: true, outcomes: TOTALS_OUTCOMES },
  69: {
    market: MARKET.FIRST_HALF_TEAM_TOTAL,
    lined: true,
    outcomes: { 12: SELECTION.HOME_OVER, 13: SELECTION.HOME_UNDER },
  },
  70: {
    market: MARKET.FIRST_HALF_TEAM_TOTAL,
    lined: true,
    outcomes: { 12: SELECTION.AWAY_OVER, 13: SELECTION.AWAY_UNDER },
  },

  // -- Corners -----------------------------------------------------
  166: { market: MARKET.CORNERS_OVER_UNDER, lined: true, outcomes: TOTALS_OUTCOMES },
});

/** Every SportyBet market id this actor reads, for feed-level filtering. */
export const WANTED_MARKET_IDS = Object.freeze(Object.keys(MARKET_MAP));

/** Parse "total=2.5|foo=bar" into { total: '2.5', foo: 'bar' }. */
export function parseSpecifier(specifier) {
  const parsed = {};
  for (const part of String(specifier ?? '').split('|')) {
    if (!part) continue;
    const index = part.indexOf('=');
    if (index <= 0) continue;
    parsed[part.slice(0, index)] = part.slice(index + 1);
  }
  return parsed;
}

/**
 * Decimal odds as a number, or null when unusable.
 *
 * SportyBet sends odds as strings. Anything at or below 1 is not a real price
 * -- it is a placeholder on a suspended outcome -- and would poison an
 * expected-value calculation downstream, so it is dropped.
 */
export function parsePrice(odds) {
  const price = Number.parseFloat(String(odds ?? '').replace(',', '.'));
  return Number.isFinite(price) && price > 1 ? price : null;
}

function parseProbability(value) {
  const probability = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(probability) && probability > 0 && probability <= 1 ? probability : null;
}

/** A market is tradeable when SportyBet has it open and unbanned. */
export function isMarketOpen(market) {
  return Number(market?.status ?? 0) === 0 && market?.banned !== true;
}

/**
 * Map one SportyBet market object to zero or more quotes.
 *
 * Returns [] for every market we do not price, which is the overwhelming
 * majority: a Premier League event carries 700+ markets and we want 14 ids.
 */
export function mapMarket(market) {
  if (!market || !isMarketOpen(market)) return [];

  const definition = MARKET_MAP[String(market.id)];
  if (!definition) return [];

  const specifier = parseSpecifier(market.specifier);
  let line = null;

  if (definition.lined) {
    // A lined market with no `total=` is a different market wearing the same
    // id (e.g. a corner handicap): drop it rather than guess a line.
    if (specifier.total === undefined) return [];
    line = Number.parseFloat(specifier.total);
    if (!Number.isFinite(line)) return [];
  }

  const quotes = [];
  for (const outcome of market.outcomes ?? []) {
    if (Number(outcome?.isActive ?? 0) !== 1) continue;

    const selection = definition.outcomes[String(outcome.id)];
    if (!selection) continue;

    const price = parsePrice(outcome.odds);
    if (price === null) continue;

    quotes.push({
      market: definition.market,
      selection,
      line,
      price,
      // SportyBet publishes its own implied probability per outcome. Carried
      // through because it is strictly more information than the price alone
      // and costs nothing to keep.
      probability: parseProbability(outcome.probability),
      source_market_id: String(market.id),
      source_specifier: market.specifier || '',
      source_outcome_id: String(outcome.id),
    });
  }

  return quotes;
}

/**
 * Every quote for one event, de-duplicated.
 *
 * A single (market, selection, line) can legitimately appear twice -- the same
 * line quoted under both a main and a variant market id -- so the better price
 * wins, which is the only tie-break that can never make the caller worse off.
 */
export function mapEventMarkets(markets) {
  const chosen = new Map();

  for (const market of markets ?? []) {
    for (const quote of mapMarket(market)) {
      const key = `${quote.market}|${quote.selection}|${quote.line ?? ''}`;
      const existing = chosen.get(key);
      if (!existing || quote.price > existing.price) chosen.set(key, quote);
    }
  }

  return [...chosen.values()].sort((first, second) => (
    first.market.localeCompare(second.market)
    || first.selection.localeCompare(second.selection)
    || (first.line ?? 0) - (second.line ?? 0)
  ));
}
