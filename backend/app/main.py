import logging
from urllib.parse import urlparse
import httpx
from fastapi import Depends, FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.ratelimit import rate_limit
from app.database import create_tables
from app.routes.reels import router as reels_router, recover_pending_summaries
from app.routes.workout import router as workout_router
from app.routes.ask import router as ask_router
from app.routes.account import router as account_router
from app.routes.todos import router as todos_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)

# Error monitoring — only active when SENTRY_DSN is set (prod). No DSN = no-op, so
# local/CI run untouched. Captures unhandled exceptions across all routes.
if settings.SENTRY_DSN:
    import sentry_sdk
    sentry_sdk.init(
        dsn=settings.SENTRY_DSN,
        environment=settings.ENV,
        # Sample 10% of requests for performance tracing — enough signal, low overhead.
        traces_sample_rate=0.1,
        # Don't attach request bodies; saved URLs/notes can be personal.
        send_default_pii=False,
    )
    logging.getLogger(__name__).info("[SENTRY] error monitoring enabled")

app = FastAPI(title="Findable API", version="1.0.0")

# Dev: allow any origin (any localhost port / Codespace tunnel). Production: read
# the allowlist from ALLOWED_ORIGINS (comma-separated). Defaults to "*" so a fresh
# deploy works before the web app's final domain is known — lock it down later.
if settings.ENV == "development":
    CORS_ORIGINS = ["*"]
else:
    CORS_ORIGINS = [o.strip() for o in settings.ALLOWED_ORIGINS.split(",") if o.strip()] or ["*"]

# allow_credentials must be False when origins is "*" (CORS spec). We don't use
# cookie auth yet, so this is safe; revisit when auth lands.
_allow_credentials = "*" not in CORS_ORIGINS

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=_allow_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(reels_router)
app.include_router(workout_router)
app.include_router(ask_router)
app.include_router(account_router)
app.include_router(todos_router)


@app.on_event("startup")
def startup():
    create_tables()
    # Heal summaries orphaned by a previous process death (instant-save runs the
    # summary in an in-process background task that doesn't survive a restart).
    recover_pending_summaries()


@app.get("/health")
def health():
    return {"status": "ok", "service": "Findable API"}


# A known-stable, short, public YouTube Short used for the live extraction probe.
_PROBE_URL = "https://www.youtube.com/shorts/SXHMnicI6Pg"


# Hosts `?url=` may point at. This endpoint is UNAUTHENTICATED and makes an
# outbound request on the caller's behalf, so without an allowlist it is a
# straightforward SSRF gadget — the same reasoning (and the same domain-suffix
# matching, not substring) as the thumbnail proxy's `_THUMB_HOSTS` below.
_PROBE_HOSTS = (
    "youtube.com", "youtu.be", "instagram.com", "facebook.com", "fb.watch",
    "tiktok.com", "linkedin.com",
    # Threads runs on both hosts — see detect_platform() for why .net stays.
    "threads.net", "threads.com",
    # LinkedIn's own shortener — every link the LinkedIn app shares is one of
    # these, and the probe is useless for LinkedIn shares without it.
    "lnkd.in",
)


def _probe_host_allowed(url: str) -> bool:
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return False
    # Suffix match on a DOTTED boundary: "youtube.com.evil.example" must not pass.
    return any(host == h or host.endswith("." + h) for h in _PROBE_HOSTS)


