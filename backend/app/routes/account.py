from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from sqlalchemy import select
import httpx
import logging
from datetime import datetime, timedelta

from app.config import settings
from app.database import get_db, ReelDB, TaskDB, WorkoutExerciseDB, ProfileDB, AiActionLogDB, TodoDB
from app.auth import get_current_user, AuthUser
from app.quota import usage_today, quota_subject, _utc_today
from app.entitlements import entitlements_for
from app.sharekey import mint_share_key, revoke_share_key

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/account", tags=["account"])


def _delete_auth_user(user_id: str) -> bool:
    """Delete the Supabase Auth user via the Admin API (service-role key).

    Required for true account deletion (Apple guideline 5.1.1(v)) — without it
    the user could sign right back in after 'deleting' their account. Returns
    False (never raises) when unconfigured or the call fails; the caller
    reports that honestly instead of pretending."""
    if not (settings.SUPABASE_URL and settings.SUPABASE_SERVICE_ROLE_KEY):
        logger.warning("[ACCOUNT] auth deletion skipped — Supabase admin credentials not configured")
        return False
    try:
        r = httpx.delete(
            f"{settings.SUPABASE_URL.rstrip('/')}/auth/v1/admin/users/{user_id}",
            headers={
                "apikey": settings.SUPABASE_SERVICE_ROLE_KEY,
                "Authorization": f"Bearer {settings.SUPABASE_SERVICE_ROLE_KEY}",
            },
            timeout=10,
        )
        if r.status_code in (200, 204):
            return True
        # 404 = already gone (e.g. retry after a partial failure) — that's done.
        if r.status_code == 404:
            return True
        logger.error(f"[ACCOUNT] auth deletion failed for {user_id}: HTTP {r.status_code}")
        return False
    except Exception as e:
        logger.error(f"[ACCOUNT] auth deletion errored for {user_id}: {type(e).__name__}: {e}")
        return False


# A profile created more than this after its own trial clock started did not
# start that clock — it inherited it from a `trial_grants` row, i.e. this email
# had an account here before. Slack rather than `!=` because the two writes are
# separate statements and clock/rounding noise of a second or two is normal;
# a real return gap is days or weeks, so nothing sits near this boundary.
_RETURNING_GAP = timedelta(minutes=5)


def _is_returning(user: AuthUser, db: Session) -> bool:
    """Has this email had an account here before? See the note at the `returning`
    key in `get_usage` for why this is derived instead of stored."""
    profile = db.query(ProfileDB).filter(ProfileDB.user_id == user.id).first()
    if profile is None or profile.created_at is None or profile.trial_started_at is None:
        return False
    return (profile.created_at - profile.trial_started_at) > _RETURNING_GAP


