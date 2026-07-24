"""A reel that HAS summary text must never be left in a non-'ready' state.

The bug this pins: recover_pending_summaries re-runs the whole extract chain on
startup (Render's free tier kills in-flight background tasks on every spin-down).
When that second extraction came back empty — blocked IP, deleted post — the fill
overwrote the status of an ALREADY-SUMMARIZED reel with 'skipped', leaving real,
already-paid-for summary text invisible in the app. Two saves in the dev database
were found in exactly that state.
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, ReelDB
from app.routes import reels as reels_module

USER = "user-summary-state"
EMPTY_EXTRACTION = {
    "platform": "youtube", "title": "", "caption": "", "transcript": "",
    "best_text": "", "thumbnail_url": "", "uploader": "", "duration": 0,
    "needs_audio": False, "extracted": False,
}


@pytest.fixture
def session(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    TestingSession = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    Base.metadata.create_all(bind=engine)
    monkeypatch.setattr(reels_module, "SessionLocal", TestingSession)
    yield TestingSession


def _reel(Session, **kw):
    s = Session()
    kw.setdefault("summary", [])
    reel = ReelDB(user_id=USER, url="https://youtube.com/shorts/bmDPYEan7Uc",
                  platform="youtube", tags=[], **kw)
    s.add(reel); s.commit(); rid = reel.id; s.close()
    return rid


def test_reextraction_never_clobbers_an_existing_summary(session, monkeypatch):
    """The core guard: a summarized reel is left alone even when the retry
    extraction returns nothing."""
    rid = _reel(session, title="Cost of 1 Week London Trip",
                summary=["Break down the trip cost", "Use travel passes"],
                summary_status="ready", raw_text="the original description")
    monkeypatch.setattr(reels_module.extractor, "extract_info", lambda url: dict(EMPTY_EXTRACTION))

    reels_module._extract_and_summarize(rid, None)

    s = session()
    reel = s.query(ReelDB).filter(ReelDB.id == rid).first()
    assert reel.summary_status == "ready", "a summarized reel was downgraded by a failed re-extraction"
    assert len(reel.summary) == 2
    assert reel.raw_text == "the original description"
    s.close()


def test_startup_heals_a_summary_stuck_behind_skipped(session):
    """Repairs the rows already in the database — status must follow content."""
    rid = _reel(session, title="Chest workout at home",
                summary=["Push-ups, 3 sets", "Rest 60s"],
                summary_status="skipped", raw_text="")

    reels_module.recover_pending_summaries()

    s = session()
    reel = s.query(ReelDB).filter(ReelDB.id == rid).first()
    assert reel.summary_status == "ready", "a reel with real summary text stayed invisible"
    s.close()


class TestCachePoisoning:
    """A failed extraction must never be cached as a success.

    `extracted` is True as soon as a title or thumbnail comes back — which is
    exactly what a bot-blocked datacenter IP returns for YouTube. Caching on that
    alone stored text-less rows, and since the save path reads the cache BEFORE
    extracting, every later save of that URL reused the empty result for the full
    14-day TTL. Retrying could never recover: three different YouTube URLs failed
    this way in the dev database, 11 of 37 cache rows were poisoned.
    """

    def test_textless_extraction_is_not_cacheable(self):
        blocked = {"extracted": True, "title": "Bali Tour Package 2025",
                   "thumbnail_url": "https://i.ytimg.com/x.jpg", "best_text": "", "needs_audio": False}
        assert reels_module._is_cacheable(blocked) is False, \
            "a title-only result would be cached and poison the URL for 14 days"

    def test_real_text_is_cacheable(self):
        good = {"extracted": True, "best_text": "6 nights and 7 days in Bali from 40,000 rupees per person with flights.",
                "needs_audio": False}
        assert reels_module._is_cacheable(good) is True

    def test_needs_audio_still_cacheable(self):
        """That path is a real extraction the audio fallback can still finish."""
        audio = {"extracted": True, "best_text": "", "needs_audio": True}
        assert reels_module._is_cacheable(audio) is True

    def test_existing_poisoned_row_reads_as_a_miss(self, session):
        """Self-heals rows already in the database — no migration needed."""
        from app.database import ExtractionCacheDB
        from datetime import datetime
        url = "https://youtube.com/shorts/cT5S4En6XDg"
        s = session()
        s.add(ExtractionCacheDB(url=url, platform="youtube", title="Bali Tour Package 2025",
                                caption="", transcript="", best_text="", thumbnail_url="t.jpg",
                                duration=10, needs_audio=False, created_at=datetime.utcnow()))
        s.commit()
        assert reels_module._get_cached_extraction(s, url) is None, \
            "poisoned cache row was served as a hit, so the URL can never recover"
        s.close()


def test_healing_leaves_genuinely_empty_saves_alone(session):
    """Guard against over-healing: no summary means 'skipped' is the honest state."""
    rid = _reel(session, title="Jump Smash in 5 steps",
                summary=[], summary_status="skipped", raw_text="")

    reels_module.recover_pending_summaries()

    s = session()
    reel = s.query(ReelDB).filter(ReelDB.id == rid).first()
    assert reel.summary_status == "skipped"
    s.close()
