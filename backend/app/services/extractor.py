import yt_dlp
import httpx
import re
from app.config import settings
import os
import json
import random
import shutil
import tempfile
import threading
import time
import logging
from html import unescape
from typing import Optional
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

# Cap how many caption languages we'll try downloading so a video with dozens of
# auto-translated tracks can't stall extraction.
_MAX_CAPTION_TRIES = 3
_CAPTION_TIMEOUT = 5

_BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate",
}

# Link-preview crawler UA. Instagram/Facebook only serve the public og: caption
# (the text shown when a link unfurls) to recognized preview bots — a normal browser
# UA from a server IP gets the login wall instead. This is the ungated "link-preview
# surface": it works without auth and carries the full caption text.
_PREVIEW_HEADERS = {
    "User-Agent": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate",
}

# Complete, self-consistent header sets, tried in order. Rotating only the UA
# string while every other header stays identical is a WEAKER signal than not
# rotating at all: real clients send a coherent set, and a preview-crawler UA
# with no Accept header is an obvious scraper. Each entry below is a real client
# that Instagram/Facebook/LinkedIn serve the ungated og: surface to.
#
# ⚠️ Known ceiling: httpx's TLS ClientHello has a JA3 fingerprint that matches no
# real browser and no real crawler, so a host doing TLS fingerprinting sees the
# contradiction no matter what headers we send. Fixing that needs curl_cffi or
# tls-client (a new dependency + a rewrite of every fetch).
# ponytail: headers-only until logs actually show fingerprint-level blocking.
_IDENTITIES = (
    _PREVIEW_HEADERS,
    {
        "User-Agent": "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate",
    },
    {
        "User-Agent": "Twitterbot/1.0",
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate",
    },
)

# Optional outbound proxy for every extraction fetch (yt-dlp + httpx).
#
# COSTS NOTHING WHEN UNSET, which is the default: _PROXY is None, no proxy
# argument is passed anywhere, and behaviour is byte-for-byte what it was. It is
# a seam, not a subscription. Point it at a residential/mobile proxy only if and
# when datacenter-IP blocking actually costs more than the proxy does — see
# docs/CONTEXT.md § "Extraction & bot-detection".
_PROXY = settings.EXTRACTOR_PROXY_URL or None

# One pooled client instead of a fresh throwaway per httpx.get(). Buys connection
# reuse (no TLS handshake per caption fetch) and, more importantly, a cookie jar:
# TikTok sets msToken/ttwid on first contact and expects them back, so a stateless
# request reads as a scraper regardless of headers.
_http = httpx.Client(
    follow_redirects=True,
    max_redirects=3,
    timeout=8.0,
    proxy=_PROXY,
    limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
)

# Per-host concurrency + jitter. Eight simultaneous byte-identical requests to one
# host from one IP is the detectable pattern — not the volume. Serialising to two
# with a short random delay costs a few hundred ms and removes the signature.
_HOST_CONCURRENCY = 2
_host_gate: dict[str, threading.Semaphore] = {}
_gate_lock = threading.Lock()


def _gate(host: str) -> threading.Semaphore:
    with _gate_lock:
        return _host_gate.setdefault(host, threading.Semaphore(_HOST_CONCURRENCY))


# Per-platform circuit breaker. Once a platform is refusing us, further attempts
# make it worse AND delay every queued save behind them. Open the circuit, let the
# save degrade to a link-only bookmark immediately, and let one probe re-close it.
# Exposed via /health/extract so a block shows up on a dashboard instead of in
# user complaints.
_BREAKER_THRESHOLD = 5
_BREAKER_COOLDOWN = 600
_breaker: dict[str, dict] = {}
_breaker_lock = threading.Lock()


def _circuit_open_locked(platform: str) -> bool:
    """Caller must already hold _breaker_lock. Split out because threading.Lock
    is not reentrant — breaker_state() needs this check while holding the lock."""
    b = _breaker.get(platform)
    if not b or b["fails"] < _BREAKER_THRESHOLD:
        return False
    if time.monotonic() - b["opened"] > _BREAKER_COOLDOWN:
        b["fails"] = 0              # half-open: let a single probe through
        return False
    return True


def circuit_open(platform: str) -> bool:
    with _breaker_lock:
        return _circuit_open_locked(platform)


def record_result(platform: str, ok: bool) -> None:
    with _breaker_lock:
        b = _breaker.setdefault(platform, {"fails": 0, "opened": 0.0})
        if ok:
            b["fails"] = 0
        else:
            b["fails"] += 1
            if b["fails"] == _BREAKER_THRESHOLD:
                b["opened"] = time.monotonic()
                logger.error(f"[BREAKER] {platform} circuit OPEN after {b['fails']} failures")


def breaker_state() -> dict:
    """Snapshot for /health/extract."""
    with _breaker_lock:
        return {
            p: {"fails": b["fails"], "open": _circuit_open_locked(p)}
            for p, b in _breaker.items()
        }


_STRIP_PARAMS = {
    # Universal tracking
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    # YouTube
    'si', 'feature', 'pp', 'ab_channel',
    # Instagram
    'igshid', 'igsh', 'img_index',
    # TikTok
    '_d', 'checksum', 'sec_uid', 'share_app_id', 'share_link_id',
    # LinkedIn
    'rcm', 'trk', 'trackingId', 'originalSubdomain',
}


