/**
 * Client-side metadata fetch — runs on the USER's IP, not our server's.
 *
 * WHY THIS EXISTS
 * Instagram and Facebook serve their public og:/link-preview surface to normal
 * user IPs but block our backend's datacenter IP (verified 2026-07-21: the same
 * Instagram reel returned 373 chars of caption from a home connection and
 * nothing at all from Render). The phone isn't blocked, so the app fetches the
 * metadata itself and posts it to /api/reels/{id}/client-metadata.
 *
 * PLATFORM REALITY — read before "fixing" a failure here:
 *   • NATIVE (iOS/Android): RN's fetch is a native HTTP client with no CORS, so
 *     the page fetches below work for every platform. This is the real product path.
 *   • WEB: the browser enforces CORS. YouTube's oEmbed endpoint sends CORS headers
 *     so it works; instagram.com / facebook.com / linkedin.com do NOT, so those
 *     fetches throw. That is expected and unfixable client-side (a CORS proxy
 *     would put us back on a server IP, defeating the purpose). We return null and
 *     the server's own extraction stands.
 *
 * Everything here is best-effort and time-boxed: a failure must never block or
 * slow a save. The server re-validates and ignores this payload whenever its own
 * extraction produced usable text.
 */

export interface ClientMetadata {
  url: string;
  title?: string;
  text?: string;
  thumbnail_url?: string;
  uploader?: string;
}

/** Hard ceiling on the whole attempt. Saves stay instant because this runs
 *  alongside the save request, never in front of it. */
const TIMEOUT_MS = 6000;
/** Cap what we read: Instagram ships ~600 KB of inline script; we only need the
 *  <head> meta tags, and unbounded reads on a phone are wasteful. */
const MAX_HTML = 600_000;
/** Mirrors the server's `should_summarize` bar — below this there's nothing worth
 *  sending, and the server would reject it anyway. */
const MIN_TEXT = 50;

/** Link-preview crawler UA. Instagram/Facebook serve the public og: caption only
 *  to recognized preview bots — a browser UA gets the login wall. Same trick the
 *  backend uses (extractor._PREVIEW_HEADERS). */
