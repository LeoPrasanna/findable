from pydantic import BaseModel, Field
from datetime import datetime
from typing import Optional


class ReelSaveRequest(BaseModel):
    url: str


class ClientMetadataRequest(BaseModel):
    """Metadata the CLIENT fetched from the user's own (residential) IP.

    Instagram/Facebook serve the public og:/oEmbed surface to normal user IPs but
    block our server's datacenter IP, so the app fetches it and posts it here.

    This is UNTRUSTED input and is treated as such: the caps below are enforced by
    pydantic (oversize -> 422 before any handler runs), the server re-normalizes
    `url` and requires it to match the reel, and the route only applies this data
    when the server's OWN extraction came back unusable — server data always wins.
    That bounds a lying client to saves the server couldn't read anyway.
    """
    url: str = Field(max_length=2048)
    title: Optional[str] = Field(default=None, max_length=300)
    # Caption / description. 20k is generous for a post body but bounds the payload
    # (and the summarizer truncates well below this anyway).
    text: Optional[str] = Field(default=None, max_length=20000)
    thumbnail_url: Optional[str] = Field(default=None, max_length=2048)
    uploader: Optional[str] = Field(default=None, max_length=200)


class ReelNotesRequest(BaseModel):
    notes: str


class ReelCategoryRequest(BaseModel):
    category: str


class ReelResponse(BaseModel):
    id: str
    url: str
    platform: str
    title: Optional[str]
    thumbnail_url: Optional[str]
    uploader: Optional[str]
    duration: Optional[int]
    summary: list[str]
    tags: list[str]
    category: Optional[str]
    # pending | ready | skipped | failed — drives the "Summarizing…" UI state.
    summary_status: str = "ready"
    notes: Optional[str]
    summarize_count: int
    tasks_count: int = 0
    workout_count: int = 0
    # True when the summarizer flagged the content as medical/high-stakes advice —
    # the app shows a disclaimer and hides the tasks/workout actions.
    is_sensitive: bool = False
    # ⚠️ A RENDERING HINT, NOT THE ENFORCEMENT. True when this save sits outside the
    # newest `save_limit` because the library is over its tier's cap: still visible,
    # still deletable, not readable. The 403 from the routes is what actually stops a
    # read — a client that ignored this flag must still be refused. See
    # app/library_lock.py, and note that NOTHING IS EVER DELETED.
    locked: bool = False
    created_at: datetime

    class Config:
        from_attributes = True


class ReelListResponse(BaseModel):
    total: int
    items: list[ReelResponse]
