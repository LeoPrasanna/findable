from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
import logging
import uuid
from datetime import datetime

from app.database import get_db, ReelDB, WorkoutExerciseDB, TaskDB
from app import library_lock
from app.routes.models.workout import (
    WorkoutPlanResponse, WorkoutExerciseResponse,
    UpdateExerciseRequest, TaskResponse, TaskListResponse,
    ToggleTaskRequest, UpdateTaskRequest, CreateTaskRequest,
)
from app.services import workout_extractor, extractor
from app.ratelimit import rate_limit
from app.quota import charge_ai_action
from app.auth import get_current_user, AuthUser
from app.entitlements import entitlements_for, PRO_FEATURE_DETAIL
# Shared with the save path: detects generic placeholder titles ("Instagram Reel")
# that look like content but can't seed any AI extraction.
from app.routes.reels import _weak_title

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["workout"])

# Per-reel caps on AI generations (each call costs Claude tokens). Tasks/steps are
# AI-generated ONCE; after that the user edits them by hand (add/edit/delete) — no
# regeneration. Workouts keep a small allowance; itineraries match workouts.
TASKS_LIMIT = 1
WORKOUT_LIMIT = 3
ITINERARY_LIMIT = 3

# One message everywhere a sensitive reel is refused an action plan. Enforced
# server-side (the client hides the buttons, but that's cosmetic).
SENSITIVE_DETAIL = (
    "This save looks like medical or other sensitive advice, so Findable won't "
    "turn it into an action plan. The summary is for reference only — please "
    "consult a qualified professional."
)


def _reject_if_sensitive(reel: ReelDB) -> None:
    if bool(reel.is_sensitive):
        raise HTTPException(status_code=422, detail=SENSITIVE_DETAIL)


# ── Helpers ──────────────────────────────────────────────────────────────────

def _get_reel_or_404(reel_id: str, user: AuthUser, db: Session) -> ReelDB:
    reel = db.query(ReelDB).filter(ReelDB.id == reel_id, ReelDB.user_id == user.id).first()
    if not reel:
        raise HTTPException(status_code=404, detail="Reel not found")
    # ⚠️ A LOCKED SAVE IS READ-ONLY, AND AN AI ACTION IS NOT A READ. Everything in
    # this module either generates from the reel or charges the AI budget, so there is
    # no caller here that should be allowed through — unlike reels.py, where DELETE
    # has to be. Mirrors _get_owned_reel_or_404 there; see app/library_lock.py.
    if library_lock.is_locked(reel, library_lock.cutoff_for(user, db)):
        ent = entitlements_for(user, db)
        raise HTTPException(
            status_code=403,
            detail=(
                f"This save is locked. Your library holds more than the {ent.save_limit} "
                f"your plan keeps open, so the oldest are read-only — nothing has been "
                f"deleted. Delete some newer saves to unlock it, or go Pro."
            ),
        )
    return reel


def _get_owned_task_or_404(task_id: str, user: AuthUser, db: Session) -> TaskDB:
    """A task is owned via its parent reel — join so we never trust the task id alone."""
    task = (
        db.query(TaskDB)
        .join(ReelDB, TaskDB.reel_id == ReelDB.id)
        .filter(TaskDB.id == task_id, ReelDB.user_id == user.id)
        .first()
    )
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


def _get_owned_exercise_or_404(exercise_id: str, user: AuthUser, db: Session) -> WorkoutExerciseDB:
    ex = (
        db.query(WorkoutExerciseDB)
        .join(ReelDB, WorkoutExerciseDB.reel_id == ReelDB.id)
        .filter(WorkoutExerciseDB.id == exercise_id, ReelDB.user_id == user.id)
        .first()
    )
    if not ex:
        raise HTTPException(status_code=404, detail="Exercise not found")
    return ex


def _exercise_to_response(e: WorkoutExerciseDB) -> WorkoutExerciseResponse:
    return WorkoutExerciseResponse(
        id=e.id,
        name=e.name,
        type=e.type,
        muscle_group=e.muscle_group,
        sets=e.sets,
        reps=e.reps,
        duration_seconds=e.duration_seconds,
        rest_seconds=e.rest_seconds,
        is_estimated=e.is_estimated,
        sort_order=e.sort_order,
    )


def _task_to_response(t: TaskDB) -> TaskResponse:
    return TaskResponse(
        id=t.id,
        reel_id=t.reel_id,
        text=t.text,
        emoji=t.emoji,
        estimated_minutes=t.estimated_minutes,
        completed=t.completed,
        sort_order=t.sort_order,
    )


