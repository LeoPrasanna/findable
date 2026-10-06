"""RevenueCat webhook → stamp `app_metadata.tier` in Supabase.

⚠️ THIS MINTS REVENUE ENTITLEMENTS. It is registered in `main.py` and
**fail-closed by configuration**: the webhook rejects every call while
`REVENUECAT_WEBHOOK_TOKEN` is unset, and `/sync` returns 503 while
`REVENUECAT_API_KEY` is unset. Registering it is therefore safe; configuring it
is the act that turns billing on.

Two paths in, on purpose
------------------------
* **`POST /sync`** — the user's own app, right after a purchase or a restore. Asks
  RevenueCat directly, so the grant is immediate and deterministic. GRANT-ONLY.
* **`POST /revenuecat`** — RevenueCat's webhook, for everything that happens when
  the app is not open: renewals, expirations, refunds. The only path that revokes.

What this replaces
------------------
`scripts/set_tier.py` (owner-run, manual) does the exact Supabase admin write
this endpoint automates. Same PUT, same service-role key — the only new parts
are (1) authenticating the caller (RevenueCat, not a logged-in user) and
(2) mapping RevenueCat's event types to `pro` / `free`.

Wiring preconditions (all required before this works)
-----------------------------------------------------
1. **Mobile app must set RevenueCat's `appUserID` to the Supabase user id.**
   The webhook's `event.app_user_id` is how we know WHOSE tier to change. If the
   app lets RevenueCat generate an anonymous id, we can't map the purchase back
   to a Supabase user. Configure this at login (Purchases.logIn(supabaseUserId)).
2. **Env vars:** `REVENUECAT_WEBHOOK_TOKEN` (shared secret you set in the
   RevenueCat dashboard's webhook "Authorization header value") and
   `REVENUECAT_API_KEY` (the v1 REST **secret** key, for `/sync`), plus the
   existing `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Also
   `REVENUECAT_PRO_ENTITLEMENT` if the entitlement is not called `pro`.
3. ✅ Router registered in `app/main.py`.
4. In RevenueCat: Integrations → Webhooks → point at
   `https://<your-backend>/api/billing/revenuecat`, set the Authorization value
   to the same secret as `REVENUECAT_WEBHOOK_TOKEN`.

Tier takes effect on the user's next token refresh (<=1h) or re-login, exactly
like `set_tier.py` — the JWT `app_metadata.tier` claim is what `entitlements.py`
reads (see `tier_for`).
"""
import hmac
import logging
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Request

from app.auth import get_current_user, AuthUser
from app.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/billing", tags=["billing"])

# RevenueCat event types, grouped by what they mean for entitlement.
#   GRANT   → user is (or just became) entitled → tier = pro
#   REVOKE  → entitlement actually ended         → tier = free
#   IGNORE  → auto-renew toggled / billing grace / transfers: entitlement
#             UNCHANGED, so touching the tier here would be wrong
#             (e.g. CANCELLATION only means auto-renew is off — they keep pro
#             until EXPIRATION).
_GRANT = {
    "INITIAL_PURCHASE", "RENEWAL", "UNCANCELLATION",
    "NON_RENEWING_PURCHASE", "PRODUCT_CHANGE", "SUBSCRIPTION_EXTENDED",
}
_REVOKE = {"EXPIRATION"}


def _set_tier(user_id: str, tier: str) -> None:
    """Write `app_metadata.tier` via the Supabase admin API (same call as
    scripts/set_tier.py). Idempotent — writing pro twice is a no-op, which is
    exactly what we want since RevenueCat retries webhooks."""
    if not (settings.SUPABASE_URL and settings.SUPABASE_SERVICE_ROLE_KEY):
        raise HTTPException(500, "Supabase admin credentials not configured")
    key = settings.SUPABASE_SERVICE_ROLE_KEY
    r = httpx.put(
        f"{settings.SUPABASE_URL.rstrip('/')}/auth/v1/admin/users/{user_id}",
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
        json={"app_metadata": {"tier": tier}},
        timeout=15,
    )
    r.raise_for_status()