def normalize_url(url: str) -> str:
    """Strip tracking parameters and canonicalize the URL for deduplication."""
    from urllib.parse import urlparse, urlencode, parse_qs, urlunparse

    parsed = urlparse(url.strip())
    params = parse_qs(parsed.query, keep_blank_values=False)
    cleaned = {k: v for k, v in params.items() if k.lower() not in _STRIP_PARAMS}
    clean_query = urlencode(cleaned, doseq=True)

    # youtu.be/ID → youtube.com/shorts/ID
    if parsed.netloc in ('youtu.be', 'www.youtu.be') and parsed.path.startswith('/'):
        video_id = parsed.path.lstrip('/')
        return f"https://www.youtube.com/shorts/{video_id}"

    return urlunparse((
        parsed.scheme,
        parsed.netloc.lstrip('www.') and parsed.netloc,
        parsed.path.rstrip('/') or '/',
        parsed.params,
        clean_query,
        '',   # strip fragments
    ))


def detect_platform(url: str) -> str:
    if "instagram.com" in url:
        return "instagram"
    elif "youtube.com" in url or "youtu.be" in url:
        return "youtube"
    elif "tiktok.com" in url:
        return "tiktok"
    # ⚠️ `lnkd.in` IS THE ONLY URL THE LINKEDIN APP EVER GIVES YOU.
    # Sharing a post from LinkedIn produces https://lnkd.in/p/<id>, never a
    # linkedin.com link — so recognising only "linkedin.com" meant the share
    # path from LinkedIn was rejected 100% of the time with "Couldn't recognize
    # this link", while pasting a desktop URL worked. Owner report, first
    # TestFlight build, 2026-09-09. `_fetch_page` already follows redirects, so
    # naming the platform here is the whole fix.
    elif "linkedin.com" in url or "lnkd.in" in url:
        return "linkedin"
    elif "facebook.com" in url or "fb.watch" in url or "fb.com" in url:
        return "facebook"
    return "unknown"


def _parse_vtt(vtt: str) -> str:
    """Convert WebVTT caption content to clean plain text without duplicates."""
    seen = []
    for line in vtt.split('\n'):
        line = line.strip()
        if not line:
            continue
        # Skip VTT structural lines
        if line.startswith('WEBVTT') or '-->' in line:
            continue
        if re.match(r'^\d+$', line):
            continue
        # Skip VTT metadata lines (Kind: captions, Language: en, etc.)
        if re.match(r'^(Kind|Language|Position|Align|Size|Line)\s*:', line, re.IGNORECASE):
            continue
        # Strip HTML tags: <c>, <i>, <00:00:01.234>, etc.
        line = re.sub(r'<[^>]+>', '', line).strip()
        if line and (not seen or seen[-1] != line):
            seen.append(line)
    return ' '.join(seen).strip()


_VTT_TS = re.compile(r'(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})\s*-->')


def _vtt_cue_starts(vtt: str) -> list[float]:
    """Cue start times, in seconds.

    Deliberately a SECOND pass rather than a new return value from _parse_vtt:
    that function's string contract is pinned by tests and used elsewhere, and a
    regex sweep over a caption file is microseconds. Two passes, zero churn.

    These timings are the only pacing signal a text-only pipeline gets. Gaps
    between cues are silence, and silence inside a 30-second reel is a visual
    beat — a text card, a reveal, a demo. Without them the summarizer cannot
    tell a talking-head explainer from a caption-driven listicle, because both
    arrive as the same flat wall of text.
    """
    starts: list[float] = []
    for m in _VTT_TS.finditer(vtt):
        h, mm, ss, ms = m.group(1) or 0, m.group(2), m.group(3), m.group(4)
        starts.append(int(h) * 3600 + int(mm) * 60 + int(ss) + int(ms) / 1000)
    return starts


def pacing_hint(duration: int, transcript: str, cue_starts: list[float],
                *, captions_offered: bool = False) -> str:
    """One line of derived structure for the summarizer prompt.

    Pure function of data we already hold — no extra fetch, no extra cost. It
    encodes the difference between formats that are indistinguishable as plain
    text: 45 seconds carrying 20 spoken words is on-screen-text content; 45
    seconds carrying 160 is a talking head.

    `captions_offered` says whether the platform LISTED caption tracks, which is
    a different fact from whether we managed to download them. Without that
    distinction this function asserted "no speech — visual content" every time a
    caption fetch failed, and YouTube 429s the timedtext endpoint routinely. On
    a talking-head video that is a false statement handed to the summarizer as
    evidence, which is exactly the kind of confident wrongness the prompt is
    supposed to prevent.
    """
    if not duration or duration <= 0:
        return ""
    bits = [f"{duration}s"]
    words = len(transcript.split()) if transcript else 0
    if words:
        wpm = words / (duration / 60)
        bits.append(f"~{int(wpm)} spoken words/min")
        if wpm < 60:
            bits.append("sparse narration — likely carried by on-screen text or a visual demo")
    elif captions_offered:
        bits.append(
            "transcript unavailable — captions exist but could not be fetched, "
            "so do NOT assume the video is silent or visual-only"
        )
    else:
        bits.append("no speech transcript — visual or text-overlay content")
    gaps = [b - a for a, b in zip(cue_starts, cue_starts[1:]) if b - a > 2.5]
    if gaps:
        bits.append(f"{len(gaps)} silent gap(s) over 2.5s (visual beats)")
    if cue_starts and cue_starts[0] > 3:
        bits.append(f"speech starts at {cue_starts[0]:.0f}s — cold visual open")
    return "; ".join(bits)