def _usable_source(reel: ReelDB) -> str:
    """The reel's real body text, or "" if there is nothing an AI could work from.

    ⚠️ THIS IS THE NO-SUMMARY-BUT-STILL-CHARGED FIX (owner report, 2026-08-12).

    Every generator here already had a preflight, but all three asked only
    "is `raw_text` non-empty?". That is the wrong question, and it is the same
    wrong question `_reel_from_info` learned not to ask on the save path: a
    caption that is entirely "📌 Follow us here:" plus three URLs is ~150
    characters of nothing. It sails past a non-empty check, so the route
    charged an AI action, called Claude, and came back with no recipe / no
    steps / no itinerary — a 422 the user paid for.

    That is exactly why those reels have no summary in the first place: the save
    path ran `extractor.is_link_only()` and marked them `skipped` without
    spending anything. Asking the same question here is what makes "no summary"
    and "no AI action charged" agree with each other, instead of the screen
    showing an empty summary while the quota meter ticked down.

    Notes are checked SEPARATELY and never link-filtered: a note is something
    the user typed on purpose, and the whole documented recovery path for an
    unreadable save is "paste the post text into Notes".
    """
    body = (reel.raw_text or "").strip()
    if body and not extractor.is_link_only(body):
        return body
    return (reel.notes or "").strip()


NO_CONTENT_DETAIL = (
    "There's nothing readable in this save to work from — its caption is just "
    "links or couldn't be read at all, which is why it has no summary either. "
    "Paste the post text into Notes and try again. No AI action was used."
)


def _source_note(source: str) -> str | None:
    """User-facing disclaimer when steps weren't read from the actual video."""
    if source == "title":
        # Owner wording, 2026-08-12. "…not the actual recipe" alone read as if
        # the recipe existed somewhere and we had picked the wrong one; naming
        # the SOURCE we failed to read says what actually happened.
        return ("Couldn't read this video — these are general steps based on the title, "
                "not the actual recipe from the short/reel.")
    if source == "notes":
        return "Based on the note you added, not the video itself."
    return None


def _build_plan_response(reel_id: str, exercises: list[WorkoutExerciseDB]) -> WorkoutPlanResponse:
    first = exercises[0] if exercises else None
    return WorkoutPlanResponse(
        reel_id=reel_id,
        workout_name=first.workout_name if first else "Custom Workout",
        difficulty=first.difficulty if first else "intermediate",
        estimated_minutes=first.estimated_minutes if first else 20,
        exercises=[_exercise_to_response(e) for e in exercises],
    )


# ── Workout routes ────────────────────────────────────────────────────────────

@router.post("/reels/{reel_id}/workout", response_model=WorkoutPlanResponse, dependencies=[Depends(rate_limit(10, 60, "workout"))])
def generate_workout(reel_id: str, user: AuthUser = Depends(get_current_user), db: Session = Depends(get_db)):
    reel = _get_reel_or_404(reel_id, user, db)
    _reject_if_sensitive(reel)

    # Pro-only after trial (revised 2026-07-28): all derived AI actions are gated
    # for the free tier. Fires before the cap/charge so a refused call shows the
    # upsell and costs no AI action.
    if not entitlements_for(user, db).can_workout:
        raise HTTPException(status_code=403, detail=PRO_FEATURE_DETAIL.format(feature="Build Workout"))

    if (reel.workout_count or 0) >= WORKOUT_LIMIT:
        raise HTTPException(
            status_code=429,
            detail=f"You've built a workout for this reel {WORKOUT_LIMIT} times — that's the limit for now (each one uses AI).",
        )

    # Preflight before the charge — see _usable_source. A link-only caption or a
    # generic placeholder title ("Instagram Reel") can only produce a guaranteed
    # 422, so don't spend an AI action discovering that.
    source = _usable_source(reel)
    if not source and _weak_title(reel.title):
        raise HTTPException(status_code=422, detail=NO_CONTENT_DETAIL)
    source = source or (reel.title or "")

    # Per-user daily AI budget (shared across all AI actions). Charged after the
    # free checks, before the Claude call.
    charge_ai_action(db, user, action="workout", label=reel.title or reel.url)

    result = workout_extractor.extract_workout(
        platform=reel.platform,
        title=reel.title or "",
        text=source,
    )

    exercises = result.get("exercises") or []
    if not exercises:
        raise HTTPException(
            status_code=422,
            detail="No workout exercises found in this content. Try a reel that demonstrates specific exercises."
        )

    # Replace the existing plan only now that extraction succeeded — a failed
    # regeneration must never destroy a workout the user already had.
    db.query(WorkoutExerciseDB).filter(WorkoutExerciseDB.reel_id == reel_id).delete()

    workout_name = result.get("workout_name", "Custom Workout")
    difficulty = result.get("difficulty", "intermediate")
    estimated_minutes = result.get("estimated_minutes", 20)

    # Deduplicate by name (case-insensitive), keep first occurrence
    seen_names: set[str] = set()
    unique_exercises = []
    for ex in exercises:
        key = ex.get("name", "").strip().lower()
        if key and key not in seen_names:
            seen_names.add(key)
            unique_exercises.append(ex)
    exercises = unique_exercises

    db_exercises = []
    for i, ex in enumerate(exercises):
        db_ex = WorkoutExerciseDB(
            id=str(uuid.uuid4()),
            reel_id=reel_id,
            name=ex.get("name", "Exercise"),
            type=ex.get("type", "strength"),
            muscle_group=ex.get("muscle_group", "full_body"),
            sets=ex.get("sets"),
            reps=ex.get("reps"),
            duration_seconds=ex.get("duration_seconds"),
            rest_seconds=ex.get("rest_seconds", 60),
            is_estimated=ex.get("is_estimated", False),
            sort_order=i,
            workout_name=workout_name,
            difficulty=difficulty,
            estimated_minutes=estimated_minutes,
        )
        db.add(db_ex)
        db_exercises.append(db_ex)

    reel.workout_count = (reel.workout_count or 0) + 1
    db.commit()
    return _build_plan_response(reel_id, db_exercises)