@router.get("/usage")
def get_usage(user: AuthUser = Depends(get_current_user), db: Session = Depends(get_db)):
    """The caller's effective tier and today's usage — read-only, never charges.
    Lets the app show honest meters (AI budget, trial countdown, save cap)
    instead of surprising users with a 429/403."""
    ent = entitlements_for(user, db)
    used = usage_today(db, quota_subject(user))
    saves_used = db.query(ReelDB).filter(ReelDB.user_id == user.id).count()
    # Distinct counts across the user's WHOLE library — the client's stat cards used
    # to compute these from the loaded page (a ~12-reel sample), so they undercounted.
    categories = (
        db.query(ReelDB.category)
        .filter(ReelDB.user_id == user.id, ReelDB.category.isnot(None), ReelDB.category != "")
        .distinct().count()
    )
    platforms = (
        db.query(ReelDB.platform)
        .filter(ReelDB.user_id == user.id, ReelDB.platform.isnot(None), ReelDB.platform != "")
        .distinct().count()
    )
    tomorrow = datetime.utcnow().date() + timedelta(days=1)
    return {
        # Effective tier: 'pro' | 'trial' | 'free' (trial expired).
        "tier": ent.tier,
        # ── Has this person been here before? ──────────────────────────────
        # True when the profile INHERITED an older trial clock than its own
        # creation time, which happens in exactly one situation: `_ensure_profile`
        # found a `trial_grants` row for the hash of their email and seeded
        # `trial_started_at` from it. That row survives account deletion by
        # design (it is the trial-reset containment), so it is a reliable
        # "this email had an account before" signal.
        #
        # ⚠️ DERIVED, NOT STORED — deliberately no new column and no migration.
        # For a genuinely new profile both timestamps are the same `now`, so the
        # comparison is false; for a returning one the grant predates the new
        # profile by however long they were away.
        #
        # ⚠️ It stays true forever, so it is a fact about the ACCOUNT, not a
        # one-shot flag. The client is responsible for showing its welcome-back
        # once (see components/WelcomeBack.tsx) — a server-side "seen" bit would
        # be a second source of truth for something local storage already knows.
        "returning": _is_returning(user, db),
        "trial_ends_at": ent.trial_ends_at.isoformat() + "Z" if ent.trial_ends_at else None,
        "saves": {"used": saves_used, "limit": ent.save_limit},   # limit null = unlimited
        # What this account drops to when the trial ends.
        #
        # ⚠️ SENT BECAUSE THE CLIENT KEPT GETTING IT WRONG. ProfilePanel told every
        # trial user they would drop to "20 saves" — the free cap until 2026-09-11,
        # when it became 50. A hardcoded number in the client disagrees with the
        # server the first time the server changes, and this one was a wrong PROMISE
        # shown to every new user for weeks. Both numbers are env-overridable
        # (render.yaml), so there is no version of this the client can safely guess.
        "after_trial": {
            "save_limit": settings.FREE_SAVE_LIMIT,
            "ai_limit": settings.AI_FREE_DAILY_LIMIT,
        },
        # What Pro holds, for the upsell copy.
        #
        # ⚠️ SENT SO THE CLIENT STOPS HARDCODING IT. `services/promoSlot.ts` carried
        # PRO_SAVES = 500 with a comment admitting nothing enforced that it matched
        # render.yaml — and a promo promising 500 saves while the server grants 300 is
        # not a stale string, it is a false advertisement inside the product. Same
        # reasoning as `after_trial`, which existed because the client guessed "20".
        "pro": {
            "save_limit": settings.PRO_SAVE_LIMIT,
            "ai_limit": settings.AI_PRO_DAILY_LIMIT,
        },
        # Whole-library distinct counts for the profile stat cards (authoritative,
        # unfiltered — not derived from whatever page the client happens to hold).
        "categories": categories,
        "platforms": platforms,
        # Feature flags for the app's locked-button UI (server enforces with 403s
        # regardless — these only decide what to RENDER). tasks refers to
        # non-cooking "Turn into Action"; recipes and workouts are never gated.
        "features": {
            "ask": ent.can_ask,
            "tasks": ent.can_tasks,
            "recipe": ent.can_recipe,
            "workout": ent.can_workout,
            "itinerary": ent.can_itinerary,
        },
        # Legacy top-level AI fields (older clients read these directly).
        "used": used,
        "limit": ent.ai_daily_limit,
        "remaining": max(0, ent.ai_daily_limit - used),
        "resets_at": f"{tomorrow.isoformat()}T00:00:00Z",  # quota days are UTC
    }


# Human-readable labels for the action codes written by charge_ai_action.
_ACTION_LABELS = {
    "summary": "Summarised",
    "resummarize": "Re-summarised",
    "tasks": "Action steps",
    "recipe": "Recipe",
    "workout": "Workout",
    "itinerary": "Trip itinerary",
    "ask": "Asked your library",
    "ai": "AI action",
}


@router.get("/usage/log")
def get_usage_log(user: AuthUser = Depends(get_current_user), db: Session = Depends(get_db)):
    """What today's AI actions were actually spent on — the drill-down behind
    the "N of M left" meter. Read-only; never charges.

    Short-lived by design (see AI_LOG_RETENTION_DAYS): this is a UI convenience,
    not an audit trail. Actions charged before the log existed simply won't
    appear, so `logged` can be < the meter's `used` — the client should say
    "recent" rather than claim completeness."""
    day = _utc_today()
    rows = (
        db.query(AiActionLogDB)
        .filter(AiActionLogDB.user_id == user.id, AiActionLogDB.day == day)
        .order_by(AiActionLogDB.created_at.desc())
        .limit(200)
        .all()
    )
    return {
        "day": day.isoformat(),
        "used": usage_today(db, quota_subject(user)),   # the meter's number
        "logged": len(rows),                        # how many we can describe
        "items": [
            {
                "action": r.action,
                "action_label": _ACTION_LABELS.get(r.action, "AI action"),
                "label": r.label,
                "at": (r.created_at.isoformat() + "Z") if r.created_at else None,
            }
            for r in rows
        ],
    }


