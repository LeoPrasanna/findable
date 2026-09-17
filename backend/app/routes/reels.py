from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
import uuid
import re
import threading
import time
import logging
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor

from app.config import settings
from app.database import get_db, SessionLocal, ReelDB, ExtractionCacheDB, TaskDB, WorkoutExerciseDB, TodoDB
from app.routes.models.reel import (
    ReelSaveRequest, ReelNotesRequest, ReelCategoryRequest, ReelResponse, ReelListResponse,
    ClientMetadataRequest,
)
from app.services import extractor, transcriber, summarizer
from app.ratelimit import rate_limit
from app.quota import charge_ai_action
from app.entitlements import entitlements_for
from app.auth import get_current_user, AuthUser
from app.sharekey import user_for_share

logger = logging.getLogger(__name__)

# The single set of categories a reel can belong to (auto-assigned or user-picked).
# Keep in sync with the summarizer prompt and mobile CATEGORY_OPTIONS (theme.ts).
ALLOWED_CATEGORIES = {
    "fitness", "cooking", "tech", "motivation", "education", "entertainment",
    "fashion", "beauty", "travel", "business", "news", "health", "finance",
    "hobby", "shopping", "other",
}

# Every background extraction/summary runs here, and ONLY here.
#
# ⚠️ Why this is not a FastAPI BackgroundTask any more. Starlette runs a sync
# BackgroundTask via run_in_threadpool, i.e. on anyio's default 40-token pool —
# the very same pool every `def` route handler draws from. A save therefore held
# one of those 40 tokens for its whole 20s+ chain while ALSO occupying a worker
# here, so ~40 concurrent saves starved the entire API: list, detail, health and
# thumbnails all stopped responding until extractions drained. Submitting
# straight to our own pool keeps request handling and background work on
# separate budgets, so a burst of saves degrades save latency and nothing else.
_executor = ThreadPoolExecutor(max_workers=8, thread_name_prefix="extract")
CACHE_TTL_DAYS = 14       # re-extract if the cached entry is older than this


def _enqueue(fn, *args) -> None:
    """Run `fn` off the request path without holding an anyio threadpool token.

    Single dispatch point on purpose: it is the seam tests patch to run the chain
    inline, and the one place to swap in a real queue if saves ever need to be
    durable rather than best-effort.
    """
    try:
        _executor.submit(fn, *args)
    except RuntimeError:                    # interpreter shutting down
        logger.warning("[ENQUEUE] executor unavailable — reel left pending for recovery")


# A FAILED extraction is worth remembering for minutes, not for the 14-day
# success TTL. _is_cacheable() correctly refuses to cache text-less results (that
# fix stopped a blocked IP poisoning a URL for a fortnight) — but the flip side is
# that a currently-blocked URL is re-attempted by every user who saves it. One
# trending reel then becomes a hundred requests against a host that is already
# refusing us, which is precisely how a soft rate-limit escalates to a hard IP
# ban. This is the missing half of that fix.
#
# Deliberately in-memory: losing it on restart is CORRECT (a restart is a fine
# moment to retry), and it must never be mistaken for a cache hit by save_reel().
NEGATIVE_TTL = 900        # seconds
_negative: dict[str, float] = {}
_negative_lock = threading.Lock()


def _recently_failed(url: str) -> bool:
    with _negative_lock:
        if _negative.get(url, 0) > time.monotonic():
            return True
        _negative.pop(url, None)
        return False


def _mark_failed(url: str) -> None:
    with _negative_lock:
        if len(_negative) > 2000:
            now = time.monotonic()
            # ponytail: O(n) sweep, but n is capped at 2k so it is microseconds.
            # Revisit only if this ever needs to hold six figures of URLs.
            for k, v in list(_negative.items()):
                if v <= now:
                    _negative.pop(k, None)
        _negative[url] = time.monotonic() + NEGATIVE_TTL

# Throttle cache pruning so we don't scan/delete on every save.
_PRUNE_INTERVAL = 3600    # seconds between prune attempts
_last_prune = 0.0

# Max orphaned summaries to re-enqueue on startup (see recover_pending_summaries).
PENDING_RECOVERY_LIMIT = 25

router = APIRouter(prefix="/api/reels", tags=["reels"])


def _get_owned_reel_or_404(reel_id: str, user: AuthUser, db: Session) -> ReelDB:
    """Fetch a reel the caller owns, else 404. A 404 (not 403) on someone else's
    reel avoids leaking that the id exists."""
    reel = (
        db.query(ReelDB)
        .filter(ReelDB.id == reel_id, ReelDB.user_id == user.id)
        .first()
    )
    if not reel:
        raise HTTPException(status_code=404, detail="Reel not found")
    return reel


@router.post("/save", response_model=ReelResponse, dependencies=[Depends(rate_limit(20, 60, "save"))])
def save_reel(body: ReelSaveRequest,
              user: AuthUser = Depends(get_current_user), db: Session = Depends(get_db)):
    """Instant save: the card is persisted and returned in one DB round-trip.

    Nothing slow runs on the request path — extraction (2–20 s of network),
    the quota charge and the Claude summary all happen in ONE background chain
    (`_extract_and_summarize`), flipping `summary_status` pending→ready as
    fields land. Cache hits skip extraction and go straight to the summary.
    The client polls the reel (it already does for summaries) and watches
    title/thumbnail/summary fill in."""
    _prune_cache_if_due(db)
    canonical_url = extractor.normalize_url(body.url)

    # Dedup per-user: the same link saved by another user is a separate card.
    existing = (
        db.query(ReelDB)
        .filter(ReelDB.url == canonical_url, ReelDB.user_id == user.id)
        .first()
    )
    if existing:
        return _to_response(existing)

    # Post-trial free tier: total saves are capped. Enforced here (server-side,
    # before the card is created) and only for NEW saves — the library itself is
    # never locked, and deleting below the cap re-opens saving. Soft cap under
    # concurrency (two parallel saves at 19 can land 21) — acceptable.
    ent = entitlements_for(user, db)
    if ent.save_limit is not None:
        saved = db.query(ReelDB).filter(ReelDB.user_id == user.id).count()
        if saved >= ent.save_limit:
            raise HTTPException(
                status_code=403,
                # ⚠️ THE UPSELL IS TIER-AWARE, and must stay that way. Pro
                # carries its own (larger) cap, so telling a Pro user at 500
                # that "Pro unlocks more" sells them what they already bought —
                # the one message guaranteed to read as a bug. Free and trial
                # get the upgrade line because for them it is simply true.
                detail=(
                    f"Your library is full ({ent.save_limit} saves). "
                    + ("Delete a save to make room."
                       if ent.tier == "pro"
                       else f"Delete a save to make room — or Pro raises this to "
                            f"{settings.PRO_SAVE_LIMIT}.")
                ),
            )

    # The only sync validation: is this a link we recognize at all?
    platform = extractor.detect_platform(canonical_url)
    if platform in (None, "", "unknown"):
        raise HTTPException(
            status_code=422,
            detail="Couldn't recognize this link. Try a public YouTube Short, Instagram Reel, TikTok, Threads, LinkedIn or Facebook post.",
        )

    # Cache-first: a prior successful extraction (even of a since-deleted reel)
    # fills the card immediately — no background extraction needed.
    info = _get_cached_extraction(db, canonical_url)

    if info is not None:
        logger.info(f"[SAVE] cache hit for {canonical_url}")
        reel = _reel_from_info(user.id, canonical_url, info)
        _apply_duration_guard(reel)
        should_summarize = reel.summary_status == "pending"
        if should_summarize and not _try_charge(db, user, reel.title or canonical_url):
            # Over budget: keep the card, skip the AI. No Claude call happens.
            reel.summary_status = QUOTA_STATUS
            should_summarize = False
        db.add(reel)
        db.commit()
        db.refresh(reel)
        if should_summarize:
            _enqueue(_summarize_reel, reel.id, user=user)
        logger.info(f"[SAVE] success (cached) platform={reel.platform} id={reel.id}")
        return _to_response(reel)

    # Instant path: persist a pending card NOW; extract + charge + summarize
    # in the background. The card appears in ~200 ms instead of 2–20 s.
    reel = ReelDB(
        id=str(uuid.uuid4()),
        user_id=user.id,
        url=canonical_url,
        platform=platform,
        title=None,
        thumbnail_url=None,
        uploader=None,
        duration=None,
        summary=[],
        tags=[],
        category="other",
        raw_text=None,
        summary_status="pending",
        created_at=datetime.utcnow(),
    )
    db.add(reel)
    db.commit()
    db.refresh(reel)
    _enqueue(_extract_and_summarize, reel.id, user)
    logger.info(f"[SAVE] accepted (async extract) platform={platform} id={reel.id}")
    return _to_response(reel)


