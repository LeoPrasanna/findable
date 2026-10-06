"""Locking a library that sits above its tier's cap.

Owner decision 2026-10-06: **lock, do not delete.** The alternative on the table was
deleting the excess when a trial ends, and it was rejected — it destroys content someone
chose to keep, it cannot be undone, and it would hit hardest the people who used the
trial most.

⚠️ THE TWO TESTS THAT MATTER MOST HERE ARE THE NEGATIVE ONES: that DELETE still works on
a locked save (otherwise the lock is a trap with no exit but a purchase), and that Ask
cannot answer out of locked saves (otherwise the lock leaks its own content back as
prose, while charging an AI action to do it).
"""
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.main import app
from app.auth import get_current_user, AuthUser
from app.config import settings
from app.database import Base, get_db, ReelDB, ProfileDB


@pytest.fixture
def env():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    TestingSession = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    Base.metadata.create_all(bind=engine)

    def _override_get_db():
        s = TestingSession()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _override_get_db

    def _client(user: AuthUser) -> TestClient:
        app.dependency_overrides[get_current_user] = lambda: user
        return TestClient(app)

    yield _client, TestingSession
    app.dependency_overrides.clear()


def _seed(Session, user_id: str, n: int):
    """n saves, NEWEST FIRST as `-r0`, with explicit one-minute gaps.

    ⚠️ THE TIMESTAMPS ARE EXPLICIT BECAUSE THE WHOLE FEATURE IS A RANKING. The column
    default is `datetime.utcnow` at insert, and a tight insert loop can land several
    rows inside one clock tick — which would make "the newest N" ambiguous and the test
    pass or fail on timer resolution rather than on the logic.
    """
    base = datetime(2026, 1, 1, 12, 0, 0)
    db = Session()
    try:
        for i in range(n):
            db.add(ReelDB(
                id=f"{user_id}-r{i}", user_id=user_id, url=f"u-{user_id}-{i}",
                platform="youtube", summary_status="ready",
                title=f"reel {i}", summary=[f"summary of reel {i}"],
                created_at=base - timedelta(minutes=i),
            ))
        db.commit()
    finally:
        db.close()


def _expire_trial(Session, user_id: str):
    """Put this user on the free tier by backdating their trial out of the window."""
    db = Session()
    try:
        p = db.query(ProfileDB).filter(ProfileDB.user_id == user_id).first()
        if p is None:
            p = ProfileDB(user_id=user_id)
            db.add(p)
        p.trial_started_at = datetime.utcnow() - timedelta(days=settings.TRIAL_DAYS + 5)
        db.commit()
    finally:
        db.close()


class TestWhatGetsLocked:
    def test_newest_stay_open_and_the_rest_lock(self, env, monkeypatch):
        client, Session = env
        monkeypatch.setattr(settings, "FREE_SAVE_LIMIT", 5)
        c = client(AuthUser(id="u-lock", email="l@b.co"))
        c.get("/api/account/usage")
        _expire_trial(Session, "u-lock")
        _seed(Session, "u-lock", 8)

        body = c.get("/api/reels?limit=50").json()
        locked = {i["id"]: i["locked"] for i in body["items"]}
        assert len(locked) == 8
        # r0 is newest. The newest 5 stay open; r5..r7 are the oldest three.
        assert [locked[f"u-lock-r{i}"] for i in range(8)] == [
            False, False, False, False, False, True, True, True,
        ]

    def test_under_the_cap_nothing_is_locked(self, env, monkeypatch):
        client, Session = env
        monkeypatch.setattr(settings, "FREE_SAVE_LIMIT", 5)
        c = client(AuthUser(id="u-under", email="un@b.co"))
        c.get("/api/account/usage")
        _expire_trial(Session, "u-under")
        _seed(Session, "u-under", 4)
        assert all(i["locked"] is False for i in c.get("/api/reels?limit=50").json()["items"])

    def test_exactly_at_the_cap_nothing_is_locked(self, env, monkeypatch):
        client, Session = env
        monkeypatch.setattr(settings, "FREE_SAVE_LIMIT", 5)
        c = client(AuthUser(id="u-exact", email="ex@b.co"))
        c.get("/api/account/usage")
        _expire_trial(Session, "u-exact")
        _seed(Session, "u-exact", 5)
        assert all(i["locked"] is False for i in c.get("/api/reels?limit=50").json()["items"])

    def test_pro_keeps_everything_open(self, env, monkeypatch):
        """The lock is a consequence of the cap, not a thing in its own right."""
        client, Session = env
        monkeypatch.setattr(settings, "PRO_SAVE_LIMIT", 500)
        pro = AuthUser(id="u-prolock", email="pl@b.co", claims={"app_metadata": {"tier": "pro"}})
        c = client(pro)
        _seed(Session, "u-prolock", 8)
        assert all(i["locked"] is False for i in c.get("/api/reels?limit=50").json()["items"])

    def test_a_trial_user_is_measured_against_the_trial_cap(self, env, monkeypatch):
        """A trial library over the FREE limit is warned, not locked — the lock
        follows the cap the user is actually on today."""
        client, Session = env
        monkeypatch.setattr(settings, "FREE_SAVE_LIMIT", 5)
        monkeypatch.setattr(settings, "TRIAL_SAVE_LIMIT", 100)
        c = client(AuthUser(id="u-trlock", email="tl@b.co"))
        _seed(Session, "u-trlock", 8)
        assert all(i["locked"] is False for i in c.get("/api/reels?limit=50").json()["items"])


