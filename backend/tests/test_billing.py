"""RevenueCat webhook -> Supabase tier stamp.

This endpoint mints revenue entitlements, so the behavior is locked here before
it's wired into main.py. The Supabase admin PUT is mocked — no network, no real
tier writes. Each test asserts on whether (and with what tier) that PUT fires.

Mounts the billing router on a throwaway FastAPI app so the test is independent
of whether main.py has registered it yet.
"""
from datetime import datetime, timedelta, timezone

import pytest
from unittest.mock import MagicMock
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.auth import get_current_user, AuthUser
from app.config import settings
from app.routes import billing

TOKEN = "test-webhook-secret"
USER = "supabase-user-123"


@pytest.fixture
def client(monkeypatch):
    # Fail-closed unless configured: give the webhook a token and fake Supabase
    # admin creds so `_set_tier`'s guard passes.
    monkeypatch.setattr(settings, "REVENUECAT_WEBHOOK_TOKEN", TOKEN)
    monkeypatch.setattr(settings, "SUPABASE_URL", "https://proj.supabase.co")
    monkeypatch.setattr(settings, "SUPABASE_SERVICE_ROLE_KEY", "service-role-key")

    # Mock the admin PUT so nothing hits the network; capture calls for assertions.
    put_mock = MagicMock(return_value=MagicMock(raise_for_status=lambda: None))
    monkeypatch.setattr(billing.httpx, "put", put_mock)

    app = FastAPI()
    app.include_router(billing.router)
    client = TestClient(app)
    client.put_mock = put_mock  # tests read this to inspect the admin call
    return client


def _post(client, event_type, *, user_id=USER, token=TOKEN):
    headers = {"Authorization": token} if token is not None else {}
    return client.post(
        "/api/billing/revenuecat",
        json={"event": {"type": event_type, "app_user_id": user_id}},
        headers=headers,
    )


def _tier_written(put_mock):
    """The tier value from the last admin PUT, or None if none was made."""
    if not put_mock.called:
        return None
    _, kwargs = put_mock.call_args
    return kwargs["json"]["app_metadata"]["tier"]


class TestRevenueCatWebhook:
    @pytest.mark.parametrize("event_type", [
        "INITIAL_PURCHASE", "RENEWAL", "UNCANCELLATION",
        "NON_RENEWING_PURCHASE", "PRODUCT_CHANGE",
    ])
    def test_grant_events_set_pro(self, client, event_type):
        res = _post(client, event_type)
        assert res.status_code == 200
        assert _tier_written(client.put_mock) == "pro"
        # The PUT targets the right user.
        assert USER in client.put_mock.call_args[0][0]

    def test_expiration_sets_free(self, client):
        res = _post(client, "EXPIRATION")
        assert res.status_code == 200
        assert _tier_written(client.put_mock) == "free"

    def test_cancellation_does_not_change_tier(self, client):
        # CANCELLATION = auto-renew off; the user keeps pro until EXPIRATION.
        # Writing free here would yank a paying customer's access mid-cycle.
        res = _post(client, "CANCELLATION")
        assert res.status_code == 200
        assert not client.put_mock.called

    @pytest.mark.parametrize("event_type", ["BILLING_ISSUE", "TRANSFER", "TEST"])
    def test_non_entitlement_events_are_noops(self, client, event_type):
        res = _post(client, event_type)
        assert res.status_code == 200
        assert not client.put_mock.called

    def test_bad_token_rejected_and_touches_no_tier(self, client):
        res = _post(client, "INITIAL_PURCHASE", token="wrong-secret")
        assert res.status_code == 401
        assert not client.put_mock.called

    def test_missing_token_rejected(self, client):
        res = _post(client, "INITIAL_PURCHASE", token=None)
        assert res.status_code == 401
        assert not client.put_mock.called

    def test_unset_server_token_is_fail_closed(self, client, monkeypatch):
        # Even a caller sending an empty Authorization must not match an unset
        # server token — otherwise an unconfigured deploy would accept anyone.
        monkeypatch.setattr(settings, "REVENUECAT_WEBHOOK_TOKEN", "")
        res = _post(client, "INITIAL_PURCHASE", token="")
        assert res.status_code == 401
        assert not client.put_mock.called

    def test_anonymous_user_is_ignored_not_charged(self, client):
        # App didn't call Purchases.logIn(supabaseUserId): 200 so RevenueCat
        # stops retrying, but no tier write (there's no user to map to).
        res = _post(client, "INITIAL_PURCHASE", user_id="$RCAnonymousID:abc123")
        assert res.status_code == 200
        assert res.json()["status"] == "ignored"
        assert not client.put_mock.called

    def test_missing_user_id_is_ignored(self, client):
        res = client.post(
            "/api/billing/revenuecat",
            json={"event": {"type": "INITIAL_PURCHASE"}},  # no app_user_id
            headers={"Authorization": TOKEN},
        )
        assert res.status_code == 200
        assert not client.put_mock.called


# ── POST /api/billing/sync ───────────────────────────────────────────────────
# The path a real purchase takes. The webhook is too slow to BE a purchase flow:
# it lands asynchronously and only reaches the app on the next JWT refresh, so
# without this a user who just paid keeps seeing the free tier.

def _subscriber(entitlements):
    return MagicMock(
        status_code=200,
        json=lambda: {"subscriber": {"entitlements": entitlements}},
        text="",
    )


@pytest.fixture
def synced(client, monkeypatch):
    """`client`, plus a configured REST key and an authenticated user."""
    monkeypatch.setattr(settings, "REVENUECAT_API_KEY", "sk-secret")
    monkeypatch.setattr(settings, "REVENUECAT_PRO_ENTITLEMENT", "pro")
    client.app.dependency_overrides[get_current_user] = lambda: AuthUser(id=USER)
    return client