def _get_captions(info: dict) -> tuple[str, list[float]]:
    """Download and parse VTT captions from yt-dlp info for any language.

    Returns (text, cue_start_times). The timings feed pacing_hint(); see there
    for why a text-only pipeline needs them.
    """
    auto = info.get('automatic_captions') or {}
    manual = info.get('subtitles') or {}

    # Priority: video's own declared language → common variants → anything available
    primary = info.get('language') or ''
    seen_langs: list[str] = []
    if primary:
        seen_langs.append(primary)
    for lang in ['en', 'en-US', 'en-GB']:
        if lang not in seen_langs:
            seen_langs.append(lang)
    for lang in list(manual.keys()) + list(auto.keys()):
        if lang not in seen_langs:
            seen_langs.append(lang)

    for lang in seen_langs[:_MAX_CAPTION_TRIES]:
        formats = manual.get(lang) or auto.get(lang)
        if not formats:
            continue
        vtt_url = next((f['url'] for f in formats if f.get('ext') == 'vtt'), None)
        if not vtt_url:
            vtt_url = next((f['url'] for f in formats if f.get('url')), None)
        if not vtt_url:
            continue
        try:
            resp = _http.get(vtt_url, timeout=_CAPTION_TIMEOUT, headers=_BROWSER_HEADERS)
        except Exception:
            continue
        # YouTube rate-limits the timedtext endpoint per-IP. Once we hit 429 every
        # other language will 429 too — stop and let the caller fall back to the
        # description so the save still succeeds quickly.
        if resp.status_code == 429:
            logger.warning("[CAPTIONS] 429 from YouTube timedtext — falling back to description")
            break
        if resp.status_code == 200:
            parsed = _parse_vtt(resp.text)
            if len(parsed) > 30:
                return parsed, _vtt_cue_starts(resp.text)
    return '', []


def _og(html: str, prop: str) -> str:
    """Pull an Open Graph value. Scans individual <meta> tags (each naturally
    bounded by '>') and reads content from the matching one. Avoids the
    catastrophic regex backtracking the old whole-document DOTALL pattern hit on
    huge minified pages — Instagram ships ~600 KB of inline script with no clean
    <head>, which made the old pattern hang for tens of seconds."""
    target = f"og:{prop}".lower()
    for m in re.finditer(r'<meta\s[^>]*>', html, re.IGNORECASE):
        tag = m.group(0)
        # Match the property/name attribute EXACTLY. A loose substring check let
        # sub-properties masquerade as the base one — e.g. Facebook's
        # 'og:image:alt' (caption text) was returned for 'og:image', so the
        # thumbnail ended up being the title string instead of the image URL.
        pm = re.search(r'(?:property|name)\s*=\s*["\']([^"\']+)["\']', tag, re.IGNORECASE)
        if not pm or pm.group(1).strip().lower() != target:
            continue
        # DOTALL is safe here: it runs on one small <meta> tag, not the whole page —
        # and it's required because captions (e.g. Instagram recipes) span newlines.
        cm = re.search(r'content=["\'](.*?)["\']', tag, re.IGNORECASE | re.DOTALL)
        if cm:
            return unescape(cm.group(1).strip())
    return ''


def _extract_jsonld(html: str) -> dict:
    """Pull articleBody/headline from JSON-LD blocks. LinkedIn posts expose the
    FULL post text here (og:description is heavily truncated)."""
    for block in re.findall(r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', html, re.IGNORECASE | re.DOTALL):
        try:
            data = json.loads(block.strip())
        except Exception:
            continue
        for d in (data if isinstance(data, list) else [data]):
            if not isinstance(d, dict):
                continue
            body = (d.get('articleBody') or d.get('text') or '').strip()
            head = (d.get('headline') or '').strip()
            if body or head:
                return {'articleBody': body, 'headline': head}
    return {}


# og:/JSON-LD link-preview metadata lives in <head>; cap how much HTML we regex
# over so a huge page (e.g. YouTube's ~1 MB watch page) can't make the DOTALL
# patterns crawl for tens of seconds and blow the extraction timeout.
_MAX_PAGE_PARSE_BYTES = 600_000


def _youtube_oembed(url: str) -> dict:
    """YouTube's public oEmbed endpoint: title / author / thumbnail. It is NOT
    behind the player-API bot-block, so it still answers from datacenter IPs when
    full extraction is refused — our free graceful-degradation path for YouTube."""
    try:
        resp = _http.get(
            "https://www.youtube.com/oembed",
            params={"url": url, "format": "json"},
            headers=_BROWSER_HEADERS,
            timeout=8,
        )
        if resp.status_code == 200:
            d = resp.json()
            return {
                "title": (d.get("title") or "").strip(),
                "uploader": (d.get("author_name") or "").strip(),
                "image": (d.get("thumbnail_url") or "").strip(),
            }
    except Exception:
        pass
    return {}


# An HONEST User-Agent. Meta's Automated Data Collection Terms require that you
# "only use IP addresses, user-agent strings, and other identifiers that identify
# your services" — so the `facebookexternalhit` spoof in _PREVIEW_HEADERS is a
# named violation of the one clause that is unambiguous. The endpoints below
# serve the caption to ANY non-empty UA (verified: curl, python-requests and
# Findable/1.0 all return 200), so there was never anything to gain by lying.
# Bonus: a non-browser UA gets a 128 KB response instead of 605 KB.
# ⚠️ The URL must be one we actually control. It previously pointed at
# savehere.app, a domain nobody here owns — an honest-UA block that cites a
# domain you do not own is exactly the thing it exists to avoid. Point it at
# the real product site once that domain exists.
_HONEST_UA = {"User-Agent": "Findable/1.0 (+https://github.com/LeoPrasanna/findable)"}

_IG_SHORTCODE = re.compile(r"instagram\.com/(?:reel|reels|p|tv)/([A-Za-z0-9_-]+)", re.I)
# ⚠️ THE THUMBNAIL COMES FROM THE <img> TAG, NOT FROM THE EMBEDDED JSON.
#
# This used to be `re.search(r'"display_url":"(.*?)"', html)`, and it matched
# NOTHING — measured 0/5 against real saved reels on 2026-08-15. The embed page
# carries its JSON blob **escaped inside an HTML attribute**, so the bytes are
# `\"display_url\":\"https:\\\/\\\/...` — there is a backslash between
# `display_url` and the colon, and the unescaped pattern cannot match it.
#
# That silent miss is what made `POST /reels/{id}/thumbnail` — the repair
# endpoint shipped the round before — return 422 "the post may be private or
# deleted" for EVERY Instagram save. The feature was dead on arrival and looked
# like an Instagram problem rather than a regex problem.
#
# The rendered <img> is the better target anyway: one unescaped, already-final
# URL that needs no `unicode_escape` round-trip to read. Verified 5/5 on the
# same reels, and the resulting URL returns 200.
_IG_EMBED_IMG = re.compile(
    r'<img[^>]+class="EmbeddedMediaImage"[^>]+src="([^"]+)"', re.I
)
_FB_VIDEO_ID = re.compile(r"facebook\.com/(?:reel/|watch/?\?v=|[^/]+/videos/)(\d+)", re.I)
# ⚠️ `[^>]*>` consumes the REST OF THE OPENING TAG. Without it the capture
# starts at the tag's own closing bracket, so an empty caption div yielded ">"
# rather than "" — which is truthy, clears an emptiness check, and would have
# sent a single angle bracket to the summarizer as though it were a caption.
_CAPTION_DIV = re.compile(r'class="Caption"[^>]*>(.*?)</div>', re.S)
_OEMBED_P = re.compile(r"<p>(.*?)</p>", re.S)


def _strip_tags(html: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html)).strip()


