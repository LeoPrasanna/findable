import json

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from pydantic import BaseModel

from app.database import get_db, ReelDB
from app import library_lock
from app.routes.models.reel import ReelResponse
from app.services import librarian
from app.routes.reels import _to_response
from app.ratelimit import rate_limit
from app.quota import charge_ai_action
from app.auth import get_current_user, AuthUser
from app.entitlements import entitlements_for, PRO_FEATURE_DETAIL


def _require_ask(user: AuthUser, db: Session) -> None:
    """Ask-my-Library is Pro-only after the trial (decided 2026-07-20). Enforced
    here — the app's locked button is cosmetic. Fires BEFORE the quota charge so
    a refused call never costs an AI action."""
    if not entitlements_for(user, db).can_ask:
        raise HTTPException(
            status_code=403,
            detail=PRO_FEATURE_DETAIL.format(feature="Ask My Library"),
        )

# Sentinel that separates the streamed answer prose from the trailing sources
# JSON. Chosen so it can never appear inside natural answer text.
SOURCES_MARKER = "\n␞__SRC__␞"

router = APIRouter(prefix="/api", tags=["ask"])

# "Ask your library" is the only AI feature without a natural per-item cap. A per-IP
# burst guard (anti-loop) stays below; the daily budget is now the per-USER quota
# (enforce_daily_ai_quota), which all AI actions share — see app/quota.py.


class AskRequest(BaseModel):
    question: str


class AskResponse(BaseModel):
    answer: str
    sources: list[ReelResponse]


@router.post(
    "/ask",
    response_model=AskResponse,
    dependencies=[Depends(rate_limit(15, 60, "ask"))],   # burst guard (anti-loop)
)
def ask(body: AskRequest, user: AuthUser = Depends(get_current_user), db: Session = Depends(get_db)):
    q = (body.question or "").strip()
    if len(q) < 3:
        raise HTTPException(status_code=422, detail="Ask a real question — a few words at least.")

    _require_ask(user, db)

    # Per-user daily AI budget (shared across all AI actions). Charged before the call.
    charge_ai_action(db, user, action="ask", label=q)

    # ⚠️ LOCKED SAVES ARE NOT PART OF THE CORPUS. A library over its cap keeps its
    # oldest saves read-only (app/library_lock.py); answering out of them would hand
    # back, in prose, exactly the content the lock is withholding — and it would do it
    # while charging an AI action. Excluded in the QUERY rather than filtered after,
    # so the row never reaches the payload.
    cutoff = library_lock.cutoff_for(user, db)
    corpus = db.query(ReelDB).filter(ReelDB.user_id == user.id)
    if cutoff is not None:
        corpus = corpus.filter(ReelDB.created_at >= cutoff)
    reels = corpus.order_by(ReelDB.created_at.desc()).all()
    payload = [
        {"id": r.id, "title": r.title, "summary": r.summary or [], "tags": r.tags or [], "notes": r.notes}
        for r in reels
    ]

    result = librarian.ask_library(q, payload)

    id_set = set(result.get("source_ids") or [])
    sources = [_to_response(r) for r in reels if r.id in id_set]
    return AskResponse(answer=result.get("answer", ""), sources=sources)


@router.post(
    "/ask/stream",
    dependencies=[Depends(rate_limit(15, 60, "ask"))],   # burst guard (anti-loop)
)
def ask_stream(body: AskRequest, user: AuthUser = Depends(get_current_user), db: Session = Depends(get_db)):
    """Streaming twin of /ask: the answer text streams token-by-token (first words
    in ~1.4 s instead of a ~3 s wall of silence), then a trailing sentinel line
    carries the sources JSON. All DB work + the quota charge happen up front so a
    429/422 is a clean error, never mid-stream; the generator only calls Claude."""
    q = (body.question or "").strip()
    if len(q) < 3:
        raise HTTPException(status_code=422, detail="Ask a real question — a few words at least.")

    _require_ask(user, db)

    # Charged before streaming starts — a quota 429 is returned as JSON, not
    # halfway through a half-written answer.
    charge_ai_action(db, user, action="ask", label=q)

    # ⚠️ LOCKED SAVES ARE NOT PART OF THE CORPUS. A library over its cap keeps its
    # oldest saves read-only (app/library_lock.py); answering out of them would hand
    # back, in prose, exactly the content the lock is withholding — and it would do it
    # while charging an AI action. Excluded in the QUERY rather than filtered after,
    # so the row never reaches the payload.
    cutoff = library_lock.cutoff_for(user, db)
    corpus = db.query(ReelDB).filter(ReelDB.user_id == user.id)
    if cutoff is not None:
        corpus = corpus.filter(ReelDB.created_at >= cutoff)
    reels = corpus.order_by(ReelDB.created_at.desc()).all()
    payload = [
        {"id": r.id, "title": r.title, "summary": r.summary or [], "tags": r.tags or [], "notes": r.notes}
        for r in reels
    ]
    reels_by_id = {r.id: r for r in reels}

    def generate():
        chunks: list[str] = []
        for text in librarian.stream_answer(q, payload):
            chunks.append(text)
            yield text
        answer = "".join(chunks)
        source_ids = librarian.sources_from_answer(answer, payload)
        sources = [_to_response(reels_by_id[i]).model_dump(mode="json") for i in source_ids if i in reels_by_id]
        yield SOURCES_MARKER + json.dumps(sources)

    # text/plain (not text/event-stream): the mobile client reads it with an
    # incremental XHR that surfaces responseText the same way on native and web.
    return StreamingResponse(generate(), media_type="text/plain; charset=utf-8")