def _reel_from_info(user_id: str, url: str, info: dict) -> ReelDB:
    """Build an (unsaved) reel row from an extraction info dict."""
    title = info.get("title")
    if not (info.get("best_text") or "").strip() and not info.get("thumbnail_url"):
        # Link-only bookmark (e.g. login-walled) — give it a clean label.
        if _weak_title(title):
            kind = "Reel" if "/reel" in url.lower() else "Post"
            title = f"{(info.get('platform') or 'web').capitalize()} {kind}"
    raw_text = (info.get("best_text") or "").strip()
    # A caption that is only "Follow us on Instagram" plus three URLs clears the
    # length bar (150 chars looks like content) but has nothing to summarize.
    # Charging an AI action to be told low_content:true is pure waste — measured
    # on a real save: 2048 input tokens spent for an empty summary.
    # `is_login_wall` joins `is_link_only` here for the same reason: it is text
    # that LOOKS summarizable and cannot produce a summary of the reel. Without
    # it we pay Claude to describe Instagram's sign-in page and then let the
    # AI-generated title overwrite the real one.
    should_summarize = (
        (len(raw_text) >= 50
         and not extractor.is_link_only(raw_text)
         and not extractor.is_login_wall(raw_text))
        or bool(info.get("needs_audio"))
    )
    return ReelDB(
        id=str(uuid.uuid4()),
        user_id=user_id,
        url=url,
        platform=info.get("platform") or "unknown",
        title=title,
        thumbnail_url=info.get("thumbnail_url"),
        uploader=info.get("uploader"),
        duration=info.get("duration"),
        summary=[],
        tags=[],
        category="other",
        raw_text=raw_text,
        summary_status="pending" if should_summarize else "skipped",
        created_at=datetime.utcnow(),
    )


def _apply_duration_guard(reel: ReelDB) -> None:
    """Long-form content isn't summarized (cost guard) — the card stays as a
    link-only bookmark instead of being rejected after the fact."""
    if (reel.duration or 0) > 600:
        reel.summary_status = "skipped"
        reel.raw_text = None


# Written to `summary_status` when the save is kept but the AI step was never
# attempted because the user's daily allowance is gone.
#
# ⚠️ WHY THIS IS NOT `failed`. Both are "no summary", but they are different
# facts and the UI has to tell them apart: `failed` means something broke and
# retrying now may work, so the card offers a Try again button. Over quota,
# retrying CANNOT work until the reset — a retry button there is a button that
# spends nothing and does nothing, all day. Calling it `failed` also told the
# user their save had gone wrong when it hadn't.
#
# For the record on cost: no Claude call was ever made in this state. The charge
# is taken BEFORE the API call precisely so a refused charge short-circuits the
# whole chain — the tokens were never spent, only the status was misreported.
QUOTA_STATUS = "quota_exceeded"


def _try_charge(db: Session, user: AuthUser, label: str | None = None) -> bool:
    """Charge one AI action; False when today's budget is spent (never raises).

    Returning False is the gate that keeps a quota-exhausted save free: every
    caller must skip the summarizer entirely rather than call it and hope."""
    try:
        charge_ai_action(db, user, action="summary", label=label)
        return True
    except HTTPException as e:
        if e.status_code != status.HTTP_429_TOO_MANY_REQUESTS:
            raise
        logger.info(f"[SAVE] AI quota spent for user {user.id} — saving without summary")
        return False


