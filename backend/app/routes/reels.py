from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from sqlalchemy.orm import Session
import uuid
import re
import time
import logging
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeout

from app.database import get_db, SessionLocal, ReelDB, ExtractionCacheDB, TaskDB, WorkoutExerciseDB
from app.routes.models.reel import ReelSaveRequest, ReelNotesRequest, ReelCategoryRequest, ReelResponse, ReelListResponse
from app.services import extractor, transcriber, summarizer
from app.services import search as smart_search
from app.ratelimit import rate_limit
from app.quota import charge_ai_action
from app.entitlements import entitlements_for
from app.auth import get_current_user, AuthUser

logger = logging.getLogger(__name__)

# The single set of categories a reel can belong to (auto-assigned or user-picked).
# Keep in sync with the summarizer prompt and mobile CATEGORY_OPTIONS (theme.ts).
ALLOWED_CATEGORIES = {
    "fitness", "cooking", "tech", "motivation", "education", "entertainment",
    "fashion", "beauty", "travel", "business", "news", "health", "finance", "other",
}

# Bigger pool so a few slow extractions can't starve every other save. A hung
# yt-dlp thread can't be killed, so the real protection is keeping extraction
# fast/bounded (see extractor.py); this just widens the safety margin.
_executor = ThreadPoolExecutor(max_workers=8)
EXTRACT_TIMEOUT = 20      # hard ceiling for a single extraction (seconds) — keep the
                          # save snappy; a slower platform degrades to a link-only save.
