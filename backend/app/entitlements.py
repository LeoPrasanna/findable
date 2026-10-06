"""Tier entitlements — the single source of truth for what a user may do.

Three effective tiers:

  pro    app_metadata.tier == "pro" (server-stamped: scripts/set_tier.py now,
         the RevenueCat webhook at launch). Unlimited saves, AI_PRO_DAILY_LIMIT.
  trial  free account inside its trial window (TRIAL_DAYS from the first
         authenticated request + trial_extra_days). Unlimited saves,
         AI_DAILY_LIMIT per day.
  free   trial expired. Library stays fully usable (view/search/notes/delete);
         NEW saves capped at FREE_SAVE_LIMIT; AI_FREE_DAILY_LIMIT per day (a
         trickle, not zero — a dead app uninstalls, a limited app upsells).
         Saves still get a full automatic summary — see FREE_AUTO_SUMMARY.

⚠️ EVERY TIER IS CAPPED (owner, 2026-09-11): 50 free, 500 pro. It used to be 20
on free and UNLIMITED above, so the paid tier's storage promise was "no limit" — a
promise with no ceiling is one you cannot price and cannot budget for. Saves remain
a real upgrade lever; a 10x difference is the lever.

⚠️ THE TRIAL GOT ITS OWN CAP OF 100 (owner, 2026-10-06), which REVERSES part of
the above. The trial keeps the paid AI limit — that is what paying feels like — but
not the paid STORAGE limit, because 500-on-trial against 50-on-free let someone
build a library the free tier could not hold. The most engaged trial users then
landed hardest on the day it ended, which is precisely the cohort most likely to
have paid. `TRIAL_SAVE_LIMIT` in config.py carries the full reasoning.
`save_limit` stays `int | None` because the enforcement points already branch on
None and an unlimited tier may come back; nothing sets None today.

The trial clock lives server-side (ProfileDB) so the client can't forge it, and
is keyed to a hash of the normalized email (TrialGrantDB) so deleting the
account or re-signing up with you+2@gmail.com continues the ORIGINAL trial
instead of starting a fresh one. Every enforcement point (AI quota charge, the
save cap, the usage endpoint) calls `entitlements_for` — never duplicate the
tier math elsewhere.
"""
import hashlib
import re
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import settings
from app.auth import AuthUser
from app.database import ProfileDB, TrialGrantDB

# Idempotent inserts — DO NOTHING on concurrent creation. The ON CONFLICT
# (column-list) syntax is identical on SQLite and Postgres.
_ENSURE_PROFILE = text(
    "INSERT INTO profiles (user_id, trial_started_at, trial_extra_days, created_at) "
    "VALUES (:user_id, :started, 0, :now) "
    "ON CONFLICT (user_id) DO NOTHING"
)
_ENSURE_GRANT = text(
    "INSERT INTO trial_grants (email_hash, trial_started_at) "
    "VALUES (:email_hash, :started) "
    "ON CONFLICT (email_hash) DO NOTHING"
)


def tier_for(user: AuthUser) -> str:
    """The user's PAID tier, read from the JWT's `app_metadata` claim.

    `app_metadata` is server-controlled (only the service-role key can write
    it), so a user can't self-upgrade by editing their own `user_metadata`.
    Known staleness: access tokens live ~1 h, so a downgrade can lag that long
    — bounded and accepted (see docs/HANDOFF.md)."""
    meta = (getattr(user, "claims", None) or {}).get("app_metadata") or {}
    tier = meta.get("tier")
    return tier if tier in ("free", "pro") else "free"


def normalize_email(email: str) -> str:
    """Collapse the cheap aliasing tricks so they hash to the same trial grant:
    case, +tags (all providers), and dots in gmail local parts."""
    email = email.strip().lower()
    if "@" not in email:
        return email
    local, domain = email.rsplit("@", 1)
    local = local.split("+", 1)[0]
    if domain in ("gmail.com", "googlemail.com"):
        local = local.replace(".", "")
        domain = "gmail.com"
    return f"{local}@{domain}"


def _email_hash(email: str) -> str:
    return hashlib.sha256(normalize_email(email).encode("utf-8")).hexdigest()