def instagram_embed(url: str) -> dict:
    """Caption + thumbnail for a public Instagram reel/post, from Instagram itself.

    ⚠️ THIS IS THE FIX FOR "INSTAGRAM SAVES HAVE NO SUMMARY". The page fallback
    below asks for the normal web page, which Instagram serves to a residential
    IP and refuses to a datacenter one — so it worked in local testing and
    returned nothing at all from Render, every time.

    `/embed/captioned/` is the iframe Instagram hands to any site embedding a
    post. It HAS to carry the caption for embeds to render, so it is served
    without cookies, without a token, and to a plain honest User-Agent.
    Verified against a real public reel: 200, 128 KB, full caption.

    ⚠️ The caption div is prefixed with the username as a link, so the first
    token is the handle, not the caption. It is returned separately as
    `uploader` rather than left to pollute the text handed to the summarizer.

    An EMPTY caption div is a clean signal that the post is private or deleted —
    report that honestly rather than guessing.
    """
    m = _IG_SHORTCODE.search(url)
    if not m:
        return {}
    try:
        r = _http.get(
            f"https://www.instagram.com/reel/{m.group(1)}/embed/captioned/",
            headers=_HONEST_UA, follow_redirects=True, timeout=12,
        )
        if r.status_code != 200:
            return {}
        html = r.text
    except Exception as e:
        logger.info(f"[IG-EMBED] {url}: {type(e).__name__}: {e}")
        return {}

    cap = _CAPTION_DIV.search(html)
    text = _strip_tags(cap.group(1)) if cap else ""
    # The leading "> handle" the embed injects before the caption proper.
    uploader = ""
    lead = re.match(r"^>?\s*([A-Za-z0-9_.]{2,30})\s+", text)
    if lead:
        uploader = lead.group(1)
        text = text[lead.end():].strip()

    # See the note on _IG_EMBED_IMG: the JSON blob is escaped and unreadable by
    # a plain regex, the rendered <img> is not. `unescape` because the src is an
    # HTML attribute and arrives with &amp; between its query parameters — left
    # in, those turn a signed CDN URL into a 403.
    thumb = ""
    t = _IG_EMBED_IMG.search(html)
    if t:
        thumb = unescape(t.group(1))

    return {"description": text, "uploader": uploader, "image": thumb}


def facebook_oembed(url: str) -> dict:
    """Description for a public Facebook video, via Meta's OWN tokenless oEmbed.

    This is the sanctioned route — `graph.facebook.com/v25.0/oembed_video` went
    tokenless on 2026-06-15, needs no app, no App Review and no token, and is
    the one option here that is not merely tolerated but published.

    ⚠️ THE URL FORM MATTERS. `facebook.com/reel/<id>` returns an EMPTY
    blockquote with no description — it does not even validate the id — while
    `facebook.com/watch/?v=<id>` returns the full text. Normalizing first is the
    difference between this working and silently returning nothing.
    """
    m = _FB_VIDEO_ID.search(url)
    if not m:
        return {}
    canonical = f"https://www.facebook.com/watch/?v={m.group(1)}"
    try:
        r = _http.get(
            "https://graph.facebook.com/v25.0/oembed_video",
            params={"url": canonical, "maxwidth": 640},
            headers=_HONEST_UA, timeout=12,
        )
        if r.status_code != 200:
            return {}
        data = r.json()
    except Exception as e:
        logger.info(f"[FB-OEMBED] {url}: {type(e).__name__}: {e}")
        return {}

    body = _OEMBED_P.search(data.get("html") or "")
    return {
        "description": _strip_tags(body.group(1)) if body else "",
        "uploader": (data.get("author_name") or "").strip(),
        "image": "",   # oembed_video carries no thumbnail; the page fallback may.
    }