def _rc(monkeypatch, response):
    get_mock = MagicMock(return_value=response)
    monkeypatch.setattr(billing.httpx, "get", get_mock)
    return get_mock


FUTURE = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat().replace("+00:00", "Z")
PAST = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat().replace("+00:00", "Z")


class TestSyncEntitlement:
    def test_active_entitlement_grants_pro(self, synced, monkeypatch):
        get_mock = _rc(monkeypatch, _subscriber({"pro": {"expires_date": FUTURE}}))
        res = synced.post("/api/billing/sync")
        assert res.status_code == 200
        assert res.json() == {"tier": "pro", "active": True}
        assert _tier_written(synced.put_mock) == "pro"
        # Looked up by the id from the VERIFIED JWT, not from any request body.
        assert USER in get_mock.call_args[0][0]

    def test_lifetime_entitlement_grants_pro(self, synced, monkeypatch):
        # A non-renewing / lifetime grant has no expiry at all.
        _rc(monkeypatch, _subscriber({"pro": {"expires_date": None}}))
        assert synced.post("/api/billing/sync").json()["active"] is True
        assert _tier_written(synced.put_mock) == "pro"

    def test_expired_entitlement_grants_nothing(self, synced, monkeypatch):
        # ⚠️ RevenueCat KEEPS expired entitlements in the payload. Treating
        # presence as entitlement would hand Pro to everyone who ever lapsed.
        _rc(monkeypatch, _subscriber({"pro": {"expires_date": PAST}}))
        res = synced.post("/api/billing/sync")
        assert res.json() == {"tier": None, "active": False}
        assert not synced.put_mock.called

    def test_a_different_entitlement_does_not_count(self, synced, monkeypatch):
        _rc(monkeypatch, _subscriber({"plus": {"expires_date": FUTURE}}))
        assert synced.post("/api/billing/sync").json()["active"] is False
        assert not synced.put_mock.called

    def test_entitlement_name_comes_from_config(self, synced, monkeypatch):
        # A dashboard that calls it something else must still work via env.
        monkeypatch.setattr(settings, "REVENUECAT_PRO_ENTITLEMENT", "findable_pro")
        _rc(monkeypatch, _subscriber({"findable_pro": {"expires_date": FUTURE}}))
        assert _tier_written_after(synced) == "pro"

    def test_unparseable_expiry_is_not_an_entitlement(self, synced, monkeypatch):
        _rc(monkeypatch, _subscriber({"pro": {"expires_date": "whenever"}}))
        assert synced.post("/api/billing/sync").json()["active"] is False
        assert not synced.put_mock.called

    def test_unknown_subscriber_is_not_an_error(self, synced, monkeypatch):
        # 404 = never bought anything. Normal for anyone tapping Restore.
        _rc(monkeypatch, MagicMock(status_code=404, text="not found"))
        res = synced.post("/api/billing/sync")
        assert res.status_code == 200
        assert res.json() == {"tier": None, "active": False}
        assert not synced.put_mock.called

    def test_sync_never_downgrades(self, synced, monkeypatch):
        """⚠️ THE ASYMMETRY IS THE POINT, and this is the test that enforces it.

        `scripts/set_tier.py` is how the owner's own account and every test
        account became pro, and RevenueCat has never heard of those purchases. A
        sync that wrote `free` on "no entitlement found" would wipe them the first
        time anyone tapped Restore. Only the webhook's EXPIRATION revokes.
        """
        for response in (
            MagicMock(status_code=404, text=""),
            _subscriber({}),
            _subscriber({"pro": {"expires_date": PAST}}),
        ):
            synced.put_mock.reset_mock()
            _rc(monkeypatch, response)
            assert synced.post("/api/billing/sync").status_code == 200
            assert not synced.put_mock.called, "sync must never write a tier down"

    def test_unconfigured_server_says_so_rather_than_lying(self, synced, monkeypatch):
        # A silent 200 would tell the app a purchase was applied when nothing
        # was checked. 503 with a sentence a human can read.
        monkeypatch.setattr(settings, "REVENUECAT_API_KEY", "")
        res = synced.post("/api/billing/sync")
        assert res.status_code == 503
        assert "not configured" in res.json()["detail"].lower()
        assert not synced.put_mock.called

    def test_store_unreachable_is_a_readable_502(self, synced, monkeypatch):
        monkeypatch.setattr(billing.httpx, "get",
                            MagicMock(side_effect=billing.httpx.ConnectTimeout("boom")))
        res = synced.post("/api/billing/sync")
        assert res.status_code == 502
        # The user's money is the thing they are worried about — say it is safe.
        assert "purchase is safe" in res.json()["detail"].lower()
        assert not synced.put_mock.called

    def test_store_error_does_not_grant(self, synced, monkeypatch):
        _rc(monkeypatch, MagicMock(status_code=500, text="server error"))
        res = synced.post("/api/billing/sync")
        assert res.status_code == 502
        assert not synced.put_mock.called

    def test_sync_requires_auth(self, client, monkeypatch):
        # No dependency override here: the real dependency must reject.
        monkeypatch.setattr(settings, "REVENUECAT_API_KEY", "sk-secret")
        client.app.dependency_overrides.pop(get_current_user, None)
        res = client.post("/api/billing/sync")
        assert res.status_code in (401, 403)
        assert not client.put_mock.called


def _tier_written_after(c):
    assert c.post("/api/billing/sync").status_code == 200
    return _tier_written(c.put_mock)
