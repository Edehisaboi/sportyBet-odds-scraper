/**
 * ParlayHux competition keys -> SportyBet (Sportradar) tournament ids.
 *
 * The keys match backend `COMPETITION_CATALOG` in
 * app/infrastructure/seed/defaults.py, so ingestion passes its own competition
 * key straight through.
 *
 * This catalog is an optimisation, not a requirement. Resolution matches on
 * team names and kickoff time; a tournament id only narrows the candidate pool
 * before that, which makes matching both faster and safer. A fixture in a
 * competition missing from this table still resolves -- it is simply scored
 * against the whole slate instead of one league.
 */

export const SPORT_ID = 'sr:sport:1';

export const COMPETITIONS = Object.freeze([
  { key: 'premier_league', title: 'Premier League', country: 'England', tournamentId: 'sr:tournament:17' },
  { key: 'championship', title: 'Championship', country: 'England', tournamentId: 'sr:tournament:18' },
  { key: 'la_liga', title: 'LaLiga', country: 'Spain', tournamentId: 'sr:tournament:8' },
  { key: 'laliga2', title: 'LALIGA HYPERMOTION', country: 'Spain', tournamentId: 'sr:tournament:54' },
  { key: 'serie_a', title: 'Serie A', country: 'Italy', tournamentId: 'sr:tournament:23' },
  { key: 'serie_b', title: 'Serie B', country: 'Italy', tournamentId: 'sr:tournament:53' },
  { key: 'bundesliga', title: 'Bundesliga', country: 'Germany', tournamentId: 'sr:tournament:35' },
  { key: 'bundesliga_2', title: '2. Bundesliga', country: 'Germany', tournamentId: 'sr:tournament:44' },
  { key: 'ligue_1', title: 'Ligue 1', country: 'France', tournamentId: 'sr:tournament:34' },
  { key: 'ligue_2', title: 'Ligue 2', country: 'France', tournamentId: 'sr:tournament:182' },
  { key: 'eredivisie', title: 'Eredivisie', country: 'Netherlands', tournamentId: 'sr:tournament:37' },
  { key: 'liga_portugal', title: 'Liga Portugal', country: 'Portugal', tournamentId: 'sr:tournament:238' },
  { key: 'super_lig', title: 'Super Lig', country: 'Turkiye', tournamentId: 'sr:tournament:52' },
  { key: 'jupiler_pro_league', title: 'Pro League', country: 'Belgium', tournamentId: 'sr:tournament:38' },
  { key: 'scottish_premiership', title: 'Premiership', country: 'Scotland', tournamentId: 'sr:tournament:36' },
  // The three UEFA club competitions run from September, so they are absent
  // from an August slate and their ids could not be read off a live feed the
  // way the domestic ones were. These are the standard Sportradar ids; they
  // are verified at run time by `events` mode rather than trusted blindly, and
  // a wrong id degrades to whole-slate matching rather than to a wrong match.
  { key: 'champions_league', title: 'UEFA Champions League', country: 'International', tournamentId: 'sr:tournament:7' },
  { key: 'europa_league', title: 'UEFA Europa League', country: 'International', tournamentId: 'sr:tournament:679' },
  { key: 'conference_league', title: 'UEFA Conference League', country: 'International', tournamentId: 'sr:tournament:34480' },
]);

const BY_KEY = new Map(COMPETITIONS.map((competition) => [competition.key, competition]));
const BY_TOURNAMENT = new Map(COMPETITIONS.map((competition) => [competition.tournamentId, competition]));

/** Look a competition up by key, or null when it is not in the catalog. */
export function getCompetition(key) {
  return BY_KEY.get(String(key ?? '').trim()) ?? null;
}

/** The competition key for a SportyBet tournament id, or null. */
export function competitionKeyForTournament(tournamentId) {
  return BY_TOURNAMENT.get(String(tournamentId ?? ''))?.key ?? null;
}

/** Resolve a list of keys (or 'all') to catalog entries, rejecting unknowns. */
export function resolveCompetitions(requested) {
  const wantsAll = requested === 'all'
    || (Array.isArray(requested) && requested.map(String).includes('all'));
  if (wantsAll) return [...COMPETITIONS];

  const keys = Array.isArray(requested) ? requested : [requested];
  const unique = [...new Set(keys.map((key) => String(key ?? '').trim()).filter(Boolean))];

  return unique.map((key) => {
    const competition = getCompetition(key);
    if (!competition) {
      throw new Error(
        `Unknown competition "${key}". Known keys: ${COMPETITIONS.map((item) => item.key).join(', ')}`,
      );
    }
    return competition;
  });
}
