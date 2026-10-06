"""Which saves are LOCKED when a library sits above its tier's cap.

Owner decision 2026-10-06, choosing "lock, do not delete" over deleting the excess:

    trial allows TRIAL_SAVE_LIMIT, free allows FREE_SAVE_LIMIT. Ten enthusiastic
    trial days can leave someone well over the free line the day the trial ends.

⚠️ NOTHING IS EVER DELETED, AND THAT IS THE POINT OF THIS MODULE. The newest
`save_limit` saves stay fully open; everything older becomes read-only — still in the
library, still visible, still deletable — until the user either deletes enough newer
saves or upgrades. Every lock in here is reversible by an action the user can take, and
the moment the cap rises the same rows unlock with no migration and no restore.

Deleting the excess was the alternative and it was rejected: it destroys content someone
chose to keep, it cannot be undone, and the people it would hit hardest are the ones who
used the trial most — the cohort most likely to have paid.

⚠️ LOCKED SAVES STILL COUNT TOWARD THE CAP. Locking does not free space, so saving again
means deleting — and the locked ones are the obvious candidates. That is deliberate: a
lock that silently created room would be a second, invisible cap, and the save gate in
routes/reels.py would disagree with this module about what the library holds.

⚠️ THE SERVER DECIDES THIS, NOT THE CLIENT. The `locked` flag on a reel is a rendering
hint; the enforcement is a 403 from the routes. A client that ignored the flag must still
be unable to read a locked reel, or "locked" is a suggestion.
"""
from datetime import datetime

from sqlalchemy.orm import Session

from app.auth import AuthUser
from app.database import ReelDB
from app.entitlements import entitlements_for


def lock_cutoff(db: Session, user_id: str, save_limit: int | None) -> datetime | None:
    """The `created_at` below which a save is locked, or None if nothing is.

    Found by rank, not by arithmetic: the cap is a count, so the boundary is the
    `save_limit`-th newest row's timestamp. One indexed query, no scan of the library.

    ⚠️ TIES AT THE BOUNDARY STAY OPEN. The comparison in `is_locked` is strictly
    older-than, so two saves sharing the cutoff timestamp are both readable — a library
    can sit one or two over its cap after a double-save in the same second. That is the
    direction an error has to go: a couple of extra open saves costs nothing, and
    wrongly locking something the user can still see is the failure that matters.
    """
    if save_limit is None or save_limit <= 0:
        return None
    row = (
        db.query(ReelDB.created_at)
        .filter(ReelDB.user_id == user_id)
        .order_by(ReelDB.created_at.desc())
        .offset(save_limit - 1)
        .limit(1)
        .first()
    )
    # Fewer saves than the cap — the offset falls off the end and nothing is locked.
    if row is None:
        return None
    return row[0]


def is_locked(reel: ReelDB, cutoff: datetime | None) -> bool:
    """Whether this specific save is locked, given a cutoff from `lock_cutoff`."""
    if cutoff is None:
        return False
    created = getattr(reel, "created_at", None)
    if created is None:
        # A row with no timestamp cannot be ranked, so it is not locked. Unrankable
        # must never mean inaccessible.
        return False
    return created < cutoff


def cutoff_for(user: AuthUser, db: Session) -> datetime | None:
    """`lock_cutoff` for whatever this user's tier currently allows.

    The one call sites should use: it keeps the tier maths in `entitlements_for`, which
    is the single source of truth for what a user may do (see that module's docstring).
    """
    return lock_cutoff(db, user.id, entitlements_for(user, db).save_limit)
