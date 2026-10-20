"""Alembic environment — wired to the app's own settings + models.

The database URL comes from `settings.DATABASE_URL` (the SAME source the app
uses), NOT from a hardcoded `sqlalchemy.url` in alembic.ini, so migrations always
target whatever the app targets: SQLite locally, Supabase Postgres in prod.

`render_as_batch=True` is required for SQLite, whose ALTER TABLE can't drop/alter
columns in place — batch mode rebuilds the table. Harmless on Postgres.
"""
import sys
import logging
from logging.config import fileConfig

from sqlalchemy import engine_from_config, pool

from alembic import context

# Make `app` importable when Alembic runs from the backend/ directory.
sys.path.insert(0, ".")

from app.config import settings          # noqa: E402
from app.database import Base            # noqa: E402
import app.database                      # noqa: E402,F401  (ensure all models are imported/registered)

config = context.config

# Feed the app's real DB URL into Alembic (overrides any alembic.ini value).
config.set_main_option("sqlalchemy.url", settings.DATABASE_URL)

# ⚠️ ONLY let alembic.ini own logging when Alembic IS the whole process.
# `fileConfig` defaults to disable_existing_loggers=True and sets the root logger
# to WARNING, so when the APP runs migrations at startup (main.py's startup hook)
# this call DISABLES every logger already created - uvicorn, uvicorn.access and
# every app module imported before it - and the backend goes silent for the rest
# of its life. Measured 2026-10-09: Render's log stream stopped at the last
# alembic line and never printed another word, so a webhook that provably ran
# `logger.warning` logged NOTHING. Billing was running blind.
# main.py installs a root handler at import time, so the presence of one is the
# signal that we are inside the app rather than the standalone `alembic` CLI.
if config.config_file_name is not None and not logging.getLogger().handlers:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata

_is_sqlite = settings.DATABASE_URL.startswith("sqlite")


def run_migrations_offline() -> None:
    context.configure(
        url=settings.DATABASE_URL,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=_is_sqlite,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=_is_sqlite,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
