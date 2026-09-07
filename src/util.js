/**
 * Text normalisation and similarity, used to line a ParlayHux fixture up with
 * a SportyBet event.
 *
 * The two sides name the same club differently often enough that exact string
 * equality resolves only about half a slate: ParlayHux fixtures come from
 * Flashscore ("Manchester City", "Bodo/Glimt", "Wolverhampton"), SportyBet
 * abbreviates ("Man City", "Bodoe/Glimt", "Wolves"). Normalising away the
 * decoration and then scoring what is left is what closes that gap.
 */

/**
 * Club-name noise: legal forms and abbreviations that carry no identity.
 *
 * Strictly abbreviations and generic words. Words that look generic but
 * actually distinguish clubs -- Atletico, Athletic, Sporting, Deportivo, Real,
 * Racing -- are deliberately absent: stripping them collapses Atletico Madrid
 * onto Real Madrid, which is precisely the mistake this whole module exists to
 * avoid.
 */
const NOISE_TOKENS = new Set([
  'fc', 'afc', 'cf', 'sc', 'ac', 'ss', 'ssc', 'as', 'us', 'usl', 'sv', 'tsv', 'vfl', 'vfb',
  'bsc', 'fsv', 'ssv', 'msv', 'spvgg', 'bv', 'sk', 'bk', 'if', 'ifk', 'ff', 'gif', 'aik',
  'cd', 'ud', 'rcd', 'ca', 'cs', 'sd', 'ec', 'se', 'fk', 'nk', 'hnk', 'gnk',
  'ks', 'mks', 'gks', 'lks', 'ogc', 'osc', 'rcs', 'asd', 'ssd', 'mfc',
  'club', 'clube', 'calcio', 'futebol', 'futbol', 'football', 'team',
  'the', 'de', 'do', 'da', 'of', 'and',
]);

/**
 * Per-token rewrites, applied to every name.
 *
 * These are the divergences that recur across many clubs rather than
 * belonging to one, so a token rule covers the whole class at once: "Utd" is
 * abbreviated the same way for Manchester, Sheffield, Leeds and West Ham, and
 * the German/English city-name split is the same word every time it appears.
 * One rule here is worth a dozen entries in the alias table below.
 */
const TOKEN_SUBSTITUTIONS = Object.freeze({
  utd: 'united',
  munchen: 'munich',
  muenchen: 'munich',
  koln: 'cologne',
  koeln: 'cologne',
  nurnberg: 'nuremberg',
  nuernberg: 'nuremberg',
  monchengladbach: 'gladbach',
  moenchengladbach: 'gladbach',
  wanderers: 'wanderers',
});

/**
 * Names whose short form shares no useful token with the long form, so
 * similarity scoring alone cannot connect them.
 *
 * Deliberately small: it holds only the cases where the two names are
 * genuinely different words ("Spurs"/"Tottenham"), not the many cases the
 * normaliser already handles by dropping punctuation and legal forms. Keys and
 * values are both normalised before use, so casing and accents do not matter.
 */