@router.post("/revenuecat")
async def revenuecat_webhook(request: Request, authorization: str = Header(default="")):
    """Receive a RevenueCat webhook and flip the user's tier.

    Auth is a shared secret: RevenueCat sends whatever you configure as the
    webhook's Authorization header value; we compare it (constant-time) to
    settings.REVENUECAT_WEBHOOK_TOKEN. An unset token is fail-closed (every call
    is rejected). Anything mismatched -> 401 (never touch a tier)."""
    token = settings.REVENUECAT_WEBHOOK_TOKEN
    if not token or not hmac.compare_digest(authorization, token):
        raise HTTPException(status_code=401, detail="Unauthorized")

    body = await request.json()
    event = body.get("event") or {}
    event_type = event.get("type")
    user_id = event.get("app_user_id")

    # An anonymous / missing app_user_id means the mobile app didn't call
    # Purchases.logIn(supabaseUserId). Accept the webhook (200 so RevenueCat
    # stops retrying) but log loudly — this is a wiring bug, not a runtime error.
    if not user_id or user_id.startswith("$RCAnonymousID:"):
        logger.warning("[BILLING] webhook %s with unmapped app_user_id=%r — "
                       "app must set RevenueCat appUserID to the Supabase id",
                       event_type, user_id)
        return {"status": "ignored", "reason": "unmapped_user"}

    if event_type in _GRANT:
        _set_tier(user_id, "pro")
        logger.info("[BILLING] %s → tier=pro for %s", event_type, user_id)
    elif event_type in _REVOKE:
        _set_tier(user_id, "free")
        logger.info("[BILLING] %s → tier=free for %s", event_type, user_id)
    else:
        # CANCELLATION, BILLING_ISSUE, TRANSFER, TEST, etc. — entitlement
        # unchanged; acknowledge without a tier write.
        logger.info("[BILLING] %s → no tier change for %s", event_type, user_id)

    return {"status": "ok"}


def _entitlement_active(subscriber: dict, name: str) -> bool:
    """Whether `name` is an entitlement this subscriber currently holds.

    RevenueCat keeps expired entitlements in the payload with a past
    `expires_date`, so presence is not entitlement. A null `expires_date` is a
    lifetime/non-renewing grant and counts as active.
    """
    ent = ((subscriber or {}).get("entitlements") or {}).get(name)
    if not isinstance(ent, dict):
        return False
    expires = ent.get("expires_date")
    if not expires:
        return True
    try:
        when = datetime.fromisoformat(str(expires).replace("Z", "+00:00"))
    except ValueError:
        # An unparseable date must not silently entitle someone. Treat it as
        # inactive and let the webhook be the authority.
        logger.warning("[BILLING] unparseable expires_date=%r for %r", expires, name)
        return False
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return when > datetime.now(timezone.utc)


@router.post("/sync")
def sync_entitlement(user: AuthUser = Depends(get_current_user)):
    """Ask RevenueCat what THIS user is entitled to, now, and stamp the tier.

    ⚠️ THIS EXISTS BECAUSE THE WEBHOOK IS TOO SLOW TO BE A PURCHASE FLOW. The
    webhook arrives asynchronously and the tier it writes only reaches the app on
    the next JWT refresh (<=1h) — so a user who has just paid would keep seeing the
    free tier, with a receipt in their hand. That is the worst bug this app could
    have. The client calls this immediately after a purchase or a restore, then
    refreshes its Supabase session, and the grant is deterministic rather than a
    race against a webhook.

    ⚠️ IT GRANTS BUT NEVER REVOKES, deliberately and asymmetrically.
    `scripts/set_tier.py` stamps tiers by hand (it is how the owner's own account
    and every test account became pro), and RevenueCat knows nothing about those.
    A sync that downgraded on "no entitlement found" would wipe them the first time
    anyone tapped Restore. Revocation stays with the webhook's EXPIRATION event,
    which is the only signal that actually means an entitlement ended.

    ⚠️ THE USER ID IS TAKEN FROM THE VERIFIED JWT, never from the request body.
    The app sets RevenueCat's appUserID to the Supabase id (Purchases.logIn), so
    `user.id` is the correct subscriber to look up — and a client cannot ask us to
    sync somebody else's purchase.
    """
    key = settings.REVENUECAT_API_KEY
    if not key:
        # Fail-closed and SAY SO. A silent 200 here would tell the app a purchase
        # had been applied when nothing was checked.
        raise HTTPException(503, "Billing is not configured on the server yet.")

    try:
        r = httpx.get(
            f"https://api.revenuecat.com/v1/subscribers/{user.id}",
            headers={"Authorization": f"Bearer {key}"},
            timeout=15,
        )
    except httpx.HTTPError as e:
        logger.warning("[BILLING] sync unreachable for %s: %s", user.id, e)
        raise HTTPException(502, "Couldn't reach the store. Your purchase is safe — try again in a moment.")

    # 404 = RevenueCat has never seen this subscriber, i.e. nothing was bought.
    # Not an error, and not a reason to touch the tier (see the grant-only note).
    if r.status_code == 404:
        return {"tier": None, "active": False}
    if r.status_code >= 400:
        logger.warning("[BILLING] sync %s for %s: %s", r.status_code, user.id, r.text[:200])
        raise HTTPException(502, "Couldn't confirm your purchase with the store. Try again in a moment.")

    subscriber = (r.json() or {}).get("subscriber") or {}
    active = _entitlement_active(subscriber, settings.REVENUECAT_PRO_ENTITLEMENT)
    if not active:
        return {"tier": None, "active": False}

    _set_tier(user.id, "pro")
    logger.info("[BILLING] sync → tier=pro for %s", user.id)
    return {"tier": "pro", "active": True}