# Registered on both "" and "/" so DELETE /api/account works without a 307
# redirect (some HTTP clients drop the Authorization header on redirects).
@router.post("/share-key")
def create_share_key(user: AuthUser = Depends(get_current_user), db: Session = Depends(get_db)):
    """Mint the save-scoped key the Android no-display share Activity carries.

    That Activity runs outside the JS runtime and cannot use the Supabase
    session — see `app/sharekey.py` for why reading or refreshing the access
    token natively were both rejected. The app calls this on sign-in and on
    each launch, which is also what keeps the tier/quota snapshots fresh.

    Replaces any previous key, so this doubles as "rotate". Nothing but the
    save route accepts the result.
    """
    return {"key": mint_share_key(db, user)}


@router.delete("/share-key")
def revoke_share_key_route(user: AuthUser = Depends(get_current_user), db: Session = Depends(get_db)):
    """Sign-out. The device drops its copy anyway, but a credential that
    outlives the session it was minted from is exactly the kind of thing you
    want revocable from the server side too."""
    revoke_share_key(db, user)
    return {"revoked": True}


@router.delete("")
@router.delete("/", include_in_schema=False)
def delete_account(user: AuthUser = Depends(get_current_user), db: Session = Depends(get_db)):
    """Delete all data associated with the authenticated user: reels, their
    tasks and workout exercises, and personal notes. Children are deleted
    explicitly (not left to FK cascade) so this also sweeps any orphans and
    behaves identically on SQLite and Postgres. `ai_usage` rows are kept —
    deleting them would let a user reset their daily AI quota by wiping data.
    The Supabase Auth user record is managed separately via the client SDK."""

    user_id = user.id
    reel_ids = select(ReelDB.id).where(ReelDB.user_id == user_id)

    # Todos are owned directly by the user (a standalone one has no reel), so
    # they'd survive the reel sweep below — delete them by user_id, first.
    db.query(TodoDB).filter(TodoDB.user_id == user_id).delete(synchronize_session=False)
    tasks_removed = (
        db.query(TaskDB)
        .filter(TaskDB.reel_id.in_(reel_ids))
        .delete(synchronize_session=False)
    )
    exercises_removed = (
        db.query(WorkoutExerciseDB)
        .filter(WorkoutExerciseDB.reel_id.in_(reel_ids))
        .delete(synchronize_session=False)
    )
    reel_count = (
        db.query(ReelDB)
        .filter(ReelDB.user_id == user_id)
        .delete(synchronize_session=False)
    )
    # The AI action log is per-user DESCRIPTIVE data — it holds reel titles, so
    # it goes with the account and the deletion promise means something.
    #
    # ⚠️ ai_usage counters stay, and as of 2026-08-12 that finally MATTERS.
    # Keeping them used to be pointless: the counter was keyed on user_id, so a
    # re-signup got a new id, never looked at the preserved row, and was handed
    # a full daily budget — "delete the account, get 10 more AI actions",
    # repeatable in about fifteen seconds via Google sign-in. The counter is now
    # keyed on the normalized-email hash (see quota.quota_subject), the same
    # stable identity that already protects the trial clock, so preserving these
    # rows is what actually closes the hole. Do not add them to this wipe.
    db.query(AiActionLogDB).filter(AiActionLogDB.user_id == user_id).delete(synchronize_session=False)
    # Profile (trial clock) goes with the account. trial_grants stays: it holds
    # only a hash of the normalized email and exists precisely so that deleting
    # the account can't mint a fresh trial (fraud-prevention, no readable PII).
    db.query(ProfileDB).filter(ProfileDB.user_id == user_id).delete(synchronize_session=False)
    # extraction_cache is shared (keyed by URL, no user data) — untouched.
    db.commit()

    # Data is gone — now remove the Supabase Auth record so the account truly
    # ceases to exist (otherwise the user can sign right back in).
    auth_deleted = _delete_auth_user(user_id)

    logger.info(
        f"Account deleted for user {user_id}: {reel_count} reels, "
        f"{tasks_removed} tasks, {exercises_removed} exercises removed, "
        f"auth_deleted={auth_deleted}"
    )

    return {
        "deleted": True,
        "auth_deleted": auth_deleted,
        "reels_removed": reel_count,
        "message": (
            "Your account and all saved data have been deleted."
            if auth_deleted
            else "All your saved data has been deleted, but the sign-in record "
                 "couldn't be removed — contact support to finish closing the account."
        ),
    }