def _fetch_page(url: str) -> Optional[str]:
    """Fetch a page's HTML through the pooled client, trying each crawler identity
    in turn, serialised per host with a little jitter.

    The gate + jitter matter as much as the headers: eight byte-identical
    requests arriving at one host simultaneously from one IP is the detectable
    pattern, independent of how convincing any single request looks.
    """
    host = urlparse(url).hostname or ""
    # Transport failures are counted, not logged per identity: eight warnings per
    # failed save would drown the 403/429 lines that actually tell us something.
    # Only 403/429 got logged before, so a host that was unreachable — DNS, TLS,
    # timeout — returned None in complete silence, and the caller reported it as
    # "no text on the page". Same shape as the yt-dlp loop below, which already
    # keeps a last_err and reports it once.
    last_err: Optional[Exception] = None
    transport_failures = 0
    with _gate(host):
        time.sleep(random.uniform(0.15, 0.6))
        for ident in _IDENTITIES:
            try:
                resp = _http.get(url, headers=ident)
            except Exception as e:
                last_err = e
                transport_failures += 1
                continue
            if resp.status_code == 200 and len(resp.text) > 500:
                return resp.text[:_MAX_PAGE_PARSE_BYTES]
            if resp.status_code in (403, 429):
                logger.warning(
                    f"[FETCH] {resp.status_code} from {host} as "
                    f"{ident['User-Agent'].split('/')[0]}"
                )
    if last_err is not None:
        logger.error(
            f"[FETCH] {transport_failures}/{len(_IDENTITIES)} identities failed to reach "
            f"{host}: {type(last_err).__name__}: {last_err}"
        )
    return None


def clean_title_text(title: str) -> str:
    """Strip the platform noise out of a raw og:title / yt-dlp title.

    ⚠️ CALL THIS ON EVERY PATH THAT PRODUCES A TITLE. It used to live inline in
    `_extract_from_page`, which is one of THREE places `extract_info` can return
    a title from — and not the one Facebook takes. yt-dlp answers a Facebook
    reel with a title and nothing else, so the engagement-count prefix this had
    always stripped shipped straight to the card anyway:

        "5.1M views · 189K reactions | This Quote Changes Everything… | Chris Williamson"

    Right regex, wrong number of callers. Fixing it in the shared function is
    also a smaller diff than guarding each return site.
    """
    t = re.sub(r'\s*\|\s*LinkedIn\s*$', '', title or '').strip()
    # "205K views · 800 reactions | Real title" — Meta puts engagement first.
    # Non-greedy to the FIRST pipe, so a title carrying its own pipes survives.
    t = re.sub(
        r'^[\d.,kmb]+\s+(?:views?|reactions?|likes?|comments?|shares?)\b.*?\|\s*',
        '', t, flags=re.IGNORECASE,
    )
    # og:title can be the entire caption (Instagram dumps the whole recipe in
    # it). Keep the first line only, capped, so the card title stays readable.
    t = t.split('\n', 1)[0].strip()
    if len(t) > 90:
        t = t[:90].rsplit(' ', 1)[0] + '…'
    return t


def _extract_from_page(url: str) -> dict:
    """Fetch text from a page via JSON-LD (full body) then Open Graph meta tags.
    Best-effort — returns empty fields on failure."""
    page = _fetch_page(url)
    if not page:
        return {}

    ld = _extract_jsonld(page)
    # Prefer the full JSON-LD article body; fall back to og:description.
    description = ld.get('articleBody') or _og(page, 'description')
    title = ld.get('headline') or _og(page, 'title')
    image = _og(page, 'image')

    if not title:
        m = re.search(r'<title[^>]*>(.*?)</title>', page, re.IGNORECASE | re.DOTALL)
        title = unescape(m.group(1).strip()) if m else ''

    clean_title = clean_title_text(title)

    return {
        "title": clean_title,
        "description": description,
        "image": image,
        # Meta auto-generates og:image:alt from its OWN image classifier, and it
        # routinely includes OCR'd on-screen text:
        #   "May be an image of 2 people, food and text that says 'CHICKEN 65'"
        # That is the closest thing to a keyframe description obtainable without
        # downloading a single frame — and it is in bytes we already fetched and
        # parsed. (This is the property whose loose substring match used to
        # masquerade as og:image; that bug was fixed above by exact-matching the
        # property name, but the value itself was never captured until now.)
        "image_alt": _og(page, 'image:alt'),
    }


_BASE_YDL_OPTS = {
    "quiet": True,
    "no_warnings": True,
    "skip_download": True,
    "socket_timeout": 10,        # seconds per network operation
    "retries": 1,
    "extractor_retries": 1,
    "noplaylist": True,
    "ignoreerrors": False,
    # Absent entirely unless EXTRACTOR_PROXY_URL is set, so the default deploy is
    # byte-for-byte unchanged and costs nothing.
    **({"proxy": _PROXY} if _PROXY else {}),
}


def _youtube_id(url: str) -> str:
    """Video id from any YouTube URL shape we accept (shorts / watch / youtu.be)."""
    m = re.search(r'(?:/shorts/|/live/|/embed/|youtu\.be/)([A-Za-z0-9_-]{6,})', url)
    if m:
        return m.group(1)
    m = re.search(r'[?&]v=([A-Za-z0-9_-]{6,})', url)
    return m.group(1) if m else ""


def _youtube_data_api(url: str) -> dict:
    """Fetch title + description via the official YouTube Data API v3.

    This exists because YouTube bot-blocks our server's datacenter IP: yt-dlp
    fails and the watch-page scrape returns nothing, so a save from the deployed
    backend had no text to summarize no matter how many times it was retried.
    The Data API is authenticated by key rather than judged by IP reputation, so
    it answers normally from anywhere.

    Uses `videos.list` (1 quota unit), NOT `search.list` (100 units) — we already
    have the id from the URL. At 10,000 free units/day that is ~10k lookups, and
    the extraction cache is keyed by URL globally, so popular links cost one call
    no matter how many users save them.

    Returns {} on any failure (no key, quota exhausted, unknown id) — the caller
    then degrades exactly as it did before. Captions are NOT available here:
    downloading them needs OAuth, so this recovers descriptions only.
    """
    if not settings.YOUTUBE_API_KEY:
        return {}
    vid = _youtube_id(url)
    if not vid:
        return {}
    try:
        r = _http.get(
            "https://www.googleapis.com/youtube/v3/videos",
            params={"id": vid, "part": "snippet", "key": settings.YOUTUBE_API_KEY},
            timeout=8,
        )
        if r.status_code == 403:
            # Almost always quotaExceeded / key restriction. Log loudly: this is
            # the difference between working summaries and silent link-only saves.
            logger.warning(f"[YT-API] 403 for {vid} — quota exhausted or key restricted")
            return {}
        if r.status_code != 200:
            logger.info(f"[YT-API] HTTP {r.status_code} for {vid}")
            return {}
        items = (r.json() or {}).get("items") or []
        if not items:
            return {}
        sn = items[0].get("snippet") or {}
        return {
            "title": (sn.get("title") or "").strip(),
            "description": (sn.get("description") or "").strip(),
            "uploader": (sn.get("channelTitle") or "").strip(),
            "thumbnail": ((sn.get("thumbnails") or {}).get("high") or {}).get("url", ""),
        }
    except Exception as e:
        logger.info(f"[YT-API] {type(e).__name__}: {e}")
        return {}


