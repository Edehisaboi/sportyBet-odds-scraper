import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isMarketOpen,
  mapEventMarkets,
  mapMarket,
  MARKET,
  parsePrice,
  parseSpecifier,
  SELECTION,
} from '../src/markets.js';

const outcome = (id, odds, extra = {}) => ({ id, odds, isActive: 1, probability: '0.5', ...extra });

test('parseSpecifier splits pipe-delimited key=value pairs', () => {
  assert.deepEqual(parseSpecifier('total=2.5'), { total: '2.5' });
  assert.deepEqual(parseSpecifier('goalnr=1|type=prematch'), { goalnr: '1', type: 'prematch' });
  assert.deepEqual(parseSpecifier(''), {});
  assert.deepEqual(parseSpecifier(undefined), {});
});

test('parsePrice rejects prices that cannot be a real return', () => {
  assert.equal(parsePrice('2.50'), 2.5);
  assert.equal(parsePrice('1.00'), null, 'evens-with-no-return is a suspended placeholder');
  assert.equal(parsePrice('0'), null);
  assert.equal(parsePrice(''), null);
  assert.equal(parsePrice('n/a'), null);
});

test('isMarketOpen requires an open, unbanned market', () => {
  assert.equal(isMarketOpen({ status: 0, banned: false }), true);
  assert.equal(isMarketOpen({ status: 1 }), false, 'suspended');
  assert.equal(isMarketOpen({ status: 0, banned: true }), false);
});

test('1X2 maps to match_result by Sportradar outcome id', () => {
  const quotes = mapMarket({
    id: '1',
    status: 0,
    outcomes: [outcome('1', '1.39'), outcome('2', '5.90'), outcome('3', '7.13')],
  });

  assert.deepEqual(
    quotes.map((quote) => [quote.market, quote.selection, quote.price]),
    [
      [MARKET.MATCH_RESULT, SELECTION.HOME, 1.39],
      [MARKET.MATCH_RESULT, SELECTION.DRAW, 5.9],
      [MARKET.MATCH_RESULT, SELECTION.AWAY, 7.13],
    ],
  );
  assert.equal(quotes[0].line, null, '1X2 has no line');
});

test('totals carry the line from the specifier, not from the description', () => {
  const [over, under] = mapMarket({
    id: '18',
    status: 0,
    specifier: 'total=2.5',
    outcomes: [outcome('12', '1.68', { desc: 'Over 2.5' }), outcome('13', '2.25', { desc: 'Under 2.5' })],
  });

  assert.equal(over.market, MARKET.OVER_UNDER_GOALS);
  assert.equal(over.selection, SELECTION.OVER);
  assert.equal(over.line, 2.5);
  assert.equal(under.selection, SELECTION.UNDER);
  assert.equal(under.line, 2.5);
});

test('whole-number totals lines are kept', () => {
  // SportyBet quotes total=2 alongside total=2.5; these push rather than lose,
  // and the backend grades a push, so dropping them would lose real prices.
  const quotes = mapMarket({
    id: '18', status: 0, specifier: 'total=2', outcomes: [outcome('12', '1.14')],
  });
  assert.equal(quotes[0].line, 2);
});

test('home and away team totals are distinguished by market id', () => {
  const home = mapMarket({ id: '19', status: 0, specifier: 'total=1.5', outcomes: [outcome('12', '1.31')] });
  const away = mapMarket({ id: '20', status: 0, specifier: 'total=1.5', outcomes: [outcome('12', '3.10')] });

  assert.equal(home[0].market, MARKET.TEAM_TOTAL_GOALS);
  assert.equal(home[0].selection, SELECTION.HOME_OVER);
  assert.equal(away[0].selection, SELECTION.AWAY_OVER);
});

test('first-half markets map to their own markets', () => {
  assert.equal(
    mapMarket({ id: '60', status: 0, outcomes: [outcome('1', '1.76')] })[0].market,
    MARKET.FIRST_HALF_RESULT,
  );
  assert.equal(
    mapMarket({ id: '68', status: 0, specifier: 'total=1.5', outcomes: [outcome('12', '2.45')] })[0].market,
    MARKET.FIRST_HALF_OVER_UNDER,
  );
  assert.equal(
    mapMarket({ id: '70', status: 0, specifier: 'total=0.5', outcomes: [outcome('12', '2.40')] })[0].selection,
    SELECTION.AWAY_OVER,
  );
});

test('win either half takes only the Yes side of each team market', () => {
  const home = mapMarket({ id: '50', status: 0, outcomes: [outcome('74', '1.19'), outcome('76', '4.25')] });
  const away = mapMarket({ id: '51', status: 0, outcomes: [outcome('74', '3.10'), outcome('76', '1.33')] });

  assert.deepEqual(home.map((quote) => quote.selection), [SELECTION.HOME]);
  assert.deepEqual(away.map((quote) => quote.selection), [SELECTION.AWAY]);
});