export const NAME_ALIASES = Object.freeze({
  qpr: 'queens park rangers',
  'man city': 'manchester city',
  'man utd': 'manchester united',
  'man united': 'manchester united',
  'man u': 'manchester united',
  spurs: 'tottenham hotspur',
  tottenham: 'tottenham hotspur',
  wolves: 'wolverhampton wanderers',
  wolverhampton: 'wolverhampton wanderers',
  'nottm forest': 'nottingham forest',
  'sheff utd': 'sheffield united',
  'sheff wed': 'sheffield wednesday',
  'west brom': 'west bromwich albion',
  'brighton and hove albion': 'brighton',
  'newcastle united': 'newcastle',
  'leeds united': 'leeds',
  'west ham united': 'west ham',
  'inter milan': 'internazionale',
  inter: 'internazionale',
  'ac milan': 'milan',
  juve: 'juventus',
  psg: 'paris saint germain',
  'paris sg': 'paris saint germain',
  'borussia dortmund': 'dortmund',
  'borussia monchengladbach': 'monchengladbach',
  'bayer leverkusen': 'leverkusen',
  'eintracht frankfurt': 'frankfurt',
  'atletico madrid': 'atletico madrid',
  'athletic bilbao': 'athletic club',
  'ath bilbao': 'athletic club',
  'atl madrid': 'atletico madrid',
  'real sociedad': 'real sociedad',
  betis: 'real betis',
  psv: 'psv eindhoven',
  ajax: 'ajax amsterdam',
  feyenoord: 'feyenoord rotterdam',
  benfica: 'benfica lisbon',
  porto: 'fc porto',
  'sporting cp': 'sporting lisbon',
  galatasaray: 'galatasaray istanbul',
  fenerbahce: 'fenerbahce istanbul',
  besiktas: 'besiktas istanbul',
  'st truiden': 'sint truidense',
  'st truidense vv': 'sint truidense',
  'royale union sg': 'union saint gilloise',
  'union gilloise': 'union saint gilloise',
  'st liege': 'standard liege',
  'st etienne': 'saint etienne',
  'dep a coruna': 'deportivo la coruna',
  'celtavigo b': 'celta fortuna',
  'celta vigo b': 'celta fortuna',
  amedspor: 'amed sportif faaliyetler',
  basaksehir: 'istanbul basaksehir',
  'istanbul bb': 'istanbul basaksehir',
  laval: 'stade lavallois',
  // Same club, named for the city and for the suburb its ground is in.
  'sabah baku': 'sabah masazir',
});

/**
 * Lowercase, accent-free, punctuation-free form of a name.
 *
 * "Bodoe/Glimt" and "Bodo/Glimt" both reduce to "bodo glimt": the Nordic
 * oe/o transliteration is folded explicitly because NFKD leaves the Danish and
 * Norwegian slashed o alone.
 */
export function normalizeName(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ø|ö/g, 'o')
    .replace(/æ/g, 'ae')
    .replace(/å/g, 'a')
    .replace(/ß/g, 'ss')
    .replace(/oe(?=\b)/g, 'o')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Normalised name with club noise and any parenthetical qualifier removed. */
export function canonicalName(value) {
  const withoutQualifier = String(value ?? '').split('(')[0];
  const aliased = NAME_ALIASES[normalizeName(withoutQualifier)] ?? withoutQualifier;
  const tokens = normalizeName(aliased)
    .split(' ')
    .filter(Boolean)
    .map((token) => TOKEN_SUBSTITUTIONS[token] ?? token);

  const meaningful = tokens.filter((token) => (
    // Single characters are punctuation debris rather than words -- the
    // apostrophe in "M'gladbach" leaves a stray "m" -- and they contribute no
    // bigrams, so they only ever drag a token-alignment average down.
    token.length > 1 && !NOISE_TOKENS.has(token)
  ));

  // Never strip a name down to nothing: a club genuinely called "Athletic"
  // keeps its only token rather than becoming unmatchable.
  return (meaningful.length ? meaningful : tokens).join(' ');
}

/** Character bigrams of a string, used for Dice similarity. */
function bigrams(value) {
  const compact = value.replace(/ /g, '');
  const grams = new Set();
  for (let index = 0; index < compact.length - 1; index += 1) {
    grams.add(compact.slice(index, index + 2));
  }
  return grams;
}

/**
 * Sorensen-Dice similarity over character bigrams, in [0, 1].
 *
 * Chosen over edit distance because it is length-insensitive in the way club
 * names need: "man city" against "manchester city" scores well despite the
 * length gap, while two different clubs sharing a city do not.
 */
export function diceSimilarity(first, second) {
  if (!first || !second) return 0;
  if (first === second) return 1;

  const firstGrams = bigrams(first);
  const secondGrams = bigrams(second);
  if (!firstGrams.size || !secondGrams.size) return 0;

  let shared = 0;
  for (const gram of firstGrams) if (secondGrams.has(gram)) shared += 1;

  return (2 * shared) / (firstGrams.size + secondGrams.size);
}