def _youtube_attempts() -> list[dict]:
    """
    Ordered extraction strategies for YouTube. We prefer the ios/tv/android
    innertube clients because they return auto-captions (the web client does
    NOT) and respond in ~2s. The default client chain is the last-resort
    fallback. Combined with process=False (no format selection), this is both
    far faster and far more reliable than the default behavior.
    """
    return [
        {**_BASE_YDL_OPTS, "extractor_args": {"youtube": {
            "player_client": ["ios", "tv", "android"],
        }}},
        {**_BASE_YDL_OPTS},   # yt-dlp's own default client chain
    ]


def _run_ydl(url: str, opts: dict) -> Optional[dict]:
    # process=False returns the raw extractor output (metadata + caption tracks)
    # WITHOUT running format selection — which we don't need and which is the slow,
    # failure-prone step ("Requested format is not available").
    with yt_dlp.YoutubeDL(opts) as ydl:
        return ydl.extract_info(url, download=False, process=False)


def _pick_thumbnail(info: dict, platform: str) -> str:
    """Best available thumbnail. process=False may not set 'thumbnail' directly."""
    if info.get("thumbnail"):
        return info["thumbnail"]
    best, best_area = "", -1
    for t in (info.get("thumbnails") or []):
        u = t.get("url")
        if not u:
            continue
        area = (t.get("width") or 0) * (t.get("height") or 0)
        if area >= best_area:
            best, best_area = u, area
    if not best and platform == "youtube" and info.get("id"):
        best = f"https://i.ytimg.com/vi/{info['id']}/hqdefault.jpg"
    return best


_HASHTAG = re.compile(r'#\w+')
_URL_RE = re.compile(r'https?://\S+|www\.\S+')
_HANDLE_RE = re.compile(r'[@#]\w+')
# Below this many characters of real prose, there is nothing to summarize.
# Matches the _MIN_SUMMARIZABLE bar the save path already uses.
_MIN_PROSE = 40


def is_link_only(text: str) -> bool:
    """True when a caption is just promo links / handles with no actual content.

    Creator captions are frequently nothing but "Follow us on Instagram" plus
    three URLs. That clears every length check in the pipeline — 150 characters
    looks like content — so it was charging the user an AI action and a Claude
    call to be told `low_content: true`. Observed live on a real save:
    2048 input tokens spent to produce an empty summary.

    Strips URLs, @handles and #tags, then applies the same prose bar the rest of
    the pipeline uses. Deliberately conservative: one real sentence alongside the
    links is enough to keep the caption.
    """
    if not text:
        return False
    prose = _URL_RE.sub(' ', text)
    prose = _HANDLE_RE.sub(' ', prose)
    prose = re.sub(r'\s+', ' ', prose).strip()
    return len(prose) < _MIN_PROSE


# Boilerplate a platform serves INSTEAD of the post when it decides it doesn't
# like the request. These are the sign-in wall's own words, not a creator's.
_LOGIN_WALL_PHRASES = (
    "log in to see photos and videos",
    "sign up to see photos and videos",
    "log in to see this",
    "you must log in to continue",
    "log into facebook to see",
    "log in or sign up to view",
    "create an account or log in",
    "see posts, photos and more on facebook",
    "this content isn't available right now",
    "sorry, this page isn't available",
)

# The wall's blurb lands right at the top of the description. A real caption
# that happens to discuss logging in will not.
_LOGIN_WALL_WINDOW = 160


def is_login_wall(text: str) -> bool:
    """True when `text` is a platform's sign-in page rather than the post.

    ⚠️ WHY THIS EXISTS AT THE EXTRACTOR LEVEL (owner report, 2026-08-12: an
    Instagram save showed its real title, then flipped to "Login • Instagram"
    the moment the AI summary finished).

    Instagram and Facebook do not error when they refuse us — they return HTTP
    200 with the sign-in page. Its `og:description` is real prose of real
    length, so it sails past every "do we have text?" check, gets stored as
    `raw_text`, and is then handed to Claude as if it were the reel. The model
    dutifully summarizes Instagram's login page and titles it accordingly, so
    the AI-generated title OVERWRITES the good one — which is exactly why the
    title looked correct until summarization completed and then got worse.

    Screening it here means such a save is marked `skipped` and costs ZERO AI
    actions, instead of paying for a summary of somebody's login form. Same
    principle as `is_link_only` above: refuse input that cannot produce output
    BEFORE spending anything on it.

    ponytail: a phrase list, not a classifier. It is checked only against the
    first {window} characters, because the wall leads with its blurb while a
    real caption that mentions logging in does not — that positional constraint
    is what keeps it from eating legitimate content. If a platform reworks its
    wall copy this silently stops matching, which fails SAFE (back to the old
    behaviour, one wasted AI action) rather than eating good captions. Revisit
    only if that shows up in the logs.
    """
    if not text:
        return False
    head = text[:_LOGIN_WALL_WINDOW].lower()
    return any(p in head for p in _LOGIN_WALL_PHRASES)


