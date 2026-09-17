/**
 * Library search — lexical, client-side, zero AI cost, zero network per keystroke.
 *
 * ⚠️ THIS IS A PORT, NOT A NEW IDEA. The ranker below is `backend/app/services/
 * search.py` (deleted 2026-08-10 in commit 090a51a, recoverable from git),
 * rewritten in TypeScript. The tokenizing, the stopword list and the synonym
 * groups are that file's, because they were tuned against real failures — most
 * importantly "any videos on Fitness" returning nothing while "chestwork"
 * worked, which is what CATEGORY matching fixes. Reinventing them would have
 * reintroduced bugs someone already paid for.
 *
 * ⚠️ WHY IT MOVED TO THE CLIENT. Search fires per keystroke. The server it
 * would call is a Render free instance that takes ~50 s to wake from idle, so
 * a server round-trip per query is exactly the shape of "search is broken".
 * A library is tens-to-hundreds of items — small enough that the whole thing
 * fits in memory and every query is a synchronous scan. It also means search
 * keeps working with no signal, which a second brain should.
 *
 * The speed comes from `buildIndex`: tokenizing is done ONCE per reel when the
 * library loads, never per keystroke. A query is then set lookups and prefix
 * scans over pre-built token sets.
 *
 * ponytail: a linear scan, not an inverted index. At 1,000 reels × ~4 query
 * terms this is single-digit milliseconds; if someone turns up with 20,000
 * saves the fix is an inverted index (or the embeddings step tracked in
 * TODO.md), not a tweak here.
 *
 * `import type` only — nothing is imported at runtime, so librarySearch.test.ts
 * runs under plain node.
 */
import type { Reel } from './api';

/**
 * Query words that carry no meaning for retrieval, including the "show me any
 * videos on…" framing words so a natural phrase reduces to its topic.
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with',
  'my', 'your', 'what', 'whats', 'how', 'did', 'do', 'does', 'is', 'are', 'was',
  'were', 'i', 'me', 'we', 'about', 'that', 'this', 'these', 'those', 'it', 'its',
  'there', 'have', 'has', 'had', 'save', 'saved', 'saves', 'reel', 'reels',
  'video', 'videos', 'post', 'posts', 'any', 'some', 'all', 'from', 'by', 'at',
  'as', 'be', 'can', 'you', 'show', 'find', 'get', 'give', 'tell', 'which',
  'clip', 'clips', 'content', 'stuff', 'things', 'thing', 'please',
]);

/**
 * Synonym groups. Each term expands to its whole group, so "gym" also matches
 * reels categorized "fitness" and vice versa. Deliberately small and
 * high-precision — a wrong synonym pollutes every result set that uses it.
 */
const SYNONYM_GROUPS: string[][] = [
  ['fitness', 'workout', 'workouts', 'gym', 'exercise', 'exercises', 'training'],
  ['cooking', 'recipe', 'recipes', 'food', 'dish', 'cook', 'kitchen', 'baking'],
  ['tech', 'technology', 'coding', 'programming', 'software', 'developer'],
  ['finance', 'money', 'investing', 'invest', 'stocks', 'budget', 'budgeting'],
  ['health', 'medical', 'wellness', 'nutrition', 'diet'],
  ['travel', 'trip', 'vacation', 'destination', 'itinerary', 'trek', 'trekking',
    'hiking', 'hike', 'bike', 'biking', 'cycling', 'camping', 'backpacking', 'roadtrip'],
  ['fashion', 'outfit', 'style', 'clothes', 'clothing'],
  ['beauty', 'makeup', 'skincare', 'cosmetics', 'grooming', 'haircare', 'hairstyle'],
  ['business', 'startup', 'entrepreneur', 'marketing'],
  ['motivation', 'mindset', 'discipline', 'inspiration', 'motivational'],
  ['education', 'learning', 'study', 'studying'],
  ['hobby', 'craft', 'crafts', 'painting', 'music', 'diy'],
  // Deliberately short. 'product', 'review' and 'store' were the obvious
  // additions and all three were left out — they are generic enough to drag
  // tech and beauty saves into every shopping search, which is exactly the
  // pollution this list's own rule warns about.
  ['shopping', 'haul', 'hauls', 'deal', 'deals', 'buy', 'shop'],
];

const SYNONYMS = new Map<string, Set<string>>();
for (const group of SYNONYM_GROUPS) {
  for (const term of group) {
    const existing = SYNONYMS.get(term) ?? new Set<string>();
    group.forEach(t => existing.add(t));
    SYNONYMS.set(term, existing);
  }
}

/** Cheap plural folding: "recipes" matches "recipe". Only a plain trailing "s"
 *  on longer words — no stemming surprises. */
function singular(word: string): string {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

const WORD_RE = /[a-z0-9]+/g;

function words(text: string): string[] {
  return (text || '').toLowerCase().match(WORD_RE) ?? [];
}

/** Token set for one field: every word plus its singular form. */
function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of words(text)) {
    if (w.length < 2) continue;
    out.add(w);
    out.add(singular(w));
  }
  return out;
}

/**
 * Meaningful query words, plural-folded, stopwords removed. Falls back to ALL
 * words when the query is nothing but stopwords, so "the the" doesn't become
 * an empty term set that matches everything.
 */
export function queryTerms(q: string): Set<string> {
  const all = words(q).filter(w => w.length >= 2);
  const meaningful = all.filter(w => !STOPWORDS.has(w));
  return new Set((meaningful.length ? meaningful : all).map(singular));
}