/** Minimum length ratio for one name being contained in the other to count. */
const CONTAINMENT_MIN_RATIO = 0.6;

/**
 * Token-by-token agreement between two names, in [0, 1].
 *
 * Each token of the shorter name is scored against its best counterpart in the
 * longer one and the results averaged, then discounted for tokens the shorter
 * name leaves unexplained.
 *
 * Aligning tokens rather than comparing whole strings is what separates
 * "Manchester City" from "Manchester United": whole-string bigrams are
 * dominated by the ten characters they share and score 0.74, while aligning
 * puts "city" against "united" and scores 0.63. The distinguishing word gets a
 * vote proportional to its importance instead of being drowned out.
 */
function tokenAlignment(leftTokens, rightTokens) {
  const [shorter, longer] = leftTokens.length <= rightTokens.length
    ? [leftTokens, rightTokens]
    : [rightTokens, leftTokens];
  if (!shorter.length || !longer.length) return 0;

  let total = 0;
  for (const token of shorter) {
    let best = 0;
    for (const candidate of longer) {
      best = Math.max(best, token === candidate ? 1 : diceSimilarity(token, candidate));
      if (best === 1) break;
    }
    total += best;
  }

  // Unmatched tokens on the longer side are unexplained, but only gently
  // penalised: dropping a word is normal ("Bayer Leverkusen" -> "Leverkusen").
  const coverage = shorter.length / longer.length;
  return (total / shorter.length) * (0.75 + 0.25 * coverage);
}

/**
 * How alike two club names are, in [0, 1].
 *
 * Containment counts as near-certain because abbreviation is the dominant
 * failure mode and is nearly always a subset of the long form. It is gated on
 * a length ratio so that a merely incidental substring does not qualify --
 * without that gate "Madrid" sits inside "Real Madrid" and every Madrid club
 * becomes the same club.
 */
export function nameSimilarity(first, second) {
  const left = canonicalName(first);
  const right = canonicalName(second);
  if (!left || !right) return 0;
  if (left === right) return 1;

  if (left.length >= 4 && right.length >= 4 && (left.includes(right) || right.includes(left))) {
    const ratio = Math.min(left.length, right.length) / Math.max(left.length, right.length);
    if (ratio >= CONTAINMENT_MIN_RATIO) return 0.95;
  }

  const leftTokens = left.split(' ').filter(Boolean);
  const rightTokens = right.split(' ').filter(Boolean);

  return tokenAlignment(leftTokens, rightTokens);
}

export function slugify(value) {
  return normalizeName(value).replace(/ /g, '_') || 'unknown';
}

/** Epoch millis / ISO string / Date -> epoch millis, or null. */
export function toEpochMillis(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();

  // A bare epoch is ambiguous between seconds and millis, and reading seconds
  // as millis lands in 1970 -- far enough out that the kickoff gate rejects
  // every candidate and the fixture silently fails to resolve. Ten digits or
  // fewer is seconds; anything longer is already millis. Applied to numbers
  // and to numeric strings alike, since callers send both.
  const asEpoch = (digits) => (Math.abs(digits) < 1e11 ? digits * 1000 : digits);

  if (typeof value === 'number') return Number.isFinite(value) ? asEpoch(value) : null;

  const text = String(value).trim();
  if (/^\d+$/.test(text)) return asEpoch(Number.parseInt(text, 10));

  // A bare timestamp with no zone is UTC here: every kickoff ParlayHux stores
  // is UTC, and reading one as local time would shift it by the host offset.
  const iso = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/.test(text)
    ? `${text.replace(' ', 'T')}Z`
    : text;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
}

export function toIso(millis) {
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

export function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export function logInfo(log, message, data) {
  if (log?.info) return log.info(message, data);
  return data === undefined ? console.log(message) : console.log(message, data);
}

export function logWarning(log, message, data) {
  if (log?.warning) return log.warning(message, data);
  if (log?.warn) return log.warn(message, data);
  return data === undefined ? console.warn(message) : console.warn(message, data);
}