CACHE_TTL_DAYS = 14       # re-extract if the cached entry is older than this

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
def save_reel(body: ReelSaveRequest, background_tasks: BackgroundTasks,
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
                detail=(
                    f"Your free library is full ({ent.save_limit} saves). "
                    "Delete a save to make room — or a Pro subscription unlocks more."
                ),
            )

    # The only sync validation: is this a link we recognize at all?
    platform = extractor.detect_platform(canonical_url)
    if platform in (None, "", "unknown"):
        raise HTTPException(
            status_code=422,
            detail="Couldn't recognize this link. Try a public YouTube Short, Instagram Reel, TikTok, LinkedIn or Facebook post.",
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
            reel.summary_status = "failed"   # over budget — retryable after reset
            should_summarize = False
        db.add(reel)
        db.commit()
        db.refresh(reel)
        if should_summarize:
            background_tasks.add_task(_summarize_reel, reel.id)
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
    background_tasks.add_task(_extract_and_summarize, reel.id, user)
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
    should_summarize = len(raw_text) >= 50 or bool(info.get("needs_audio"))
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


def _try_charge(db: Session, user: AuthUser, label: str | None = None) -> bool:
    """Charge one AI action; False when today's budget is spent (never raises)."""
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

        try:
            future = _executor.submit(extractor.extract_info, reel.url)
            info = future.result(timeout=EXTRACT_TIMEOUT)
        except Exception as e:
            logger.error(f"[EXTRACT-BG] failed for {reel_id} ({reel.url}): {type(e).__name__}: {e}")
            # Keep the bookmark: clean label, honest 'failed' so the UI offers retry.
            kind = "Reel" if "/reel" in reel.url.lower() else "Post"
            reel.title = reel.title or f"{(reel.platform or 'web').capitalize()} {kind}"
            reel.summary_status = "failed"
            db.commit()
            return

        # Only cache an extraction that actually carries content. `extracted` is
        # True as soon as a title or thumbnail comes back, so caching on that alone
        # stored text-less results — permanently poisoning the URL for the cache's
        # 14-day TTL. An extraction with nothing to summarize is precisely the one
        # worth retrying later, so it must not be cached.
        if info.get("extracted") and _is_cacheable(info):
            _store_extraction(db, reel.url, info)

        filled = _reel_from_info(reel.user_id, reel.url, info)
        reel.platform = filled.platform if filled.platform != "unknown" else reel.platform
        reel.title = filled.title
        reel.thumbnail_url = filled.thumbnail_url
        reel.uploader = filled.uploader
        reel.duration = filled.duration
        reel.raw_text = filled.raw_text
        reel.summary_status = filled.summary_status
        _apply_duration_guard(reel)
        db.commit()

        if reel.summary_status != "pending":
            logger.info(f"[EXTRACT-BG] {reel_id} filled — no summary needed")
            return

        if user is not None and not _try_charge(db, user, reel.title or reel.url):
            reel.summary_status = "failed"
            db.commit()
            return
    finally:
        db.close()

    # Own session inside; commits the summary result.
    _summarize_reel(reel_id)


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


@router.get("/search", response_model=ReelListResponse)
def search_reels(q: str = "", limit: int = 24, offset: int = 0,
                 user: AuthUser = Depends(get_current_user), db: Session = Depends(get_db)):
    """Smart full-library search: tokenized query, category + synonym matching,
    relevance-ranked (see services/search.py). Scored in Python over the user's
    own reels — fine at personal-library scale; embeddings are the scale step."""
    q = q.strip()
    if not q:
        return ReelListResponse(total=0, items=[])
    limit = max(1, min(limit, 100))
    offset = max(0, offset)
    rows = (
        db.query(ReelDB)
        .filter(ReelDB.user_id == user.id)
        .order_by(ReelDB.created_at.desc())
        .all()
    )
    ranked = smart_search.rank(q, rows)
    total = len(ranked)
    page = ranked[offset:offset + limit]
    return ReelListResponse(total=total, items=[_to_response(r) for r in page])


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

    ai = summarizer.summarize(
        platform=reel.platform,
        title=reel.title or "",
        text=source_text,
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
    if _weak_title(reel.title) and ai.get("title"):
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

    _summarize_reel(reel.id)        # own session; commits the result
    db.refresh(reel)                # pull the freshly-committed row into this session
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


@router.delete("/{reel_id}")
def delete_reel(reel_id: str, user: AuthUser = Depends(get_current_user), db: Session = Depends(get_db)):
    reel = _get_owned_reel_or_404(reel_id, user, db)
    # Children are removed explicitly — SQLite only honors ON DELETE CASCADE with
    # PRAGMA foreign_keys on, and rows saved before that fix may be orphaned.
    db.query(TaskDB).filter(TaskDB.reel_id == reel.id).delete(synchronize_session=False)
    db.query(WorkoutExerciseDB).filter(WorkoutExerciseDB.reel_id == reel.id).delete(synchronize_session=False)
    db.delete(reel)
    db.commit()
    return {"message": "Deleted"}


def _weak_title(t: str | None) -> bool:
    """A title we'd rather replace with an AI-generated one (e.g. LinkedIn's
    'Day352:-' first-line headline, hashtag soup, or too short)."""
    if not t or len(t.strip()) < 6:
        return True
    s = t.strip()
    if re.match(r'^day\s*\d+', s, re.IGNORECASE):
        return True
    # generic platform placeholders like "Facebook Reel", "Instagram Post"
    if re.match(r'^(youtube|instagram|tiktok|linkedin|facebook|unknown|web)\s+(reel|post|video|short|link)s?$', s, re.IGNORECASE):
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


def _summarize_reel(reel_id: str) -> None:
    """Background worker: turn a saved reel's raw_text (or audio) into a summary,
    tags and category. Runs off the request path so saving feels instant. Opens
    its own DB session (the request's session is already closed). Fail-safe: any
    error leaves the reel in 'failed' so the UI can offer a retry."""
    db = SessionLocal()
    try:
        reel = db.query(ReelDB).filter(ReelDB.id == reel_id).first()
        if not reel:
            return

        text = (reel.raw_text or "").strip()

        # Audio transcription fallback — the slow path, now off the request.
        if len(text) < 50:
            try:
                audio_path = extractor.download_audio(reel.url)
                if audio_path:
                    transcribed = (transcriber.transcribe(audio_path) or "").strip()
                    if transcribed:
                        text = transcribed
                        reel.raw_text = text
            except Exception as e:
                logger.warning(f"[SUMMARIZE] audio fallback failed for {reel_id}: {e}")

        if len(text) < 50:
            reel.summary, reel.tags = [], []
            reel.summary_status = "skipped"
            db.commit()
            logger.info(f"[SUMMARIZE] {reel_id} skipped — no extractable text")
            return

        ai = summarizer.summarize(platform=reel.platform, title=reel.title or "", text=text)
        reel.summary = ai["summary"]
        reel.tags = ai["tags"]
        # Same latch as resummarize: model may set the flag, never clear it.
        reel.is_sensitive = bool(reel.is_sensitive) or bool(ai.get("sensitive", False))
        if ai.get("category"):
            reel.category = ai["category"]
        # Replace a weak extracted title with the AI one (LinkedIn "Day352:-" etc.).
        if _weak_title(reel.title) and ai.get("title"):
            reel.title = ai["title"]
        reel.summary_status = "ready" if ai["summary"] else "skipped"
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
    can't trigger a cost spike; anything beyond the cap is left for manual retry."""
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

        rows = (
            db.query(ReelDB.id, ReelDB.raw_text, ReelDB.title)
            .filter(ReelDB.summary_status == "pending")
            .order_by(ReelDB.created_at.desc())
            .limit(PENDING_RECOVERY_LIMIT)
            .all()
        )
        pending = [(r[0], bool((r[1] or "").strip() or r[2])) for r in rows]
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
            # the recovery path doesn't charge quota (bounded by the cap above).
            _executor.submit(_extract_and_summarize, rid, None)
    if pending:
        logger.info(f"[RECOVER] re-enqueued {len(pending)} orphaned pending task(s)")