def _build_meta(info: dict, duration: int, transcript: str,
                cue_starts: list[float], caption: str) -> dict:
    """Structural signals about the parts of the video we cannot watch.

    Every field here is derived from data already in hand — no extra request, no
    extra token cost beyond a few lines of prompt. This is what lets a text-only
    pipeline reason about visual content instead of guessing.
    """
    meta: dict = {}
    # The platform LISTING caption tracks is a different fact from us managing to
    # download them — see pacing_hint().
    captions_offered = bool(info.get("automatic_captions") or info.get("subtitles"))
    pacing = pacing_hint(duration, transcript, cue_starts, captions_offered=captions_offered)
    if pacing:
        meta["pacing"] = pacing
    # yt-dlp resolves these for music-matched content. On TikTok/IG the audio IS
    # the format convention — a trending sound identifies the genre (comedic
    # fail, transformation, storytime) more reliably than any caption does.
    track, artist = info.get("track"), info.get("artist")
    if track:
        meta["track"] = f"{track} — {artist}" if artist else str(track)
    w, h = info.get("width") or 0, info.get("height") or 0
    if w and h:
        # 9:16 is native short-form. A 16:9 upload is repurposed long-form, where
        # the caption is usually a summary rather than the content itself.
        meta["aspect"] = "vertical (native short-form)" if h > w else "landscape (repurposed long-form)"
    tags = _HASHTAG.findall(caption or "")
    if tags:
        # The creator's own taxonomy. Passing it explicitly beats making the model
        # re-derive topic labels from hashtag soup buried in the caption body.
        meta["hashtags"] = " ".join(tags[:15])
    return meta


def extract_info(url: str) -> dict:
    platform = detect_platform(url)

    # Circuit open: this platform is actively refusing us. Skip straight to the
    # degraded result instead of spending 20s discovering that again and delaying
    # every queued save behind it.
    if circuit_open(platform):
        logger.info(f"[EXTRACT] {platform} circuit open — skipping fetch for {url}")
        return {
            "title": "", "caption": "", "transcript": "", "best_text": "",
            "thumbnail_url": "", "duration": 0, "platform": platform,
            "uploader": "", "needs_audio": False, "extracted": False,
            "blocked": True, "meta": {},
        }

    attempts = _youtube_attempts() if platform == "youtube" else [_BASE_YDL_OPTS]

    ydl_info = None
    last_err: Optional[Exception] = None
    for i, opts in enumerate(attempts):
        try:
            ydl_info = _run_ydl(url, opts)
            if ydl_info:
                if i > 0:
                    logger.info(f"[EXTRACT] {url} succeeded on fallback attempt #{i + 1}")
                break
        except Exception as e:
            last_err = e
            logger.warning(f"[EXTRACT] attempt #{i + 1} failed for {url}: {type(e).__name__}: {e}")
            continue

    # What yt-dlp gave us when it produced metadata but no readable text. Kept as
    # a floor for the fallback paths below, so falling through can only ADD.
    ydl_floor: dict = {}

    if ydl_info:
        title = clean_title_text(ydl_info.get("title") or "")
        description = ydl_info.get("description") or ""
        transcript, cue_starts = _get_captions(ydl_info)
        best_text = transcript or description
        thumb = _pick_thumbnail(ydl_info, platform)
        duration = int(ydl_info.get("duration") or 0)
        # yt-dlp with process=False can return a truthy but near-EMPTY shell for
        # gated platforms — notably Facebook, which yields a title and a
        # thumbnail and NO text at all. This guard used to read
        # `title or thumb or text`, which the title alone satisfied: the save
        # returned here, the public-og:/oEmbed fallbacks that actually carry a
        # Facebook caption were never tried, and every Facebook save became a
        # login-walled card with a picture on it. TEXT is what this branch has
        # to have — the fallbacks cannot improve on a transcript, but they are
        # the only source of one when yt-dlp has none.
        if best_text.strip():
            record_result(platform, True)
            return {
                "title": title,
                "caption": description,
                "transcript": transcript,
                "best_text": best_text,
                "thumbnail_url": thumb,
                "duration": duration,
                "platform": platform,
                "uploader": ydl_info.get("uploader") or "",
                "needs_audio": not best_text or len(best_text.strip()) < 40,
                # Only "extracted" (cacheable / not junk) if we actually got something.
                "extracted": bool((best_text or "").strip()) or bool(thumb),
                "meta": _build_meta(ydl_info, duration, transcript, cue_starts, description),
            }
        # No text. Keep whatever metadata yt-dlp did produce and go looking for
        # the words elsewhere; the fallbacks below merge this back in.
        ydl_floor = {
            "title": title, "thumb": thumb,
            "uploader": ydl_info.get("uploader") or "", "duration": duration,
        }
        logger.info(f"[EXTRACT] yt-dlp returned no text for {url} — trying page-meta/oEmbed fallback")

    if last_err:
        logger.error(f"[EXTRACT] all yt-dlp attempts failed for {url}: {type(last_err).__name__}: {last_err}")

    # yt-dlp failed. Graceful degradation depends on the platform:
    #
    # YouTube's watch page is huge and gated ("prove you're not a bot" on datacenter
    # IPs). Don't regex-parse it — use the lightweight public oEmbed endpoint, which
    # still answers from datacenter IPs and gives a clean title + thumbnail. We lose
    # the transcript (the gated part), but the save degrades to a real bookmark
    # instead of timing out or failing.
    if platform == "youtube":
        meta = _youtube_oembed(url)
        title = meta.get("title") or ydl_floor.get("title") or ""
        thumb = meta.get("image") or ydl_floor.get("thumb") or ""
        uploader = meta.get("uploader") or ydl_floor.get("uploader") or ""

        # Last resort before giving up on text: the official Data API. yt-dlp and
        # the page scrape are both bot-blocked from datacenter IPs, so on the
        # deployed backend this is the only path that returns a description —
        # without it every YouTube save here becomes a link-only bookmark.
        api = _youtube_data_api(url)
        description = api.get("description") or ""
        if description:
            logger.info(f"[YT-API] recovered {len(description)} chars for {url}")
        title = title or api.get("title") or ""
        thumb = thumb or api.get("thumbnail") or ""
        uploader = uploader or api.get("uploader") or ""

        record_result(platform, bool(title or thumb))
        return {
            "title": title or "YouTube Short",
            "caption": description,
            "transcript": "",
            "best_text": description,
            "thumbnail_url": thumb,
            "duration": 0,
            "platform": platform,
            "uploader": uploader,
            "needs_audio": False,
            # True when even oEmbed gave nothing — i.e. fully blocked / private.
            "blocked": not (title or thumb),
            "login_required": not (title or thumb),
            # Cache the bookmark-grade result so re-saving is instant.
            "extracted": bool(title or thumb),
            "meta": {},
        }

    # All platforms fall back to public page meta. The facebookexternalhit UA serves
    # the ungated link-preview surface — for LinkedIn this returns the FULL post body
    # via JSON-LD (~2.5k chars in practice), so no paid scraper is needed.
    page_meta = _extract_from_page(url)

    # ── Platform-native surfaces, tried AFTER the page but allowed to WIN ──
    #
    # Both work from a datacenter IP, which the page fallback does not: the page
    # fetch is why Instagram saves arrived with a thumbnail and no text from
    # Render while working perfectly in local testing. These are Instagram's own
    # embed iframe and Meta's own tokenless oEmbed — the caption is what they
    # exist to serve.
    #
    # Ordered "page first, then override" rather than replacing it, because the
    # page path still carries things these do not (og:image:alt, LinkedIn's
    # JSON-LD body). We only take a native result when it is genuinely richer.
    native: dict = {}
    if platform == "instagram":
        native = instagram_embed(url)
    elif platform == "facebook":
        native = facebook_oembed(url)

    title = page_meta.get("title") or ydl_floor.get("title") or ""
    description = page_meta.get("description") or ""
    if len((native.get("description") or "").strip()) > len(description.strip()):
        description = native["description"].strip()
    best_text = description
    image_alt = (page_meta.get("image_alt") or "").strip()

    structural: dict = {}
    if image_alt:
        structural["image_alt"] = image_alt
    tags = _HASHTAG.findall(description or "")
    if tags:
        structural["hashtags"] = " ".join(tags[:15])

    record_result(platform, bool(best_text or title or page_meta.get("image")))
    return {
        "title": title or f"{platform.capitalize()} Post",
        "caption": description,
        "transcript": "",
        "best_text": best_text,
        "thumbnail_url": page_meta.get("image") or native.get("image") or ydl_floor.get("thumb") or "",
        "duration": ydl_floor.get("duration") or 0,
        "platform": platform,
        "uploader": native.get("uploader") or ydl_floor.get("uploader") or "",
        "needs_audio": False,
        "login_required": not best_text,
        # Cache page extractions that actually yielded text (e.g. LinkedIn via JSON-LD).
        # image_alt counts: a post with no caption but a machine description of the
        # image is still summarizable, which is exactly the login-walled IG case.
        "extracted": len((best_text or "").strip()) >= 50 or len(image_alt) >= 50,
        "meta": structural,
    }