@app.get("/health/extract", dependencies=[Depends(rate_limit(10, 60, "health_extract"))])
def health_extract(live: bool = False, url: str | None = None):
    """Reports the installed yt-dlp version (the single biggest factor in save
    success rate). With ?live=1 it runs a real lightweight extraction against a
    known Short so breakage is caught before users hit it — wire this to uptime
    monitoring.

    ⚠️ `?url=` RUNS THE PROBE AGAINST A SPECIFIC LINK, FROM THE SERVER'S OWN IP.
    That is the whole point of it: extraction that works from a laptop proves
    nothing, because YouTube and Instagram bot-block datacenter ranges and a
    residential connection is not the environment that fails (see docs/CONTEXT.md
    §4 and the TODO gotcha "Testing locally does NOT prove it works on Render").
    Reproducing a user's failing save previously meant guessing; now it is
        GET /health/extract?live=1&url=<the link that failed>
    and the response says how much text came back and why it was rejected.

    Restricted to known platform hosts (SSRF) and rate-limited. It reports
    LENGTHS and verdicts, never the extracted content — this is a diagnostic,
    not an open scraping proxy.
    """
    import time
    import yt_dlp
    from app.services import extractor

    target = _PROBE_URL
    if url:
        if not _probe_host_allowed(url):
            raise HTTPException(
                status_code=400,
                detail="Probe URL must be a supported platform link (YouTube, Instagram, Facebook, TikTok, LinkedIn).",
            )
        target = url

    # Circuit state is the difference between "a user says saves are broken" and
    # a dashboard telling you Instagram started refusing us 40 minutes ago.
    info = {
        "status": "ok",
        "yt_dlp_version": yt_dlp.version.__version__,
        "breakers": extractor.breaker_state(),
        "proxy_configured": bool(extractor._PROXY),
    }
    if not live:
        return info

    started = time.monotonic()
    try:
        result = extractor.extract_info(target)
        text = (result.get("best_text") or "").strip()
        has_thumb = bool(result.get("thumbnail_url"))

        # ⚠️ `probe_ok` USED TO PASS ON A THUMBNAIL ALONE — TODO.md called this
        # out as a known blind spot, and it is exactly why "YouTube descriptions
        # fail 9 times out of 10" could not be confirmed or denied from
        # production: the one instrument pointed at the problem could not see
        # it. A green probe meant "we got *something*", which for a bot-blocked
        # extraction is a thumbnail and nothing else — the precise failure being
        # investigated.
        #
        # `probe_ok` is now TEXT-based, and every input to that judgement is
        # reported separately so a degraded result says WHICH half broke.
        # A thumbnail-only result is `degraded`, not `ok`.
        text_ok = len(text) >= 50 and not extractor.is_link_only(text)
        info.update({
            "status": "ok" if text_ok else ("degraded" if has_thumb else "down"),
            "probe_ok": text_ok,
            "probe_url": target,
            "probe_text_len": len(text),
            "probe_link_only": extractor.is_link_only(text) if text else False,
            "probe_login_wall": extractor.is_login_wall(text) if text else False,
            "probe_title_len": len((result.get("title") or "").strip()),
            "probe_has_thumbnail": has_thumb,
            "probe_needs_audio": bool(result.get("needs_audio")),
            "probe_ms": int((time.monotonic() - started) * 1000),
        })
    except Exception as e:
        info.update({"status": "down", "probe_ok": False, "probe_url": target,
                     "error": f"{type(e).__name__}: {e}"})
    # Re-read AFTER the probe. `breakers` was captured when `info` was built —
    # i.e. BEFORE extract_info ran and called record_result — so a failing probe
    # was returned next to a breaker count that hadn't registered it yet. Two
    # different moments in one response is precisely the wrong thing to hand
    # someone debugging a live block.
    info["breakers"] = extractor.breaker_state()
    return info


# Image hosts we'll proxy. Restricted to known media CDNs to avoid SSRF.
_THUMB_HOSTS = (
    "fbcdn.net", "cdninstagram.com", "licdn.com", "ytimg.com",
    "tiktokcdn.com", "tiktokcdn-us.com", "twimg.com",
)
_THUMB_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept": "image/avif,image/webp,image/*,*/*;q=0.8",
}


# Unauthenticated endpoint at 120 req/min/IP, so an unbounded read is a cheap
# OOM: 120 slots times one oversized asset is far past a 512 MB instance.
_MAX_THUMB_BYTES = 5 * 1024 * 1024
_MAX_THUMB_REDIRECTS = 3


def _thumb_host_ok(url: str) -> bool:
    """https + a suffix match on domain-label boundaries. A plain substring check
    would let "ytimg.com.evil.example" through and turn this into an open proxy."""
    parsed = urlparse(url)
    if parsed.scheme != "https":
        return False
    host = (parsed.hostname or "").lower().rstrip(".")
    return any(host == h or host.endswith("." + h) for h in _THUMB_HOSTS)


@app.get("/api/thumbnail", dependencies=[Depends(rate_limit(120, 60, "thumbnail"))])
def thumbnail(url: str):
    """Proxy a media-CDN image so it loads on web (Instagram/Facebook CDNs block
    browser hotlinking via CORS). Native loads the URL directly and skips this."""
    if not _thumb_host_ok(url):
        raise HTTPException(status_code=400, detail="Host not allowed")
    try:
        # Redirects are followed MANUALLY so the allowlist is re-applied to every
        # hop. Validating only the initial URL while httpx followed redirects
        # itself made this an SSRF: an open redirect on any allowed CDN host
        # would be chased straight to the cloud metadata endpoint or any internal
        # address, because httpx applies no host policy of its own.
        with httpx.Client(follow_redirects=False, timeout=10, headers=_THUMB_HEADERS) as c:
            for _ in range(_MAX_THUMB_REDIRECTS):
                r = c.get(url)
                if r.status_code not in (301, 302, 303, 307, 308):
                    break
                nxt = r.headers.get("location") or ""
                url = str(httpx.URL(url).join(nxt)) if nxt else ""
                if not _thumb_host_ok(url):
                    raise HTTPException(status_code=400, detail="Host not allowed")
            else:
                raise HTTPException(status_code=502, detail="Too many redirects")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=502, detail="Could not fetch image")

    if r.status_code != 200:
        raise HTTPException(status_code=502, detail="Could not fetch image")
    if not r.headers.get("content-type", "").startswith("image/"):
        raise HTTPException(status_code=502, detail="Not an image")
    if len(r.content) > _MAX_THUMB_BYTES:
        raise HTTPException(status_code=502, detail="Image too large")

    return Response(
        content=r.content,
        media_type=r.headers.get("content-type", "image/jpeg"),
        headers={"Cache-Control": "public, max-age=86400"},
    )