def _extract_and_summarize(reel_id: str, user: AuthUser | None) -> None:
    """Background chain for the instant-save path: extract metadata, fill the
    card, charge the quota, then run the summary. Every failure degrades the
    card gracefully (link-only bookmark / retryable 'failed') — it never
    disappears on the user. `user=None` (recovery path) skips the quota charge."""
    db = SessionLocal()
    try:
        reel = db.query(ReelDB).filter(ReelDB.id == reel_id).first()
        if not reel:
            return

        # Already summarized → stop. This chain is re-run by
        # recover_pending_summaries on every startup, and Render's free tier kills
        # in-flight background tasks on each spin-down, so a save that already
        # succeeded can be extracted a second time. If that second extraction comes
        # back empty (blocked IP, deleted post), the fill below would overwrite a
        # good summary's status with 'skipped' — leaving real, already-paid-for
        # summary text invisible in the app. Re-extracting also can't help here:
        # the summary exists, so there is nothing left to gain.
        if reel.summary:
            logger.info(f"[EXTRACT-BG] {reel_id} already has a summary — skipping re-extraction")
            return

        if _recently_failed(reel.url):
            # This URL failed within the negative-cache window. Retrying now would
            # add load to a host that is already refusing us and would fail the
            # same way. Leave the card pending so recovery retries it later.
            logger.info(f"[EXTRACT-BG] {reel_id} skipped — {reel.url} failed recently")
            return

        # Called directly, NOT via _executor.submit(). We are already running ON
        # that pool, so submitting back into it deadlocks once the pool is full.
        # The old future.result(timeout=EXTRACT_TIMEOUT) also never bounded the
        # work — it only freed the waiter, while the yt-dlp thread kept running
        # and held its worker forever. Real bounds are per-operation:
        # socket_timeout/retries in _BASE_YDL_OPTS plus explicit httpx timeouts.
        try:
            info = extractor.extract_info(reel.url)
        except Exception as e:
            logger.error(f"[EXTRACT-BG] failed for {reel_id} ({reel.url}): {type(e).__name__}: {e}")
            _mark_failed(reel.url)
            # Keep the bookmark: clean label, honest 'failed' so the UI offers retry.
            kind = "Reel" if "/reel" in reel.url.lower() else "Post"
            reel.title = reel.title or f"{(reel.platform or 'web').capitalize()} {kind}"
            reel.summary_status = "failed"
            db.commit()
            return

        if not (info.get("best_text") or "").strip() and not info.get("thumbnail_url"):
            # Nothing usable came back — almost always a live block. Remember it
            # briefly so the next hundred saves of this URL don't pile on.
            _mark_failed(reel.url)

        # Only cache an extraction that actually carries content. `extracted` is
        # True as soon as a title or thumbnail comes back, so caching on that alone
        # stored text-less results — permanently poisoning the URL for the cache's
        # 14-day TTL. An extraction with nothing to summarize is precisely the one
        # worth retrying later, so it must not be cached.
        if info.get("extracted") and _is_cacheable(info):
            _store_extraction(db, reel.url, info)

        filled = _reel_from_info(reel.user_id, reel.url, info)
        # ⚠️ RE-READ BEFORE FILLING. The block below reasons carefully about the
        # client-metadata endpoint having populated this row mid-extraction —
        # and then acted on the copy loaded BEFORE that happened, which made the
        # whole "only replace with something better" rule compare against stale
        # values. `reel.title` was still the "Instagram Reel" placeholder in this
        # session even after the phone had delivered the real one, so
        # `_weak_title(reel.title)` said True and the placeholder was written
        # straight back over it. That is the "title is right, then the summary
        # finishes and it reverts to Instagram Reel" report (owner, 2026-08-12).
        #
        # The refresh costs one SELECT on a path that has just spent seconds in
        # yt-dlp, and it is what makes every guard below actually compare
        # against what is IN THE DATABASE rather than what was there when this
        # background task started.
        db.refresh(reel)

        # Non-destructive fill. The client-metadata endpoint may have already
        # populated this row from the user's own IP (see client_metadata) while
        # this background extraction was still running — a blocked server extract
        # returns empty fields, and blindly assigning them would wipe good data.
        # Rule: only ever replace a field with something better, never with less.
        reel.platform = filled.platform if filled.platform != "unknown" else reel.platform
        # Same login-wall screen as client_metadata below — the server's own
        # extraction can be handed the wall too, and a wall title must never win.
        if filled.title and not _is_login_wall_title(filled.title) and _weak_title(reel.title):
            reel.title = filled.title
        if filled.thumbnail_url:
            reel.thumbnail_url = filled.thumbnail_url
        if filled.uploader:
            reel.uploader = filled.uploader
        if filled.duration:
            reel.duration = filled.duration
        server_text = (filled.raw_text or "").strip()
        if len(server_text) >= len((reel.raw_text or "").strip()):
            reel.raw_text = filled.raw_text
            reel.summary_status = filled.summary_status
        elif reel.summary_status == "skipped":
            # Client text is the better source and nothing has summarized it yet.
            reel.summary_status = "pending"
        _apply_duration_guard(reel)
        db.commit()

        if reel.summary_status != "pending":
            logger.info(f"[EXTRACT-BG] {reel_id} filled — no summary needed")
            return

        # Re-read before spending anything. The guard at the top of this function
        # ran BEFORE extraction; the client-metadata endpoint routinely lands a
        # full summary during the 2-20s we were away (the app posts it about a
        # second after /save). Without this re-check the non-destructive fill
        # above resets summary_status to 'pending' and we charge the user a
        # second AI action and make a second Claude call for a reel that is
        # already summarized — a real double-spend on a very common timing.
        db.refresh(reel)
        if reel.summary:
            reel.summary_status = "ready"
            db.commit()
            logger.info(f"[EXTRACT-BG] {reel_id} summarized concurrently — not re-charging")
            return

        if user is not None and not _try_charge(db, user, reel.title or reel.url):
            # Extraction already ran and is FREE — the card keeps its title and
            # thumbnail. Only the paid step is skipped.
            reel.summary_status = QUOTA_STATUS
            db.commit()
            return
        meta = info.get("meta") or {}
    finally:
        db.close()

    # Own session inside; commits the summary result. `meta` is passed in memory
    # rather than persisted: it is only available on a fresh extraction, and the
    # summary runs immediately afterwards.
    # ponytail: re-summarize and cache-hit saves get no pacing hint. Add a JSON
    # `meta` column on ReelDB + ExtractionCacheDB if that quality gap shows up.
    _summarize_reel(reel_id, meta=meta, user=user)


@router.post("/share-save", response_model=ReelResponse,
             dependencies=[Depends(rate_limit(20, 60, "save"))])
def share_save_reel(body: ReelSaveRequest,
                    user: AuthUser = Depends(user_for_share),
                    db: Session = Depends(get_db)):
    """The Android invisible-share entry point. Identical work to `/save`,
    reached with a share key instead of a Supabase JWT.

    ⚠️ WHY A SECOND URL RATHER THAN `/save` ACCEPTING EITHER CREDENTIAL. The
    no-display share Activity runs outside the JS runtime and has no Supabase
    session to send (app/sharekey.py explains why reading or refreshing the
    access token natively were both rejected). Giving the share key its own
    route is what makes its scope checkable by reading the routing table: it
    authenticates exactly one endpoint, and that endpoint only creates. No
    read, no delete, no AI action, no account access.

    The body is `save_reel` itself, so the two paths cannot drift.
    """
    return save_reel(body, user, db)