def _get_or_create_profile(db: Session, user: AuthUser, *, now: datetime) -> ProfileDB:
    """The user's profile row, creating it (and its trial grant) on first touch.

    Trial-continuity rule: if this normalized email already consumed a trial
    (TrialGrantDB row exists), the new profile inherits that ORIGINAL start —
    re-signup never resets the clock. Emails we can't see (no claim) grant a
    normal trial; that residue is accepted until Apple IAP raises the cost of
    identity cycling."""
    profile = db.query(ProfileDB).filter(ProfileDB.user_id == user.id).first()
    if profile is not None:
        return profile

    started = now
    if user.email:
        eh = _email_hash(user.email)
        db.execute(_ENSURE_GRANT, {"email_hash": eh, "started": now})
        grant = db.query(TrialGrantDB).filter(TrialGrantDB.email_hash == eh).first()
        if grant is not None:
            started = grant.trial_started_at

    db.execute(_ENSURE_PROFILE, {"user_id": user.id, "started": started, "now": now})
    db.commit()
    return db.query(ProfileDB).filter(ProfileDB.user_id == user.id).one()


# One message everywhere a Pro-only feature is refused (403). `{feature}` is the
# human-readable feature name. Kept here so routes and tests share one string.
# Locked buttons in the app are cosmetic — THIS is the enforcement.
PRO_FEATURE_DETAIL = (
    "{feature} is a Pro feature. Your free plan keeps saving, your library and "
    "summaries — upgrade to Pro to unlock {feature}."
)


@dataclass
class Entitlements:
    tier: str                       # 'pro' | 'trial' | 'free' (effective)
    ai_daily_limit: int
    # None = unlimited; gates NEW saves only. FREE_SAVE_LIMIT on free,
    # TRIAL_SAVE_LIMIT on trial, PRO_SAVE_LIMIT on pro — see the module docstring.
    save_limit: int | None
    trial_ends_at: datetime | None  # UTC; None for pro
    # Feature gating (revised 2026-07-28): post-trial free keeps saves/library/
    # search/auto-summaries only — ALL derived AI actions (workout, recipe, tasks,
    # itinerary, ask) are Pro-only for now (free users will earn them via rewarded
    # ads later). Trial keeps FULL access — it's the demo that converts. Gating on
    # tier (not the user-editable category) also closes the recategorize-to-unlock
    # hole entirely.
    # ⚠️ TIED TO can_ask ON PURPOSE — see the note in routes/reels.py. A reel
    # saved without `auto_summary` gets the cheap index pass (tags, category,
    # title) and no bullets, and Ask is the only feature that reads bullets in
    # bulk. Turning this off for a tier that CAN open Ask would make Ask answer
    # from an empty library, which is the one way this change goes wrong.
    auto_summary: bool = True
    can_ask: bool = True            # Ask-my-Library
    can_tasks: bool = True          # "Turn into Action" tasks (non-cooking reels)
    can_recipe: bool = True         # "Get Recipe" (cooking-category tasks)
    can_workout: bool = True        # "Build Workout" (fitness reels)
    can_itinerary: bool = True      # Trip Itinerary on travel reels


def entitlements_for(user: AuthUser, db: Session, *, now: datetime | None = None) -> Entitlements:
    """What this user may do right now. Cheap: one profile lookup (one insert on
    first-ever call), no lookup at all for pro."""
    now = now or datetime.utcnow()

    if tier_for(user) == "pro":
        return Entitlements(
            tier="pro",
            ai_daily_limit=settings.AI_PRO_DAILY_LIMIT,
            save_limit=settings.PRO_SAVE_LIMIT,
            trial_ends_at=None,
        )

    profile = _get_or_create_profile(db, user, now=now)
    trial_ends = profile.trial_started_at + timedelta(
        days=settings.TRIAL_DAYS + (profile.trial_extra_days or 0)
    )

    if now < trial_ends:
        return Entitlements(
            tier="trial",
            ai_daily_limit=settings.AI_DAILY_LIMIT,
            # ⚠️ NOT THE PRO CAP ANY MORE (owner, 2026-10-06). The trial keeps the
            # PAID AI limit, because that is what paying feels like — but its own
            # storage cap, because a 500-save trial against a 50-save free tier lets
            # someone build a library the free tier cannot hold. See the note on
            # TRIAL_SAVE_LIMIT in config.py.
            save_limit=settings.TRIAL_SAVE_LIMIT,
            trial_ends_at=trial_ends,
        )

    return Entitlements(
        tier="free",
        ai_daily_limit=settings.AI_FREE_DAILY_LIMIT,
        save_limit=settings.FREE_SAVE_LIMIT,
        trial_ends_at=trial_ends,
        # ⚠️ TRUE BY DEFAULT — free saves get the full summary, same as every
        # other tier. Gating this to `index_only` shipped and was reverted the
        # same day (owner): the automatic summary is what the product is.
        # Flip settings.FREE_AUTO_SUMMARY to re-gate; see the note in config.py
        # for the cost argument that has not gone away.
        auto_summary=settings.FREE_AUTO_SUMMARY,
        can_ask=False,
        can_tasks=False,
        can_recipe=False,
        can_workout=False,
        can_itinerary=False,
    )