@router.get("/reels/{reel_id}/workout", response_model=WorkoutPlanResponse)
def get_workout(reel_id: str, user: AuthUser = Depends(get_current_user), db: Session = Depends(get_db)):
    _get_reel_or_404(reel_id, user, db)
    exercises = (
        db.query(WorkoutExerciseDB)
        .filter(WorkoutExerciseDB.reel_id == reel_id)
        .order_by(WorkoutExerciseDB.sort_order)
        .all()
    )
    return _build_plan_response(reel_id, exercises)


@router.patch("/exercises/{exercise_id}", response_model=WorkoutExerciseResponse)
def update_exercise(exercise_id: str, body: UpdateExerciseRequest,
                    user: AuthUser = Depends(get_current_user), db: Session = Depends(get_db)):
    ex = _get_owned_exercise_or_404(exercise_id, user, db)
    if body.sets is not None:
        ex.sets = max(1, body.sets)
    if body.reps is not None:
        ex.reps = max(1, body.reps)
    if body.duration_seconds is not None:
        ex.duration_seconds = max(5, body.duration_seconds)
    if body.rest_seconds is not None:
        ex.rest_seconds = max(0, body.rest_seconds)
    db.commit()
    db.refresh(ex)
    return _exercise_to_response(ex)


# ── Itinerary routes (travel reels, Pro feature) ──────────────────────────────

def _itinerary_payload(reel: ReelDB) -> dict:
    return {
        "reel_id": reel.id,
        "itinerary": reel.itinerary,
        "regenerations_left": max(0, ITINERARY_LIMIT - (reel.itinerary_count or 0)),
    }


@router.post("/reels/{reel_id}/itinerary", dependencies=[Depends(rate_limit(10, 60, "itinerary"))])
def generate_itinerary(reel_id: str, user: AuthUser = Depends(get_current_user), db: Session = Depends(get_db)):
    """Build a trip itinerary from a travel reel (Pro feature, decided 2026-07-20).

    Gate order matters: ownership → sensitive → category → Pro gate → cap →
    content check → quota charge → Claude. A refused call never costs an AI
    action, and a failed regeneration never destroys an existing itinerary."""
    reel = _get_reel_or_404(reel_id, user, db)
    _reject_if_sensitive(reel)

    if (reel.category or "").lower() != "travel":
        raise HTTPException(
            status_code=422,
            detail="Itineraries are only available for travel saves. If this is a trip, recategorize it to Travel first.",
        )

    if not entitlements_for(user, db).can_itinerary:
        raise HTTPException(
            status_code=403,
            detail=PRO_FEATURE_DETAIL.format(feature="Trip Itinerary"),
        )

    if (reel.itinerary_count or 0) >= ITINERARY_LIMIT:
        raise HTTPException(
            status_code=429,
            detail=f"You've built an itinerary for this reel {ITINERARY_LIMIT} times — that's the limit for now (each one uses AI).",
        )

    # Preflight before the charge — see _usable_source.
    source = _usable_source(reel)
    if not source and _weak_title(reel.title):
        raise HTTPException(status_code=422, detail=NO_CONTENT_DETAIL)
    source = source or (reel.title or "")

    # Per-user daily AI budget (shared across all AI actions). Charged after the
    # free checks, before the Claude call.
    charge_ai_action(db, user, action="itinerary", label=reel.title or reel.url)

    try:
        result = workout_extractor.extract_itinerary(
            platform=reel.platform,
            title=reel.title or "",
            text=source,
            notes=reel.notes or "",
        )
    except Exception as e:
        # extract_itinerary now raises on a truncated response rather than
        # quietly returning an empty plan. The user has already been charged, so
        # they get a retryable sentence — not a stack trace, and not the old
        # "couldn't find trip details" message which blamed their reel for our
        # token cap. The existing itinerary (if any) is left untouched.
        logger.error(f"[ITINERARY] {reel.id} failed: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=503,
            detail="The trip planner is having trouble right now. Please try again in a moment.",
        )

    if not result.get("days"):
        raise HTTPException(
            status_code=422,
            detail="Couldn't work out where this trip goes — add the destination to Notes and try again.",
        )

    # Replace only on success — a failed regeneration must never destroy an
    # itinerary the user already had (same rule as workouts/tasks).
    reel.itinerary = result
    reel.itinerary_count = (reel.itinerary_count or 0) + 1
    db.commit()
    db.refresh(reel)
    return _itinerary_payload(reel)