# Hard ceiling on audio downloads. Short-form clips are well under this; the cap
# stops a malformed/abusive URL from pulling a huge file and burning disk + bandwidth.
_MAX_AUDIO_BYTES = 50 * 1024 * 1024  # 50 MB


def cleanup_audio(path: str) -> None:
    """Remove a temp audio file and the directory download_audio made for it.

    Safe to call twice, and safe to call on a path that is already gone.
    """
    if not path:
        return
    shutil.rmtree(os.path.dirname(path), ignore_errors=True)


def download_audio(url: str) -> Optional[str]:
    """Download audio to a temp mp3 file. Returns file path or None on failure.

    On EVERY failure path this cleans up its own temp directory, and on success
    the caller owns cleanup via cleanup_audio().

    The previous contract delegated all cleanup to transcriber.transcribe()'s
    `finally` block — which is never reached, because transcribe() returns early
    when OPENAI_API_KEY is unset. An unconfigured deploy therefore leaked one
    temp directory per login-walled reel, permanently, until the disk filled.
    Two other paths leaked too: an exception here (mkdtemp already ran), and a
    download that produced no audio.mp3.

    ⚠️ `max_filesize` is compared against yt-dlp's REPORTED filesize. Fragmented
    HLS/DASH streams — what Instagram and TikTok serve — frequently report none,
    and the cap is then silently skipped. Treat it as advisory, not a guarantee.
    """
    tmp_dir = tempfile.mkdtemp()
    output_path = os.path.join(tmp_dir, "audio.%(ext)s")

    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "format": "bestaudio/best",
        "outtmpl": output_path,
        "socket_timeout": 15,
        "max_filesize": _MAX_AUDIO_BYTES,   # abort before downloading anything larger
        "postprocessors": [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "mp3",
            "preferredquality": "96",
        }],
        **({"proxy": _PROXY} if _PROXY else {}),
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
        audio_file = os.path.join(tmp_dir, "audio.mp3")
        if os.path.exists(audio_file):
            return audio_file
        logger.info(f"[AUDIO] no audio.mp3 produced for {url}")
    except Exception as e:
        logger.info(f"[AUDIO] download failed for {url}: {type(e).__name__}: {e}")
    shutil.rmtree(tmp_dir, ignore_errors=True)
    return None