function expand(terms: Set<string>): Set<string> {
  const out = new Set(terms);
  for (const t of terms) {
    SYNONYMS.get(t)?.forEach(s => out.add(s));
    SYNONYMS.get(singular(t))?.forEach(s => out.add(s));
  }
  for (const t of [...out]) out.add(singular(t));
  return out;
}

/**
 * Within one typo — insert, delete, substitute, or an adjacent SWAP.
 *
 * Replaces the Python's `difflib.get_close_matches` at a 0.8 ratio. Same job,
 * but O(n) with no matrix, which matters when it runs inside a per-keystroke
 * scan over the whole library.
 *
 * ⚠️ The swap case is not optional. Plain Levenshtein counts a transposition as
 * TWO edits, so a ≤1 bound silently drops "wrokout" → "workout" — the single
 * most common way people mistype, and one difflib happened to catch. Losing it
 * is the difference between "search forgives typos" and "search is broken".
 *
 * Restricted to longer words by the caller: on short words a single edit
 * changes the meaning ("cat"/"car") and would produce confidently wrong results.
 */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;

  // Trim the matching head and tail; whatever is left is the difference.
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let ea = a.length - 1, eb = b.length - 1;
  while (ea >= i && eb >= i && a[ea] === b[eb]) { ea--; eb--; }

  const ra = ea - i + 1;   // unmatched run in a
  const rb = eb - i + 1;   // unmatched run in b
  if (ra <= 1 && rb <= 1) return true;                                    // insert / delete / substitute
  return ra === 2 && rb === 2 && a[i] === b[i + 1] && a[i + 1] === b[i];  // adjacent swap
}

const FUZZY_MIN_LEN = 5;

/**
 * How many terms hit this token set — exactly, as a prefix (so results appear
 * while you are still typing: "fitn" → "fitness"), or, for longer words,
 * despite one typo ("wrokout" → "workout"). Without that last one a single
 * slip returns nothing at all, which reads as "search is broken".
 *
 * `fuzzy` is off for the body field on purpose: a summary carries ~40 tokens
 * against a title's ~8, and typo-matching every one of them on every keystroke
 * is where a linear scan would stop being instant. Titles, tags and categories
 * are where a typo actually needs forgiving.
 */
function matchCount(terms: Set<string>, toks: Set<string>, fuzzy: boolean): number {
  let n = 0;
  for (const t of terms) {
    if (toks.has(t)) { n++; continue; }
    if (t.length >= 3) {
      let prefixHit = false;
      for (const tok of toks) { if (tok.startsWith(t)) { prefixHit = true; break; } }
      if (prefixHit) { n++; continue; }
    }
    if (fuzzy && t.length >= FUZZY_MIN_LEN) {
      for (const tok of toks) {
        if (tok.length >= FUZZY_MIN_LEN && withinOneEdit(t, tok)) { n++; break; }
      }
    }
  }
  return n;
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

/** A reel with its token sets precomputed — built once per library load. */
export interface IndexedReel {
  reel: Reel;
  /** title + tags: the direct topic words. */
  head: Set<string>;
  /** category on its own, so a category hit can outweigh a passing mention. */
  cat: Set<string>;
  /** summary + notes + uploader: supporting evidence. */
  body: Set<string>;
}

/**
 * Tokenize the whole library ONCE. This is the entire performance story: a
 * query afterwards touches no strings it hasn't already split.
 */
export function buildIndex(reels: Reel[]): IndexedReel[] {
  return reels.map(reel => ({
    reel,
    head: tokens(`${reel.title || ''} ${(reel.tags || []).join(' ')}`),
    cat: tokens(reel.category || ''),
    body: tokens(`${(reel.summary || []).join(' ')} ${reel.notes || ''} ${reel.uploader || ''}`),
  }));
}

/**
 * Relevance of one reel. 0 = no match.
 *
 * Weights, unchanged from the server version: a direct query-term hit in
 * title/tags or in the category counts double a synonym hit; summary/notes hits
 * are supporting evidence only, so a word buried in one bullet never outranks
 * a title that is about the thing.
 */
function scoreReel(terms: Set<string>, synonyms: Set<string>, r: IndexedReel): number {
  let score = 0;
  score += 4 * matchCount(terms, r.head, true);
  score += 4 * matchCount(terms, r.cat, true);
  score += 2 * (overlap(synonyms, r.head) + overlap(synonyms, r.cat));
  score += 1 * matchCount(terms, r.body, false);
  score += 1 * overlap(synonyms, r.body);
  return score;
}

/**
 * Matches only, most relevant first. Ties keep the incoming order, which
 * callers pass newest-first — so equally-relevant saves read as a recent list.
 *
 * An empty or all-noise query returns [] rather than the whole library: "show
 * me everything" is what the grid already is, and a search box that silently
 * matches everything looks like it ignored you.
 */
export function searchIndex(query: string, index: IndexedReel[]): Reel[] {
  const terms = queryTerms(query);
  if (terms.size === 0) return [];
  const expanded = expand(terms);
  const synonyms = new Set([...expanded].filter(t => !terms.has(t)));

  const hits: { score: number; idx: number; reel: Reel }[] = [];
  index.forEach((r, idx) => {
    const score = scoreReel(terms, synonyms, r);
    if (score > 0) hits.push({ score, idx, reel: r.reel });
  });
  hits.sort((a, b) => (b.score - a.score) || (a.idx - b.idx));
  return hits.map(h => h.reel);
}