test('goal range takes only the 2-4 and 3-5 bands from Multigoals', () => {
  const quotes = mapMarket({
    id: '548',
    status: 0,
    outcomes: [
      outcome('1730', '2.50', { desc: '1-2' }),
      outcome('1736', '1.40', { desc: '2-4' }),
      outcome('1740', '1.44', { desc: '3-5' }),
      outcome('1745', '6.80', { desc: '7+' }),
    ],
  });

  assert.deepEqual(
    quotes.map((quote) => [quote.selection, quote.price]),
    [[SELECTION.GOALS_2_4, 1.4], [SELECTION.GOALS_3_5, 1.44]],
  );
});

test('corners over/under maps from market 166', () => {
  const [over] = mapMarket({
    id: '166', status: 0, specifier: 'total=10.5', outcomes: [outcome('12', '1.72')],
  });
  assert.equal(over.market, MARKET.CORNERS_OVER_UNDER);
  assert.equal(over.line, 10.5);
});

test('team corners map from SportyBet house markets on outcome ids 30/31', () => {
  const [homeOver] = mapMarket({
    id: '900300', status: 0, specifier: 'total=4.5', outcomes: [outcome('30', '1.85')],
  });
  assert.equal(homeOver.market, MARKET.TEAM_TOTAL_CORNERS);
  assert.equal(homeOver.selection, SELECTION.HOME_OVER);
  assert.equal(homeOver.line, 4.5);

  const [awayUnder] = mapMarket({
    id: '900301', status: 0, specifier: 'total=3.5', outcomes: [outcome('31', '1.72')],
  });
  assert.equal(awayUnder.market, MARKET.TEAM_TOTAL_CORNERS);
  assert.equal(awayUnder.selection, SELECTION.AWAY_UNDER);
  assert.equal(awayUnder.line, 3.5);
});

test('team corners ignore the Sportradar totals outcome ids', () => {
  // The bug this fixes: 12/13 are what every other totals market uses, so a map
  // built from TOTALS_OUTCOMES matched the market and dropped every outcome.
  assert.deepEqual(
    mapMarket({ id: '900300', status: 0, specifier: 'total=4.5', outcomes: [outcome('12', '1.85')] }),
    [],
  );
});

test('corners 1X2 maps all three sides from market 162', () => {
  const quotes = mapMarket({
    id: '162',
    status: 0,
    outcomes: [outcome('1', '1.90'), outcome('2', '11.0'), outcome('3', '2.50')],
  });
  assert.deepEqual(
    quotes.map((quote) => [quote.market, quote.selection, quote.line]),
    [
      [MARKET.MOST_CORNERS, SELECTION.HOME, null],
      [MARKET.MOST_CORNERS, SELECTION.DRAW, null],
      [MARKET.MOST_CORNERS, SELECTION.AWAY, null],
    ],
  );
});

test('markets we do not price are dropped', () => {
  // 16 is an Asian handicap, 41 a correct score: both are live markets we have
  // no selection vocabulary for.
  assert.deepEqual(mapMarket({ id: '16', status: 0, specifier: 'hcp=-1.5', outcomes: [outcome('1714', '1.90')] }), []);
  assert.deepEqual(mapMarket({ id: '41', status: 0, specifier: 'score=0:0', outcomes: [outcome('1', '9.0')] }), []);
});

test('a lined market with no total specifier is dropped rather than given a null line', () => {
  assert.deepEqual(mapMarket({ id: '18', status: 0, specifier: 'hcp=-1.5', outcomes: [outcome('12', '1.90')] }), []);
});

test('suspended markets and inactive outcomes produce nothing', () => {
  assert.deepEqual(mapMarket({ id: '1', status: 1, outcomes: [outcome('1', '1.39')] }), []);
  assert.deepEqual(mapMarket({ id: '1', banned: true, status: 0, outcomes: [outcome('1', '1.39')] }), []);
  assert.deepEqual(
    mapMarket({ id: '1', status: 0, outcomes: [{ id: '1', odds: '1.39', isActive: 0 }] }),
    [],
  );
});

test('mapEventMarkets keeps the better price when a selection is quoted twice', () => {
  const quotes = mapEventMarkets([
    { id: '1', status: 0, outcomes: [outcome('1', '1.39')] },
    { id: '1', status: 0, outcomes: [outcome('1', '1.45')] },
  ]);

  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].price, 1.45);
});

test('mapEventMarkets keeps distinct lines apart', () => {
  const quotes = mapEventMarkets([
    { id: '18', status: 0, specifier: 'total=2.5', outcomes: [outcome('12', '1.68')] },
    { id: '18', status: 0, specifier: 'total=3.5', outcomes: [outcome('12', '2.65')] },
  ]);

  assert.equal(quotes.length, 2);
  assert.deepEqual(quotes.map((quote) => quote.line), [2.5, 3.5]);
});

test('mapEventMarkets tolerates an empty or missing market list', () => {
  assert.deepEqual(mapEventMarkets([]), []);
  assert.deepEqual(mapEventMarkets(undefined), []);
});