class TestEnforcement:
    """⚠️ `locked` in the payload is a RENDERING HINT. A client that ignores it must
    still be refused, or the lock is a suggestion."""

    def _over_cap(self, env, monkeypatch, uid):
        client, Session = env
        monkeypatch.setattr(settings, "FREE_SAVE_LIMIT", 5)
        c = client(AuthUser(id=uid, email=f"{uid}@b.co"))
        c.get("/api/account/usage")
        _expire_trial(Session, uid)
        _seed(Session, uid, 8)
        return c, Session

    def test_reading_a_locked_save_is_refused(self, env, monkeypatch):
        c, _ = self._over_cap(env, monkeypatch, "u-read")
        r = c.get("/api/reels/u-read-r7")
        assert r.status_code == 403
        detail = r.json()["detail"]
        # Says what happened, that nothing is gone, and BOTH ways out. A lock with one
        # exit that costs money reads as a hostage note.
        assert "locked" in detail.lower()
        assert "nothing has been" in detail.lower() and "deleted" in detail.lower()
        assert "Delete some newer saves" in detail and "Pro" in detail

    def test_an_open_save_is_unaffected(self, env, monkeypatch):
        c, _ = self._over_cap(env, monkeypatch, "u-open")
        assert c.get("/api/reels/u-open-r0").status_code == 200

    def test_editing_a_locked_save_is_refused(self, env, monkeypatch):
        c, _ = self._over_cap(env, monkeypatch, "u-edit")
        assert c.patch("/api/reels/u-edit-r7/notes", json={"notes": "hi"}).status_code == 403
        assert c.patch("/api/reels/u-edit-r7/category", json={"category": "food"}).status_code == 403

    def test_DELETE_STILL_WORKS_on_a_locked_save(self, env, monkeypatch):
        """⚠️ THE MOST IMPORTANT TEST IN THIS FILE.

        Deleting is how a user gets back under the cap and unlocks the rest. If delete
        were refused on a locked save the lock would be a trap whose only exit is a
        purchase — which is the version of this feature that deserves a one-star
        review.
        """
        c, _ = self._over_cap(env, monkeypatch, "u-del")
        assert c.delete("/api/reels/u-del-r7").status_code == 200

    def test_deleting_newer_saves_unlocks_older_ones(self, env, monkeypatch):
        """The lock is reversible by an action the user can take, for free."""
        c, _ = self._over_cap(env, monkeypatch, "u-unlock")
        assert c.get("/api/reels/u-unlock-r7").status_code == 403
        # Remove three of the newest; the oldest three come back inside the newest 5.
        for i in range(3):
            assert c.delete(f"/api/reels/u-unlock-r{i}").status_code == 200
        assert c.get("/api/reels/u-unlock-r7").status_code == 200
        assert all(i["locked"] is False for i in c.get("/api/reels?limit=50").json()["items"])

    def test_raising_the_cap_unlocks_everything(self, env, monkeypatch):
        """Going Pro is the other exit, and it needs no migration or restore — the
        same rows simply stop being outside the newest N."""
        c, _ = self._over_cap(env, monkeypatch, "u-raise")
        assert c.get("/api/reels/u-raise-r7").status_code == 403
        monkeypatch.setattr(settings, "FREE_SAVE_LIMIT", 50)
        assert c.get("/api/reels/u-raise-r7").status_code == 200

    def test_a_locked_save_still_counts_toward_the_cap(self, env, monkeypatch):
        """Locking does not free space. A lock that silently created room would be a
        second, invisible cap that the save gate disagreed with."""
        c, _ = self._over_cap(env, monkeypatch, "u-count")
        r = c.post("/api/reels/save", json={"url": "https://youtube.com/shorts/blocked99"})
        assert r.status_code == 403
        assert "8 saves" in r.json()["detail"] and "allows 5" in r.json()["detail"]


class TestAsk:
    def test_ask_cannot_answer_out_of_locked_saves(self, env, monkeypatch):
        """⚠️ Otherwise the lock hands its own content back as prose — and charges an
        AI action to do it.

        No `if` in this test. An earlier version had a fallback branch in case the
        endpoint shape had moved, which meant it could pass without ever reaching the
        route — the exact "harness validates your mistake" failure this repo has
        already paid for once (see the Share Extension notes in TODO.md).
        """
        client, Session = env
        # The trial keeps Ask; post-trial free loses it entirely, so the corpus filter
        # is only observable while the user can still ask at all.
        monkeypatch.setattr(settings, "TRIAL_SAVE_LIMIT", 5)
        seen: dict = {}

        from app.services import librarian

        def _fake_ask_library(question, reels):
            seen["ids"] = [r["id"] for r in reels]
            return {"answer": "ok", "reel_ids": []}

        monkeypatch.setattr(librarian, "ask_library", _fake_ask_library)

        c = client(AuthUser(id="u-ask", email="ask@b.co"))
        _seed(Session, "u-ask", 8)
        r = c.post("/api/ask", json={"question": "what did I save about coffee?"})
        assert r.status_code == 200, r.text
        assert "ids" in seen, "ask_library was never called — the test proved nothing"
        assert seen["ids"] == [f"u-ask-r{i}" for i in range(5)], (
            "the corpus must be exactly the newest 5; locked saves must not reach it"
        )