const PREVIEW_UA =
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/** Safe codepoint -> char; malformed entities are left as-is rather than throwing. */
function codePoint(raw: string, radix: number, original: string): string {
  try {
    const n = parseInt(raw, radix);
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : original;
  } catch {
    return original;
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    // Numeric entities. Instagram encodes emoji this way (&#x1f447; = 👇) and
    // captions are full of them — leaving them raw feeds literal "&#x1f447;"
    // into the summarizer, which is exactly the garbage-in we don't want.
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => codePoint(h, 16, m))
    .replace(/&#(\d+);/g, (m, d) => codePoint(d, 10, m))
    .replace(/&amp;/g, '&');   // last: so "&amp;quot;" doesn't double-decode
}

/**
 * Pull one og:/twitter: meta value. Scans per-<meta> tag rather than running one
 * big regex over the whole document — the backend hit catastrophic backtracking
 * doing the latter on minified Instagram HTML, so don't reintroduce it.
 */
function metaContent(html: string, keys: string[]): string {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const key = tag.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    if (!key || !keys.includes(key)) continue;
    const val = tag.match(/content\s*=\s*["']([\s\S]*?)["']/i)?.[1];
    if (val) return decodeEntities(val).trim();
  }
  return '';
}

/** LinkedIn puts the full post body in JSON-LD, which is richer than og:description. */
function jsonLdText(html: string): string {
  const blocks = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of blocks) {
    const raw = block.replace(/^[\s\S]*?>/, '').replace(/<\/script>$/i, '');
    try {
      const data = JSON.parse(raw);
      for (const node of Array.isArray(data) ? data : [data]) {
        const body = node?.articleBody || node?.description || node?.text;
        if (typeof body === 'string' && body.trim().length >= MIN_TEXT) return body.trim();
      }
    } catch {
      /* malformed JSON-LD is common; just move on */
    }
  }
  return '';
}

async function fetchText(url: string, ua: string): Promise<string | null> {
  const res = await fetch(url, { headers: { 'User-Agent': ua, 'Accept-Language': 'en-US,en;q=0.9' } });
  if (!res.ok) return null;
  const body = await res.text();
  return body.length > MAX_HTML ? body.slice(0, MAX_HTML) : body;
}

/** YouTube oEmbed — CORS-enabled, so this is the one path that also works on web.
 *  Gives title/author/thumbnail but never the description. */
async function youtubeOEmbed(url: string): Promise<ClientMetadata | null> {
  const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
  const res = await fetch(endpoint);
  if (!res.ok) return null;
  const d = await res.json();
  if (!d?.title) return null;
  return { url, title: d.title, thumbnail_url: d.thumbnail_url, uploader: d.author_name };
}

function detectPlatform(url: string): string {
  const u = url.toLowerCase();
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  if (u.includes('instagram.com')) return 'instagram';
  if (u.includes('facebook.com') || u.includes('fb.watch') || u.includes('fb.com')) return 'facebook';
  if (u.includes('linkedin.com')) return 'linkedin';
  if (u.includes('threads.net') || u.includes('threads.com')) return 'threads';
  return 'other';
}

/**
 * Is this the platform's LOGIN WALL rather than the post?
 *
 * ⚠️ THE INSTAGRAM "Login • Instagram" BUG (owner, 2026-08-12).
 *
 * Instagram serves the public og: surface to the `facebookexternalhit` UA most
 * of the time — but not always, and when it refuses it does NOT return an
 * error. It returns 200 with the sign-in page, whose `og:title` is
 * "Login • Instagram" and whose `og:image` is Instagram's own artwork. The old
 * code checked only "did we get a title / thumbnail?", both of which are
 * present, so it shipped the wall's branding to the server as if it were the
 * reel's — which is why the card briefly showed the real title and then flipped
 * to "Login • Instagram" with a caption that never arrived.
 *
 * The server screens this too (`_is_login_wall_title` in routes/reels.py) — this
 * is the cheaper half, since a wall detected here is never sent at all, so the
 * wall's og:image can't land on a reel that had no thumbnail yet either.
 */
export function isLoginWall(title: string | undefined, html: string): boolean {
  const t = (title || '').trim().toLowerCase();
  if (/^(log ?in|sign ?in)\b/.test(t)) return true;
  if (/^(log|sign) ?in to /.test(t)) return true;
  // A title that is only the platform's own name is the wall's default.
  if (['instagram', 'facebook', 'linkedin', 'tiktok', 'threads'].includes(t.replace(/[\s.•|-]+$/, ''))) return true;
  // Belt and braces: the wall ships a login form even when the title varies by
  // locale ("Anmelden • Instagram"), and a real post page never does.
  return /<input[^>]+name=["'](username|email)["'][^>]*>/i.test(html)
      && /<input[^>]+type=["']password["']/i.test(html);
}

/** Parse a fetched page into metadata. Exported for testing the pure part. */
export function parseMetadata(url: string, html: string): ClientMetadata {
  const ogText = metaContent(html, ['og:description', 'twitter:description', 'description']);
  const ld = jsonLdText(html);
  // Prefer whichever is richer — LinkedIn's JSON-LD body beats its truncated
  // og:description, but Instagram only has og:.
  const text = ld.length > ogText.length ? ld : ogText;
  return {
    url,
    title: metaContent(html, ['og:title', 'twitter:title']) || undefined,
    text: text || undefined,
    thumbnail_url: metaContent(html, ['og:image', 'twitter:image']) || undefined,
    uploader: metaContent(html, ['og:site_name', 'author']) || undefined,
  };
}

/**
 * Best-effort metadata for `url`, fetched from this device. Resolves to null when
 * it can't help (CORS on web, private post, timeout) — callers must treat null as
 * "no opinion" and let the server's extraction stand.
 */
export async function fetchClientMetadata(url: string): Promise<ClientMetadata | null> {
  const platform = detectPlatform(url);

  const attempt = async (): Promise<ClientMetadata | null> => {
    if (platform === 'youtube') {
      // The server already reads YouTube fine from its own IP; oEmbed is only a
      // cheap title/thumbnail safety net (and can't supply the description).
      return await youtubeOEmbed(url);
    }
    const html = await fetchText(url, PREVIEW_UA);
    if (!html) return null;
    const meta = parseMetadata(url, html);
    // We were served the sign-in page, not the post. Everything on it belongs
    // to the wall, so send NOTHING — "no opinion" is the honest answer and lets
    // the server's own result stand. Sending part of it was the bug.
    if (isLoginWall(meta.title, html)) return null;
    // Nothing useful? Don't send a payload the server will just discard.
    if (!meta.text && !meta.title && !meta.thumbnail_url) return null;
    if (meta.text && meta.text.length < MIN_TEXT) delete meta.text;
    return meta;
  };

  return withTimeout(attempt(), TIMEOUT_MS);
}