@router.get("/reels/{reel_id}/itinerary")
def get_itinerary(reel_id: str, user: AuthUser = Depends(get_current_user), db: Session = Depends(get_db)):
    """The stored itinerary (null if never generated). Read-only, never charges."""
    reel = _get_reel_or_404(reel_id, user, db)
    return _itinerary_payload(reel)


# ── Task routes ───────────────────────────────────────────────────────────────

@router.post("/reels/{reel_id}/tasks", response_model=TaskListResponse, dependencies=[Depends(rate_limit(15, 60, "tasks"))])
def generate_tasks(reel_id: str, user: AuthUser = Depends(get_current_user), db: Session = Depends(get_db)):
    reel = _get_reel_or_404(reel_id, user, db)
    _reject_if_sensitive(reel)

    # Feature gate (revised 2026-07-28): BOTH the recipe (cooking) and the generic
    # "Turn into Action" (other categories) are Pro-only for the free tier now —
    # gating on tier, not the user-editable category, also closes the old
    # recategorize-to-cooking-to-unlock hole. Fires before the cap check and the
    # quota charge so a refused call costs nothing and shows the upsell.
    is_cooking = (reel.category or "").lower() == "cooking"
    ent = entitlements_for(user, db)
    if is_cooking and not ent.can_recipe:
        raise HTTPException(
            status_code=403,
            detail=PRO_FEATURE_DETAIL.format(feature="Get Recipe"),
        )
    if not is_cooking and not ent.can_tasks:
        raise HTTPException(
            status_code=403,
            detail=PRO_FEATURE_DETAIL.format(feature="Turn into Action"),
        )

    if (reel.tasks_count or 0) >= TASKS_LIMIT:
        raise HTTPException(
            status_code=429,
            detail="These were already generated with AI. You can add, edit, or delete them by hand — regenerating isn't available (it would use AI again).",
        )

    # Preflight: refuse input that CANNOT produce output, before charging. Once
    # Claude runs the tokens are really spent, so charging first is correct — the
    # fix is to not run it at all for hopeless input. Without this, an unreadable
    # save cost the user an AI action to receive a guaranteed 422.
    body_text = _usable_source(reel)
    if is_cooking:
        # Cooking is the looser case on purpose: extract_tasks can infer a recipe
        # from the title alone (_infer_recipe). But a generic placeholder title
        # ("Instagram Reel") infers nothing and comes back needs_input.
        if not body_text and _weak_title(reel.title):
            raise HTTPException(
                status_code=422,
                detail="I couldn't tell what dish this is from the title. Add a note in Notes describing what you'd like (e.g. \"homemade pasta, desi style\"), then tap Get Recipe again.",
            )
    elif not body_text:
        # Every other category needs real content — inventing steps from a bare
        # headline is exactly the ungrounded output the quality bar forbids.
        raise HTTPException(status_code=422, detail=NO_CONTENT_DETAIL)

    # Per-user daily AI budget (shared across all AI actions). Charged before the call.
    charge_ai_action(db, user, action="recipe" if is_cooking else "tasks",
                     label=reel.title or reel.url)

    result = workout_extractor.extract_tasks(
        platform=reel.platform,
        title=reel.title or "",
        text=reel.raw_text or "",
        category=reel.category or "general",
        notes=reel.notes or "",
    )

    # Cooking with an unreadable video and a too-vague title: ask for a note.
    if result.get("needs_input"):
        raise HTTPException(
            status_code=422,
            detail="I couldn't tell what dish this is from the title. Add a note in Notes describing what you'd like (e.g. \"homemade pasta, desi style\"), then tap Get Recipe again.",
        )

    tasks = result.get("tasks") or []
    if not tasks:
        raise HTTPException(
            status_code=422,
            detail="Could not extract actionable tasks from this content."
        )

    list_kind = "steps" if result.get("kind") == "steps" else "tasks"
    row_kind = "step" if list_kind == "steps" else "task"
    src = result.get("source", "content")

    # Replace existing only now that we have a successful result (don't destroy
    # good tasks on a failed regeneration).
    db.query(TaskDB).filter(TaskDB.reel_id == reel_id).delete()
    db.commit()

    db_tasks = []
    for i, t in enumerate(tasks):
        db_task = TaskDB(
            id=str(uuid.uuid4()),
            reel_id=reel_id,
            text=t.get("text", ""),
            emoji=t.get("emoji", "✅"),
            estimated_minutes=t.get("estimated_minutes"),
            completed=False,
            sort_order=i,
            kind=row_kind,
            source=src,
            created_at=datetime.utcnow(),
        )
        db.add(db_task)
        db_tasks.append(db_task)

    reel.tasks_count = (reel.tasks_count or 0) + 1
    db.commit()
    return TaskListResponse(
        reel_id=reel_id,
        total=len(db_tasks),
        completed=0,
        kind=list_kind,
        source=src,
        note=_source_note(src),
        tasks=[_task_to_response(t) for t in db_tasks],
    )


