"""The backend must still be able to log after it runs migrations at startup.

Regression guard for 2026-10-09: `alembic/env.py` called
`fileConfig(alembic.ini)`, which defaults to `disable_existing_loggers=True` and
sets the root logger to WARNING. Migrations run inside the app's startup hook, so
that call DISABLED every logger already created and dropped the root level — and
the backend went silent for the rest of the process. On Render the log stream
stopped at the last alembic line and never printed another request; a billing
webhook that provably reached `logger.warning` logged nothing at all.

Nothing errors when this breaks. That is why it needs a test.
"""
import logging

from fastapi.testclient import TestClient

from app.main import app


def test_loggers_still_work_after_startup_migrations():
    root = logging.getLogger()
    before = root.level
    # pytest's own logging plugin pins the root level to WARNING, which would mask
    # the half of this bug that lowers it. Set what main.py sets and check it holds.
    root.setLevel(logging.INFO)
    try:
        with TestClient(app) as client:
            client.get("/health")

            assert root.level == logging.INFO, (
                "startup reset the ROOT log level to "
                f"{logging.getLevelName(root.level)} - every INFO line is dropped"
            )
            # billing is the one that matters most: a tier grant we cannot see is a
            # payment we cannot audit.
            for name in ("app.routes.billing", "app.quota", "uvicorn.access"):
                logger = logging.getLogger(name)
                assert not logger.disabled, f"{name} was disabled during startup"
                assert logger.getEffectiveLevel() <= logging.INFO, (
                    f"{name} effective level is "
                    f"{logging.getLevelName(logger.getEffectiveLevel())}, so INFO is dropped"
                )
    finally:
        root.setLevel(before)