@router.get("", response_model=ReelListResponse)
def list_reels(
    tag: str = None,
    category: str = None,
    platform: str = None,
    limit: int = 1000,
    offset: int = 0,
    user: AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """`total` is the full count for the active filter; `items` is the requested
    page. Clients paginate with limit/offset and stop when offset+len >= total.
    Default limit is high so callers that just want counts (Landing) still work."""
    limit = max(1, min(limit, 1000))
    offset = max(0, offset)

    query = db.query(ReelDB).filter(ReelDB.user_id == user.id)
    if platform:
        query = query.filter(ReelDB.platform == platform)
    if category:
        query = query.filter(ReelDB.category == category)

    if tag:
        # tags is a JSON array — SQLite can't index into it, so filter in Python
        # over the full set, then slice the page.
        rows = query.order_by(ReelDB.created_at.desc()).all()
        matched = [r for r in rows if r.tags and tag.lower() in [t.lower() for t in r.tags]]
        total = len(matched)
        page = matched[offset:offset + limit]
    else:
        total = query.count()
        page = query.order_by(ReelDB.created_at.desc()).offset(offset).limit(limit).all()

    return ReelListResponse(total=total, items=[_to_response(r) for r in page])


# ⚠️ `GET /search` lived here until 2026-08-10, backed by services/search.py
# (tokenizing, stopwords, synonym groups, category matching, relevance ranking).
# It was deleted with the module: the mobile header search field was removed in
# PR #39, which left the whole vertical with no reachable caller — code running
# in CI that no user could ever hit. Recover it from git if search comes back;
# at that point reconsider embeddings rather than restoring the lexical ranker,
# which was always documented as the pre-scale step.


@router.get("/{reel_id}", response_model=ReelResponse)
def get_reel(reel_id: str, user: AuthUser = Depends(get_current_user), db: Session = Depends(get_db)):
    reel = _get_owned_reel_or_404(reel_id, user, db)
    return _to_response(reel)


@router.post("/{reel_id}/resummarize", response_model=ReelResponse, dependencies=[Depends(rate_limit(10, 60, "resummarize"))])
def resummarize_reel(reel_id: str, user: AuthUser = Depends(get_current_user), db: Session = Depends(get_db)):
    """No per-reel retry cap: every call charges the per-user daily AI quota
    (the real cost ceiling), and the per-IP burst guard stops loops. The old
    3-per-reel limit was a redundant second guard from before the quota existed."""
    reel = _get_owned_reel_or_404(reel_id, user, db)

    # Combine the extracted text with the user's notes so notes they deliberately
    # add always shape the re-summary — raw_text alone used to shadow them entirely,
    # so adding notes to a reel that already had some caption did nothing.
    source_text = "\n\n".join(
        p.strip() for p in (reel.raw_text, reel.notes) if p and p.strip()
    )
    if not source_text:
        raise HTTPException(
            status_code=422,
            detail="No content to summarize. Paste the post text into Notes first, then re-summarize."
        )

    # Per-user daily AI budget (shared across all AI actions). Charged before the call.
    charge_ai_action(db, user, action="resummarize", label=reel.title or reel.url)

    try:
        ai = summarizer.summarize(
            platform=reel.platform,
            title=reel.title or "",
            text=source_text,
        )
    except Exception as e:
        # summarize() now raises on a truncated or unparseable response instead
        # of quietly returning an empty summary. That is the right signal, but it
        # must not reach the client as a stack trace: the charge already happened
        # and the user needs a sentence they can act on.
        logger.error(f"[RESUMMARIZE] {reel.id} failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=503,
            detail="The summarizer is having trouble right now. Please try again in a moment.",
        )

    if not ai["summary"]:
        # Message depends on WHY it's empty: if the user already added notes and
        # it still came back empty, "add notes" is contradictory — the content is
        # just thin (often pure entertainment with no takeaways). Only point them
        # at notes when there genuinely are none.
        had_notes = bool((reel.notes or "").strip())
        detail = (
            "Couldn't pull clear takeaways from this — it may just be "
            "entertainment with no key insights to capture. Your note is still "
            "saved on the card."
            if had_notes else
            "Re-summarize found no readable content — this reel has no caption or "
            "transcript we can read. Add a note describing it, then re-summarize."
        )
        raise HTTPException(status_code=422, detail=detail)

    reel.summary = ai["summary"]
    reel.tags = ai["tags"]
    reel.category = ai["category"]
    # LATCH, never overwrite: the model may SET the sensitive flag but can never
    # CLEAR it. Notes and captions are untrusted prompt input — a steered reply
    # ("this isn't medical, sensitive=false") must not be able to lift the
    # medical containment. False positive escape hatch: delete + re-save.
    reel.is_sensitive = bool(reel.is_sensitive) or bool(ai.get("sensitive", False))
    # ⚠️ The MODEL'S title is screened too. It is generated from `raw_text`, so
    # if login-wall content ever reaches the summarizer the model writes an
    # accurate title for the wrong page ("Login • Instagram") and this line
    # installs it OVER the good one — which is why the title used to look right
    # until the summary landed. `is_login_wall` upstream should stop that text
    # arriving at all; this is the backstop for the case where it doesn't.
    if _weak_title(reel.title) and ai.get("title") and not _is_login_wall_title(ai["title"]):
        reel.title = ai["title"]
    reel.summarize_count = (reel.summarize_count or 0) + 1
    db.commit()
    db.refresh(reel)
    return _to_response(reel)


@router.post("/{reel_id}/summarize", response_model=ReelResponse, dependencies=[Depends(rate_limit(10, 60, "summarize"))])
def summarize_now(reel_id: str, user: AuthUser = Depends(get_current_user), db: Session = Depends(get_db)):
    """Run (or retry) the background summary synchronously for one reel. Used by the
    detail screen to retry a 'failed'/'pending' summary or to summarize on demand.
    A reel already summarized is returned untouched (use resummarize to redo it)."""
    reel = _get_owned_reel_or_404(reel_id, user, db)
    if reel.summary_status == "ready" and reel.summary:
        return _to_response(reel)

    # 'skipped' means a prior run already found nothing readable (and the audio
    # fallback failed) — retrying would charge the user's budget for a guaranteed
    # skip. Point them at notes + re-summarize instead.
    if reel.summary_status == "skipped" and len((reel.raw_text or "").strip()) < 50:
        raise HTTPException(
            status_code=422,
            detail="There's nothing readable in this reel to summarize. Paste the post text into Notes, then use re-summarize.",
        )

    # Per-user daily AI budget — only charged when we actually run the summary (a
    # reel already 'ready' returned above without spending a unit).
    charge_ai_action(db, user, action="summary", label=reel.title or reel.url)

    # ⚠️ NO `user=` HERE, AND THAT IS NOT AN OVERSIGHT. Passing the user would
    # hand a free-tier reel the cheap index pass — but the user has just been
    # charged an AI action for a summary, on a path they asked for by name. The
    # tier gate exists for AUTOMATIC summaries on save; a paid-for one is
    # always the full thing. Do not "fix" this by threading the user through.
    _summarize_reel(reel.id)        # own session; commits the result
    db.refresh(reel)                # pull the freshly-committed row into this session
    return _to_response(reel)


# Minimum characters that make text worth sending to Claude — same bar the
# extractor uses for should_summarize, kept in sync deliberately.
_MIN_SUMMARIZABLE = 50


@router.post("/{reel_id}/client-metadata", response_model=ReelResponse,
             dependencies=[Depends(rate_limit(20, 60, "client_metadata"))])
def client_metadata(reel_id: str, body: ClientMetadataRequest,
                    user: AuthUser = Depends(get_current_user), db: Session = Depends(get_db)):
    """Accept metadata the CLIENT fetched from the user's own IP, for links our
    server can't read (Instagram/Facebook block datacenter IPs — see docs/CONTEXT.md
    §4). The app posts this right after /save; the card is already on screen, so
    this never delays the save.

    Trust model — this is untrusted client input:
      * sizes are capped by the pydantic model (oversize -> 422),
      * the reel must belong to the caller (`_get_owned_reel_or_404` -> 404),
      * the posted URL must match the reel's URL after normalization, so a client
        can't attach text harvested from one link onto a different reel,
      * SERVER DATA ALWAYS WINS: if our own extraction already produced usable
        text, the payload is ignored. A lying client can therefore only influence
        saves the server could not read at all — and that text is already fenced
        as untrusted by the summarizer prompt + the one-way is_sensitive latch.
    """
    reel = _get_owned_reel_or_404(reel_id, user, db)

    if extractor.normalize_url(body.url) != reel.url:
        raise HTTPException(status_code=422, detail="This metadata doesn't belong to that saved link.")

    # Server extraction already produced something usable → keep it, spend nothing.
    #
    # "Usable" is a QUALITY test, not just a length one. This guard used to be
    # length-only, which meant 150 characters of "Follow us on Instagram" plus
    # three URLs counted as server data and threw away the phone's real caption —
    # the precise case the client path exists to rescue. Latent while the app ran
    # on web (CORS blocks those fetches, so no payload ever arrived); it goes live
    # the moment the app runs natively, where RN's fetch has no CORS.
    server_text = (reel.raw_text or "").strip()
    if len(server_text) >= _MIN_SUMMARIZABLE and not extractor.is_link_only(server_text):
        return _to_response(reel)
    if reel.summary_status == "ready" and reel.summary:
        return _to_response(reel)

    text = (body.text or "").strip()
    # Fill the gaps the server couldn't. Never downgrade a field we already have.
    #
    # ⚠️ The INCOMING title is screened too, not just the one we hold. Instagram
    # answers the phone's preview fetch with its login wall often enough that
    # this is the common case, not the edge one: the payload then carries
    # "Login • Instagram" plus the wall's og:image, and installing that on a
    # freshly-saved reel (whose own title is still the "Instagram Reel"
    # placeholder, i.e. weak) is precisely the bug — the card showed a real
    # title for a second and then changed to "Login • Instagram".
    #
    # ⚠️ THE CLIENT'S TITLE GOES THROUGH `clean_title_text` TOO. This is where a
    # Facebook title really comes from: the server's own fetch is blocked from a
    # datacenter IP, the PHONE's fetch is not, so the og:title that reaches the
    # card was read on the device and posted here — never touching the
    # extractor, and never touching the cleaner that lives there. That is why
    # "13M views · 445K reactions | Here's 10 Years Of Therapy…" survived a fix
    # that demonstrably strips exactly that prefix. Cleaning it on the server
    # rather than in the app is deliberate: this is untrusted client input at a
    # trust boundary, and it also means the fix ships without a mobile build.
    if body.title and not _is_login_wall_title(body.title) and _weak_title(reel.title):
        reel.title = extractor.clean_title_text(body.title)[:300]
    if body.thumbnail_url and not reel.thumbnail_url:
        reel.thumbnail_url = body.thumbnail_url.strip()
    if body.uploader and not reel.uploader:
        reel.uploader = body.uploader.strip()

    # A client that fetched the sign-in page instead of the post has no opinion
    # worth storing. The app screens this too (clientExtract.isLoginWall), but
    # this is untrusted input and the server does not rely on the client having
    # done it — an older build, or any other caller, reaches this endpoint too.
    if extractor.is_login_wall(text):
        text = ""

    if len(text) < _MIN_SUMMARIZABLE:
        # The client couldn't read it either (CORS on web, a private post, or —
        # most commonly — YouTube, where the client only has oEmbed and oEmbed
        # carries no description).
        #
        # Do NOT downgrade a reel whose server-side extraction is still running.
        # This payload usually arrives within a second of /save, long before the
        # background chain finishes, and marking it 'skipped' here made the app
        # stop polling (the detail screen only polls while status is 'pending').
        # The summary then landed seconds later and stayed invisible until a
        # manual page reload. Keep the title/thumbnail we gained and let the
        # server finish; it sets the honest final status either way.
        #
        # QUOTA_STATUS is protected here for the same reason: it is a statement
        # about the user's budget, not about this reel's text. Overwriting it
        # with 'skipped' would tell someone who is merely out of AI actions that
        # their reel is unreadable, and hide the "resumes tomorrow" message.
        if reel.summary_status not in ("pending", QUOTA_STATUS):
            reel.summary_status = "skipped"
        db.commit()
        db.refresh(reel)
        return _to_response(reel)

    reel.raw_text = text
    reel.summary_status = "pending"
    db.commit()

    # Charged only now that we actually have something to summarize. Over budget →
    # keep the text (retryable via /summarize after the daily reset), don't 500.
    if not _try_charge(db, user, reel.title or reel.url):
        reel.summary_status = QUOTA_STATUS
        db.commit()
        db.refresh(reel)
        return _to_response(reel)

    # ⚠️ NO `user=` HERE, AND THAT IS NOT AN OVERSIGHT. Passing the user would
    # hand a free-tier reel the cheap index pass — but the user has just been
    # charged an AI action for a summary, on a path they asked for by name. The
    # tier gate exists for AUTOMATIC summaries on save; a paid-for one is
    # always the full thing. Do not "fix" this by threading the user through.
    _summarize_reel(reel.id)        # own session; commits the result
    db.refresh(reel)
    return _to_response(reel)


@router.patch("/{reel_id}/category", response_model=ReelResponse)
def update_category(reel_id: str, body: ReelCategoryRequest,
                    user: AuthUser = Depends(get_current_user), db: Session = Depends(get_db)):
    reel = _get_owned_reel_or_404(reel_id, user, db)
    cat = (body.category or "").strip().lower()
    if cat not in ALLOWED_CATEGORIES:
        raise HTTPException(status_code=422, detail="Invalid category.")
    reel.category = cat
    db.commit()
    db.refresh(reel)
    return _to_response(reel)


@router.patch("/{reel_id}/notes", response_model=ReelResponse)
def update_notes(reel_id: str, body: ReelNotesRequest,
                 user: AuthUser = Depends(get_current_user), db: Session = Depends(get_db)):
    reel = _get_owned_reel_or_404(reel_id, user, db)
    reel.notes = body.notes
    db.commit()
    db.refresh(reel)
    return _to_response(reel)


def _resolve_thumbnail(url: str, platform: str) -> str:
    """Ask the platform for a CURRENT thumbnail URL. No AI, no quota."""
    if platform == "instagram":
        # The embed route is the one that answers a datacenter IP — see
        # docs/EXTRACTION_ROUTES.md. It carries a freshly-signed display_url.
        return (extractor.instagram_embed(url) or {}).get("image") or ""
    if platform == "youtube":
        # Deterministic and unsigned, so it cannot expire; a YouTube reel only
        # reaches here when nothing was stored at save time.
        vid = extractor._youtube_id(url)
        return f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg" if vid else ""
    return (extractor._extract_from_page(url) or {}).get("image") or ""


@router.post("/{reel_id}/thumbnail", response_model=ReelResponse,
             dependencies=[Depends(rate_limit(30, 60, "thumb_refresh"))])
def refresh_thumbnail(reel_id: str, user: AuthUser = Depends(get_current_user),
                      db: Session = Depends(get_db)):
    """Re-resolve one reel's thumbnail and store it.

    ⚠️ WHY THIS HAS TO EXIST — MEASURED, NOT GUESSED (2026-08-15, owner report
    "at times the thumbnail is not loading"). A scan of 153 saved reels found
    TWO separate causes, and only one of them is a save-time failure:

      * **26 rows have no `thumbnail_url` at all** — extraction failed when the
        card was created. Static, and previously permanent.
      * **6 rows hold a signed CDN URL that has ALREADY EXPIRED.** Instagram's
        `scontent.*.cdninstagram.com` links carry an `oe=<hex>` expiry, and the
        sampled ones died ~5 DAYS after the save (saved 2026-07-20, expired
        2026-07-25). This class GROWS with the age of the library: every
        Instagram save eventually stops rendering.

    That second one is the important finding, because no amount of client-side
    retrying can fix it — the stored URL is dead, permanently, and the app was
    quietly degrading to an empty frame. YouTube is unaffected (`i.ytimg.com`
    links are unsigned), which is exactly why the bug looked intermittent: it is
    Instagram-shaped, not random.

    Deliberately NOT charged against the AI quota: this is a fetch, not an AI
    action, and making a broken picture cost the user an allowance unit would be
    charging them for our own stale data. The per-IP burst limit is the guard —
    a grid of 24 tiles failing at once must not become 24 page fetches a second.
    """
    reel = _get_owned_reel_or_404(reel_id, user, db)
    try:
        fresh = _resolve_thumbnail(reel.url, reel.platform or "")
    except Exception as e:                       # never 500 over a picture
        logger.info(f"[THUMB-REFRESH] {reel.id}: {type(e).__name__}: {e}")
        fresh = ""
    if not fresh:
        raise HTTPException(
            status_code=422,
            detail="Couldn't get a new preview image for this save — the post may be private or deleted.",
        )
    if fresh != reel.thumbnail_url:
        reel.thumbnail_url = fresh
        db.commit()
        db.refresh(reel)
    return _to_response(reel)


@router.delete("/{reel_id}")
def delete_reel(reel_id: str, user: AuthUser = Depends(get_current_user), db: Session = Depends(get_db)):
    reel = _get_owned_reel_or_404(reel_id, user, db)
    # Children are removed explicitly — SQLite only honors ON DELETE CASCADE with
    # PRAGMA foreign_keys on, and rows saved before that fix may be orphaned.
    db.query(TaskDB).filter(TaskDB.reel_id == reel.id).delete(synchronize_session=False)
    db.query(WorkoutExerciseDB).filter(WorkoutExerciseDB.reel_id == reel.id).delete(synchronize_session=False)
    # Todos are NOT children — they're the user's own plan and outlive the save.
    # Unlink instead of delete (title/description were copied at add time, so the
    # todo still reads correctly). Explicit for the same reason as above: SQLite
    # only applies ON DELETE SET NULL with PRAGMA foreign_keys on.
    (db.query(TodoDB)
       .filter(TodoDB.reel_id == reel.id)
       .update({TodoDB.reel_id: None}, synchronize_session=False))
    db.delete(reel)
    db.commit()
    return {"message": "Deleted"}


# A page that is a LOGIN WALL, not the post. Instagram and Facebook serve these
# to any fetch they don't like, and their og:title is the wall's own title —
# "Login • Instagram", "Log in to Facebook".
#
# ⚠️ This is the fix for "the reel gets its real title, then a moment later it
# says Login • Instagram" (owner, 2026-08-12). The client-side metadata fetch
# runs from the phone about a second after /save; when Instagram answers it with
# the wall instead of the post, the payload still carries a non-empty title and
# a non-empty og:image, so the old `_weak_title` — which only rejected SHORT or
# placeholder titles — happily accepted "Login • Instagram" as an upgrade over
# the real one. Treating it as weak everywhere means no path can ever install it.
# ⚠️ TIGHTLY ANCHORED, and it has to stay that way. The first version allowed
# any trailing text ("Login" + up to 40 chars), which swallowed the real post
# title "Login flows that don't annoy users" — a caught-in-testing false
# positive, and the expensive kind: it would have thrown away a GOOD title and
# left the placeholder. A wall title is a bare keyword, keyword + separator +
# platform, or "Log in to <platform>". Nothing longer.
_LOGIN_WALL_TITLE = re.compile(
    r'''^(
        (log\s?in|sign\s?in|login\srequired|page\snot\sfound|content\snot\savailable)
        (\s*[•|·\-—:]\s*\w+)?              # "Login • Instagram"
      | (log|sign)\s?in\sto\s\w+           # "Log in to Facebook"
    )$''',
    re.IGNORECASE | re.VERBOSE,
)


def _is_login_wall_title(t: str | None) -> bool:
    """True when a title is a platform login/error page rather than the post."""
    if not t:
        return False
    s = t.strip()
    # "Login • Instagram", "Log in to Facebook", "Login", "Page Not Found".
    if _LOGIN_WALL_TITLE.match(s):
        return True
    # A title that is nothing but the platform's own name is the wall's default.
    return s.lower().strip(" .•|-") in {
        "instagram", "facebook", "linkedin", "tiktok", "youtube", "threads",
    }


def _weak_title(t: str | None) -> bool:
    """A title we'd rather replace with an AI-generated one (e.g. LinkedIn's
    'Day352:-' first-line headline, hashtag soup, or too short).

    Also true for platform LOGIN-WALL titles — see _is_login_wall_title. Those
    are never an upgrade over anything, including over nothing.
    """
    if not t or len(t.strip()) < 6:
        return True
    s = t.strip()
    if _is_login_wall_title(s):
        return True
    if re.match(r'^day\s*\d+', s, re.IGNORECASE):
        return True
    # generic platform placeholders like "Facebook Reel", "Instagram Post"
    if re.match(r'^(youtube|instagram|tiktok|threads|linkedin|facebook|unknown|web)\s+(reel|post|video|short|link)s?$', s, re.IGNORECASE):
        return True
    # Instagram/TikTok generic auto-titles like "Video by someone", "Reel by someone"
    if re.match(r'^(video|reel|post|photo|clip)\s+by\b', s, re.IGNORECASE):
        return True
    if len(re.sub(r'[#@\W\d]+', '', s)) < 6:   # mostly hashtags/symbols
        return True
    return False


def _prune_cache_if_due(db: Session) -> None:
    """Best-effort: delete extraction-cache rows past the TTL. Throttled so it
    runs at most once per _PRUNE_INTERVAL, and never breaks a save if it fails."""
    global _last_prune
    now = time.monotonic()
    if now - _last_prune < _PRUNE_INTERVAL:
        return
    _last_prune = now
    try:
        cutoff = datetime.utcnow() - timedelta(days=CACHE_TTL_DAYS)
        deleted = (
            db.query(ExtractionCacheDB)
            .filter(ExtractionCacheDB.created_at < cutoff)
            .delete(synchronize_session=False)
        )
        db.commit()
        if deleted:
            logger.info(f"[CACHE] pruned {deleted} expired extraction(s)")
    except Exception as e:
        db.rollback()
        logger.warning(f"[CACHE] prune failed: {e}")


# Minimum text for an extraction to be worth caching. Same bar the summarizer
# uses — below it there is nothing to summarize, so the result is a failure to be
# retried, not a success to be remembered.
MIN_CACHEABLE_TEXT = 50


def _is_cacheable(info: dict) -> bool:
    """Is this extraction worth remembering? Text-less results must not be cached:
    they're what a bot-blocked IP returns, and caching them makes the failure
    permanent for the whole TTL. `needs_audio` is kept because that path is a real
    (if unfinished) extraction the audio fallback can still complete."""
    return len((info.get("best_text") or "").strip()) >= MIN_CACHEABLE_TEXT or bool(info.get("needs_audio"))


def _get_cached_extraction(db: Session, url: str) -> dict | None:
    """Return a fresh cached extraction as an info dict, or None. Fails open."""
    try:
        row = db.query(ExtractionCacheDB).filter(ExtractionCacheDB.url == url).first()
        if not row:
            return None
        if row.created_at and (datetime.utcnow() - row.created_at) > timedelta(days=CACHE_TTL_DAYS):
            return None  # stale — let it re-extract
        # A cached row with no usable text is a MISS, not a hit. Extractions that
        # returned only a title/thumbnail (what a bot-blocked datacenter IP gives
        # back) were previously cached as successes, and every later save of that
        # URL reused the empty result for the full 14-day TTL — so retrying could
        # never recover, no matter how many times the user tried. Treating it as a
        # miss re-extracts and heals rows already poisoned.
        if len((row.best_text or "").strip()) < MIN_CACHEABLE_TEXT and not row.needs_audio:
            logger.info(f"[CACHE] ignoring text-less cache row for {url} — re-extracting")
            return None
        return {
            "title": row.title or "",
            "caption": row.caption or "",
            "transcript": row.transcript or "",
            "best_text": row.best_text or "",
            "thumbnail_url": row.thumbnail_url or "",
            "duration": row.duration or 0,
            "platform": row.platform,
            "uploader": row.uploader or "",
            "needs_audio": bool(row.needs_audio),
            "extracted": True,
        }
    except Exception as e:
        logger.warning(f"[CACHE] read failed for {url}: {e}")
        return None


def _store_extraction(db: Session, url: str, info: dict) -> None:
    """Upsert a successful extraction into the cache. Fails open."""
    try:
        row = db.query(ExtractionCacheDB).filter(ExtractionCacheDB.url == url).first()
        if row is None:
            row = ExtractionCacheDB(url=url)
            db.add(row)
        row.platform = info.get("platform") or "unknown"
        row.title = info.get("title")
        row.caption = info.get("caption")
        row.transcript = info.get("transcript")
        row.best_text = info.get("best_text")
        row.thumbnail_url = info.get("thumbnail_url")
        row.uploader = info.get("uploader")
        row.duration = info.get("duration") or 0
        row.needs_audio = bool(info.get("needs_audio"))
        row.created_at = datetime.utcnow()
        db.commit()
    except Exception as e:
        db.rollback()
        logger.warning(f"[CACHE] write failed for {url}: {e}")


def _to_response(reel: ReelDB) -> ReelResponse:
    return ReelResponse(
        id=reel.id,
        url=reel.url,
        platform=reel.platform,
        title=reel.title,
        thumbnail_url=reel.thumbnail_url,
        uploader=reel.uploader,
        duration=int(reel.duration) if reel.duration is not None else None,
        summary=reel.summary or [],
        tags=reel.tags or [],
        category=reel.category,
        summary_status=getattr(reel, "summary_status", None) or "ready",
        notes=reel.notes,
        summarize_count=reel.summarize_count or 0,
        tasks_count=reel.tasks_count or 0,
        workout_count=reel.workout_count or 0,
        is_sensitive=bool(getattr(reel, "is_sensitive", False)),
        created_at=reel.created_at,
    )


def _summarize_reel(reel_id: str, meta: dict | None = None,
                    user: AuthUser | None = None) -> None:
    """Background worker: turn a saved reel's raw_text (or audio) into a summary,
    tags and category. Runs off the request path so saving feels instant. Opens
    its own DB session (the request's session is already closed). Fail-safe: any
    error leaves the reel in 'failed' so the UI can offer a retry.

    `meta` carries structural signals about the parts of the video we cannot see
    (pacing, platform image description, audio track). Optional: callers that did
    not just run an extraction pass nothing and the prompt simply omits them.

    `user` decides FULL SUMMARY vs INDEX-ONLY (see the note at the call site).
    It is a parameter rather than a lookup from `reel.user_id` because the tier
    lives in the JWT's app_metadata claim, not in our database — there is no way
    to recover it from a row. `None` means "no request context" (the startup
    recovery sweep) and takes the full path deliberately."""
    db = SessionLocal()
    try:
        reel = db.query(ReelDB).filter(ReelDB.id == reel_id).first()
        if not reel:
            return

        text = (reel.raw_text or "").strip()

        # Audio transcription fallback — the slow path, off the request.
        #
        # Gated on the API key: without it transcribe() returns "" immediately,
        # so downloading first was pure waste — bandwidth, ffmpeg CPU, and (until
        # download_audio/cleanup_audio took ownership) a permanently orphaned
        # temp directory per reel, because the cleanup used to live in a `finally`
        # that the early return skipped.
        if len(text) < 50 and settings.OPENAI_API_KEY:
            audio_path = None
            try:
                audio_path = extractor.download_audio(reel.url)
                if audio_path:
                    transcribed = (transcriber.transcribe(audio_path) or "").strip()
                    if transcribed:
                        text = transcribed
                        reel.raw_text = text
            except Exception as e:
                logger.warning(f"[SUMMARIZE] audio fallback failed for {reel_id}: {e}")
            finally:
                if audio_path:
                    extractor.cleanup_audio(audio_path)

        if len(text) < 50:
            reel.summary, reel.tags = [], []
            reel.summary_status = "skipped"
            db.commit()
            logger.info(f"[SUMMARIZE] {reel_id} skipped — no extractable text")
            return

        # ── Full summary, or just the index? ──────────────────────────────
        #
        # ⚠️ THE TIER DECIDES, AND IT IS THE SAME TIER THAT GATES ASK. Free
        # saves get `index_only`: tags, category, a title and the sensitive
        # flag — everything the LIBRARY needs (search, the category rail, the
        # action-button gating) for a fraction of the tokens, because it reads
        # 2000 chars instead of 8000.
        #
        # The objection this has to answer is "then Ask has nothing to read".
        # It does not arise: `auto_summary` is False on exactly the tier where
        # `can_ask` is False (entitlements.py keeps them together and says
        # why), so no one who can open Ask ever has an unsummarized reel. The
        # free user is not left stuck either — the reel screen offers a
        # one-tap full summary for one of their three daily AI actions, which
        # is the existing /resummarize path, unchanged.
        #
        # `user` is None for the startup recovery sweep, which re-runs orphaned
        # pending rows with no request context. Defaulting to the FULL path
        # there is deliberate: recovery is rare, and under-delivering on a
        # paid user's reel is the worse of the two mistakes.
        full = True
        if user is not None:
            try:
                full = entitlements_for(user, db).auto_summary
            except Exception as e:
                # Never let a tier lookup decide whether a save gets processed.
                logger.warning(f"[SUMMARIZE] {reel_id} tier lookup failed, using full: {e}")

        run = summarizer.summarize if full else summarizer.index_only
        ai = run(platform=reel.platform, title=reel.title or "", text=text, meta=meta)
        reel.summary = ai["summary"]
        reel.tags = ai["tags"]
        # Same latch as resummarize: model may set the flag, never clear it.
        reel.is_sensitive = bool(reel.is_sensitive) or bool(ai.get("sensitive", False))
        if ai.get("category"):
            reel.category = ai["category"]
        # Replace a weak extracted title with the AI one (LinkedIn "Day352:-" etc.).
        if _weak_title(reel.title) and ai.get("title"):
            reel.title = ai["title"]
        # ⚠️ "indexed" IS NOT "skipped". Both leave `summary` empty, and the app
        # tells the user two completely different things about them: skipped
        # means we read the reel and there was nothing in it, indexed means we
        # deliberately did not write one yet and one tap will. Reporting the
        # second as the first would be a confidently wrong message — the exact
        # failure the readFailure work fixed on the client a day earlier.
        reel.summary_status = (
            ("ready" if ai["summary"] else "skipped") if full else "indexed"
        )
        db.commit()
        logger.info(f"[SUMMARIZE] {reel_id} done — status={reel.summary_status}")
    except Exception as e:
        logger.error(f"[SUMMARIZE] failed for {reel_id}: {type(e).__name__}: {e}")
        try:
            db.rollback()
            reel = db.query(ReelDB).filter(ReelDB.id == reel_id).first()
            if reel:
                reel.summary_status = "failed"
                db.commit()
        except Exception:
            pass
    finally:
        db.close()


def recover_pending_summaries() -> None:
    """Re-enqueue summaries left in 'pending' by a previous process that died
    mid-task. FastAPI BackgroundTasks run in-process, so a restart/crash/cold-start
    (common on free hosting) orphans any in-flight summary — without this it would
    be stuck 'Summarizing…' forever. Called once on startup. Bounded so a backlog
    can't trigger a cost spike; anything beyond the cap is left for manual retry.

    ONE free recovery per reel, enforced by the `recovered_at` stamp. This path
    charges nothing (`user=None`) on purpose — the interrupted summary was our
    crash, not the user's action, so billing them for it would be wrong. But
    unstamped it was the only AI path in the app that spends Claude tokens
    without decrementing anyone's allowance or showing up in the usage meter,
    and Render's free tier cold-starts constantly. A row that could never
    complete was re-summarized free and invisibly on EVERY boot, forever.

    A reel still 'pending' after its free recovery is flipped to 'failed' rather
    than left spinning: nothing is pending any more, and 'failed' is what makes
    the detail screen offer the manual retry — which does charge, correctly,
    because the user chose it."""
    db = SessionLocal()
    try:
        # Self-heal rows whose status contradicts their content. A reel that HAS
        # summary text is 'ready' by definition — any other status hides it in the
        # app even though the AI already ran (and was already paid for). These
        # arose when a re-extraction overwrote the status of an already-summarized
        # save; the guard in _extract_and_summarize stops new ones appearing.
        healed = (
            db.query(ReelDB)
            .filter(ReelDB.summary_status != "ready", ReelDB.summary.isnot(None))
            .all()
        )
        fixed = 0
        for r in healed:
            if r.summary:                       # non-empty JSON list
                r.summary_status = "ready"
                fixed += 1
        if fixed:
            db.commit()
            logger.info(f"[RECOVER] healed {fixed} reel(s) that had a summary but a non-ready status")

        # Already had its one free pass and is STILL pending — a second free run
        # would fail the same way. Surface it instead: 'failed' is the status the
        # detail screen turns into a retry button, and that retry charges,
        # correctly, because the user chose it.
        exhausted = (
            db.query(ReelDB)
            .filter(ReelDB.summary_status == "pending", ReelDB.recovered_at.isnot(None))
            .all()
        )
        for r in exhausted:
            r.summary_status = "failed"
        if exhausted:
            db.commit()
            logger.info(
                f"[RECOVER] {len(exhausted)} reel(s) still pending after their free "
                "recovery — marked failed so the app offers a manual retry"
            )

        rows = (
            db.query(ReelDB.id, ReelDB.raw_text, ReelDB.title)
            .filter(ReelDB.summary_status == "pending", ReelDB.recovered_at.is_(None))
            .order_by(ReelDB.created_at.desc())
            .limit(PENDING_RECOVERY_LIMIT)
            .all()
        )
        pending = [(r[0], bool((r[1] or "").strip() or r[2])) for r in rows]

        # Stamp BEFORE enqueuing, and commit. If the process dies mid-recovery
        # the work is lost but the stamp survives — which is the safe direction:
        # a missed retry costs the user one manual tap, an unstamped row costs
        # unbounded Claude tokens on every future boot.
        if pending:
            now = datetime.utcnow()
            (db.query(ReelDB)
               .filter(ReelDB.id.in_([rid for rid, _ in pending]))
               .update({ReelDB.recovered_at: now}, synchronize_session=False))
            db.commit()
    except Exception as e:
        logger.warning(f"[RECOVER] could not query pending summaries: {e}")
        return
    finally:
        db.close()

    for rid, extracted in pending:
        if extracted:
            _executor.submit(_summarize_reel, rid)
        else:
            # Died before extraction finished — redo the whole chain. user=None:
            # the recovery path doesn't charge quota (our crash, not their
            # action), which is exactly why `recovered_at` bounds it to once.
            _executor.submit(_extract_and_summarize, rid, None)
    if pending:
        logger.info(f"[RECOVER] re-enqueued {len(pending)} orphaned pending task(s)")