@router.get("/reels/{reel_id}/tasks", response_model=TaskListResponse)
def get_tasks(reel_id: str, user: AuthUser = Depends(get_current_user), db: Session = Depends(get_db)):
    _get_reel_or_404(reel_id, user, db)
    tasks = (
        db.query(TaskDB)
        .filter(TaskDB.reel_id == reel_id)
        .order_by(TaskDB.sort_order)
        .all()
    )
    completed = sum(1 for t in tasks if t.completed)
    list_kind = "steps" if tasks and tasks[0].kind == "step" else "tasks"
    src = tasks[0].source if tasks else "content"
    return TaskListResponse(
        reel_id=reel_id,
        total=len(tasks),
        completed=completed,
        kind=list_kind,
        source=src,
        note=_source_note(src),
        tasks=[_task_to_response(t) for t in tasks],
    )


@router.post("/reels/{reel_id}/tasks/manual", response_model=TaskResponse)
def add_task(reel_id: str, body: CreateTaskRequest,
             user: AuthUser = Depends(get_current_user), db: Session = Depends(get_db)):
    """Add a single task/step by hand. No AI, no limit."""
    _get_reel_or_404(reel_id, user, db)
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=422, detail="Task text can't be empty.")

    existing = (
        db.query(TaskDB)
        .filter(TaskDB.reel_id == reel_id)
        .order_by(TaskDB.sort_order)
        .all()
    )
    # New manual item inherits the list's kind so a "steps" list stays numbered.
    kind = existing[0].kind if existing else "task"
    next_order = (max(t.sort_order for t in existing) + 1) if existing else 0

    task = TaskDB(
        id=str(uuid.uuid4()),
        reel_id=reel_id,
        text=text,
        emoji=body.emoji or "✅",
        estimated_minutes=body.estimated_minutes,
        completed=False,
        sort_order=next_order,
        kind=kind,
        source="manual",
        created_at=datetime.utcnow(),
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return _task_to_response(task)


@router.patch("/tasks/{task_id}", response_model=TaskResponse)
def update_task(task_id: str, body: UpdateTaskRequest,
                user: AuthUser = Depends(get_current_user), db: Session = Depends(get_db)):
    """Toggle completion and/or edit a task by hand. No AI."""
    task = _get_owned_task_or_404(task_id, user, db)
    if body.completed is not None:
        task.completed = body.completed
    if body.text is not None:
        text = body.text.strip()
        if not text:
            raise HTTPException(status_code=422, detail="Task text can't be empty.")
        task.text = text
    if body.estimated_minutes is not None:
        task.estimated_minutes = max(0, body.estimated_minutes)
    db.commit()
    db.refresh(task)
    return _task_to_response(task)


@router.delete("/tasks/{task_id}")
def delete_task(task_id: str, user: AuthUser = Depends(get_current_user), db: Session = Depends(get_db)):
    """Delete a single task/step by hand. No AI."""
    task = _get_owned_task_or_404(task_id, user, db)
    db.delete(task)
    db.commit()
    return {"message": "Deleted"}
