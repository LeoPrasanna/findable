import { Platform } from 'react-native';
import { getAccessToken } from './supabase';
import type { ClientMetadata } from './clientExtract';

// Local dev defaults to localhost; override for cloud dev (e.g. a Codespace's
// forwarded backend URL) by setting EXPO_PUBLIC_API_URL before `expo start`.
const BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:8000';

/**
 * Instagram/Facebook/LinkedIn CDN images block browser hotlinking (CORS), so on
 * web we route them through the backend proxy. Native loads them directly.
 */
export function thumbUrl(url?: string | null): string | undefined {
  if (!url) return undefined;
  if (Platform.OS === 'web' && /fbcdn\.net|cdninstagram\.com|licdn\.com/.test(url)) {
    return `${BASE_URL}/api/thumbnail?url=${encodeURIComponent(url)}`;
  }
  return url;
}

/**
 * The un-letterboxed YouTube thumbnail, when one exists.
 *
 * ⚠️ `hqdefault.jpg` / `hq2.jpg` are ALWAYS 480×360 (4:3). For a Short — i.e.
 * most of what this app saves — the vertical frame is pillarboxed into that 4:3
 * box with BLACK BARS BAKED INTO THE JPEG. No amount of `resizeMode` or cropping
 * removes them cleanly; they are pixels in the file, and cropping hard enough to
 * clear them throws away a third of the actual picture.
 *
 * `oardefault.jpg` ("original aspect ratio") serves the real 1080×1920 frame with
 * no bars. Measured on a saved Short: hqdefault → 480×360, oardefault → 1080×1920.
 *
 * It does NOT exist for every video (regular 16:9 uploads have no separate OAR
 * asset), so this is a CANDIDATE — callers must fall back to the stored URL on
 * error. See ReelCard, which walks the candidate list on `onError`.
 */
export function thumbCandidates(url?: string | null): string[] {
  const primary = thumbUrl(url);
  if (!primary) return [];
  const m = /^(https?:\/\/i\.ytimg\.com\/vi\/[^/]+)\/[^/?#]+$/.exec(primary);
  return m ? [`${m[1]}/oardefault.jpg`, primary] : [primary];
}

export interface Reel {
  id: string;
  /**
   * This save sits outside the newest `save_limit`, because the library is over its
   * tier's cap. Read-only: still listed, still deletable, not openable.
   *
   * ⚠️ A RENDERING HINT, NOT THE RULE. The server refuses a locked read with a 403
   * regardless of what this says — see backend/app/library_lock.py. Treating it as
   * the enforcement is how a client-side "lock" becomes a suggestion.
   *
   * ⚠️ NOTHING IS EVER DELETED. Owner decision 2026-10-06, choosing lock over
   * deleting the excess at the end of a trial. Copy must never imply otherwise.
   */
  locked?: boolean;
  url: string;
  platform: string;
  title: string | null;
  thumbnail_url: string | null;
  uploader: string | null;
  duration: number | null;
  summary: string[];
  tags: string[];
  category: string | null;
  // pending = summary generating in background; ready = done; skipped = nothing
  // readable; failed = errored (retryable). Drives the "Summarizing…" UI.
  /** `quota_exceeded` = the card saved fine, but the day's AI allowance was
   *  already spent so no summary was attempted. Distinct from `failed` on
   *  purpose: `failed` is retryable now, this one only after the daily reset,
   *  so the UI must not offer a Try again button for it. */
  /**
   * ⚠️ 'indexed' AND 'skipped' BOTH LEAVE `summary` EMPTY AND MEAN OPPOSITE
   * THINGS. 'skipped' = we read the reel and there was nothing in it.
   * 'indexed' = we deliberately did not write one — free saves get tags and a
   * category only, and one tap generates the full summary. Rendering the
   * second as the first tells someone their reel is empty when it is not.
   */
  summary_status?: 'pending' | 'ready' | 'indexed' | 'skipped' | 'failed' | 'quota_exceeded';
  notes: string | null;
  summarize_count: number;
  tasks_count: number;
  workout_count: number;
  // Flagged by the AI when the content is medical/high-stakes advice: the app
  // shows a disclaimer and hides tasks/workout (the server refuses them too).
  is_sensitive?: boolean;
  created_at: string;
}

export interface ReelListResponse {
  total: number;
  items: Reel[];
}

export interface WorkoutExercise {
  id: string;
  name: string;
  type: 'strength' | 'cardio' | 'core' | 'flexibility';
  muscle_group: string;
  sets: number | null;
  reps: number | null;
  duration_seconds: number | null;
  rest_seconds: number;
  is_estimated: boolean;
  sort_order: number;
}

export interface WorkoutPlan {
  reel_id: string;
  workout_name: string;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  estimated_minutes: number;
  exercises: WorkoutExercise[];
}

export interface Task {
  id: string;
  reel_id: string;
  text: string;
  emoji: string;
  estimated_minutes: number | null;
  completed: boolean;
  sort_order: number;
}

export type TodoPriority = 'high' | 'medium' | 'low';

export interface Todo {
  id: string;
  /** null once the linked reel is deleted — the todo outlives it. */
  reel_id: string | null;
  title: string;
  description: string | null;
  priority: TodoPriority;
  /** "YYYY-MM-DD", or null for "Someday". A calendar date in the user's OWN
   *  timezone — the server stores it verbatim and never converts, so bucketing
   *  into overdue/today/upcoming happens here against the device clock. */
  due_date: string | null;
  completed: boolean;
  completed_at: string | null;
  /** The user's LOCAL calendar day it was ticked off ("YYYY-MM-DD"). This, not
   *  completed_at, is what the daily goal counts — a UTC instant would move
   *  someone's streak by a day either side of the international date line. */
  completed_on: string | null;
  created_at: string | null;
}

/** Whole-list counters for the dashboard. Deliberately has no "due today" /
 *  "overdue" — those depend on the device's calendar day and are computed
 *  locally, so the server never offers a second, disagreeing definition. */
export interface TodoStats {
  total: number;
  open: number;
  completed: number;
  /** Only present when listTodos() was given the device's local date. `null`
   *  means "didn't ask" — never render it as 0, that reads as "you've done
   *  nothing today" when we simply never told the server what today is. */
  completed_today: number | null;
}

export interface TodoListResponse {
  total: number;          // length of `items` (respects includeCompleted)
  items: Todo[];
  stats: TodoStats;
}

/** Drives the disabled state of the reel screen's "Add to Follow Through"
 *  button: a non-null `open_todo` means one is already outstanding. */
export interface ReelTodo {
  reel_id: string;
  open_todo: Todo | null;
  completed_count: number;
}

export interface TodoInput {
  title?: string;
  description?: string | null;
  priority?: TodoPriority;
  due_date?: string | null;
  completed?: boolean;
  /** The device's local date, sent when ticking something off so the daily goal
   *  counts against the user's own calendar day. */
  completed_on?: string | null;
  /** due_date is nullable, so omitted and null look identical in JSON — this is
   *  the explicit "move it back to Someday". */
  clear_due_date?: boolean;
}

export interface Usage {
  // Effective tier: 'trial' (first days, full limits), 'free' (post-trial:
  // capped saves + a small daily AI trickle), 'pro' (paid, unlimited saves).
  tier: 'trial' | 'free' | 'pro';
  trial_ends_at: string | null;                    // ISO UTC; null for pro
  saves: { used: number; limit: number | null };   // limit null = unlimited
  /** What this account drops to when the trial ends. ⚠️ SERVER-SENT ON PURPOSE —
   *  ProfilePanel used to hardcode "20 saves", which stopped being true on
   *  2026-09-11 and was a wrong promise shown to every trial user until 2026-10-06.
   *  Both numbers are env-overridable, so the client cannot safely guess either. */
  after_trial?: { save_limit: number; ai_limit: number };
  /** What Pro holds. ⚠️ SERVER-SENT so the upsell copy cannot promise a number the
   *  server does not grant — promoSlot.ts used to hardcode 500. */
  pro?: { save_limit: number; ai_limit: number };
  categories?: number; // distinct categories across the whole library
  platforms?: number;  // distinct platforms across the whole library
  used: number;        // AI actions spent today
  limit: number;       // AI actions allowed today (tier-dependent)
  remaining: number;
  resets_at: string;
  /** This email had an account here before and deleted it — derived server-side
   *  from the trial grant that outlives deletion. Drives the welcome-back
   *  screen, and suppresses the first-run tour. */
  returning?: boolean;
  // Feature flags for locked-button UI (server enforces with 403s regardless):
  // post-trial free loses ask / non-cooking tasks / itinerary; trial+pro keep all.
  features?: { ask: boolean; tasks: boolean; recipe: boolean; workout: boolean; itinerary: boolean };
}

// The drill-down behind the meter: what today's AI actions were spent on.
export interface UsageLogItem {
  action: string;         // summary | resummarize | tasks | recipe | workout | itinerary | ask
  action_label: string;   // human label, e.g. "Trip itinerary"
  label: string | null;   // the reel title or question snippet
  at: string | null;      // ISO timestamp
}

export interface UsageLog {
  day: string;
  used: number;           // the meter's number
  logged: number;         // how many we can actually describe (may be < used)
  items: UsageLogItem[];
}

// ── Trip Itinerary (travel reels, Pro feature) ─────────────────────────────
export interface ItineraryDay {
  label: string;                                  // "Day 1 — Tokyo"
  items: { text: string; emoji: string }[];
}

export interface Itinerary {
  trip_name: string;
  destination: string | null;
  duration_days: number | null;
  // True when the reel didn't state a day plan and the AI organized the places
  // into days itself — the UI shows an honesty note. Places are always
  // extracted-only, never invented.
  structure_estimated: boolean;
  days: ItineraryDay[];
  tips: string[];
}

export interface ItineraryResponse {
  reel_id: string;
  itinerary: Itinerary | null;                    // null = never generated
  regenerations_left: number;
}

export interface AskResponse {
  answer: string;
  sources: Reel[];
}

export interface TaskListResponse {
  reel_id: string;
  total: number;
  completed: number;
  kind?: 'steps' | 'tasks';        // "steps" = ordered how-to/recipe, shown numbered
  source?: 'content' | 'title' | 'notes';
  note?: string | null;            // disclaimer when steps weren't read from the video
  tasks: Task[];
}

/**
 * Called after every successful write. `services/usageCache` registers itself
 * here at import time.
 *
 * ⚠️ WHY A HOOK AND NOT A DIRECT IMPORT: `usageCache` already imports `api`, so
 * importing it back would be a module cycle — the kind that resolves fine until
 * the day module init order changes and `refreshUsage` is undefined at first
 * call. One nullable function pointer keeps the dependency arrow pointing one
 * way.
 *
 * ⚠️ WHY IT LIVES IN `request()` AT ALL. The AI budget and the library counts
 * are server-owned, and EVERY screen that changed them was expected to remember
 * to re-fetch. None of them did: the reel screen ran summarize / tasks /
 * workout / itinerary and refreshed usage only on MOUNT, so five spent actions
 * later the cache still held the numbers from before the first one. Opening the
 * hamburger then painted that stale number, refreshed in the background, and
 * corrected itself a beat later — the "menu isn't updating" the owner reported.
 *
 * Putting it in each caller means every FUTURE endpoint has to remember too.
 * This is the one place they all already go through.
 */
let onMutate: (() => void) | null = null;
export function setMutationHook(fn: () => void) { onMutate = fn; }

async function request<T>(path: string, options?: RequestInit, timeoutMs = 55000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Attach the Supabase access token so the backend can scope to this user.
    // supabase-js auto-refreshes, so this is current; null when logged out.
    const token = await getAccessToken();
    const res = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options?.headers || {}),
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      // Surface the backend's human-readable `detail` so screens never have to
      // show raw JSON. Falls back to the raw body for non-FastAPI errors.
      const raw = await res.text();
      let msg = raw || `Request failed: ${res.status}`;
      try {
        const detail = JSON.parse(raw)?.detail;
        if (typeof detail === 'string' && detail) msg = detail;
      } catch {}
      throw new Error(msg);
    }
    // Anything that isn't a GET may have moved the AI budget or the library
    // counts. GET is excluded so `getUsage()` itself cannot loop.
    if ((options?.method || 'GET').toUpperCase() !== 'GET') onMutate?.();
    return res.json();
  } catch (e: any) {
    if (e.name === 'AbortError') {
      throw new Error('Request timed out. The server took too long — try again.');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Must match the backend's SOURCES_MARKER (app/routes/ask.py) — separates the
// streamed answer prose from the trailing sources JSON.
const SOURCES_MARKER = '\n␞__SRC__␞';

export interface AskStreamHandlers {
  onToken: (answerSoFar: string) => void;  // called with the full answer text each time it grows
  signal?: AbortSignal;
}

/**
 * Streaming "ask your library" — the answer renders token-by-token as Claude
 * writes it. Uses XMLHttpRequest (not fetch): its incremental `responseText`
 * surfaces the same way on React Native native AND web, so one path works on
 * both. Resolves with the final {answer, sources} once the stream completes.
 */
async function askStream(question: string, handlers: AskStreamHandlers): Promise<AskResponse> {
  const token = await getAccessToken();
  return new Promise<AskResponse>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE_URL}/api/ask/stream`);
    xhr.setRequestHeader('Content-Type', 'application/json');
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

    const split = (raw: string) => {
      const i = raw.indexOf(SOURCES_MARKER);
      return i === -1
        ? { answer: raw, sources: null as Reel[] | null }
        : { answer: raw.slice(0, i), sources: safeParse(raw.slice(i + SOURCES_MARKER.length)) };
    };
    const safeParse = (s: string): Reel[] | null => {
      try { return JSON.parse(s) as Reel[]; } catch { return null; }
    };

    xhr.onprogress = () => {
      // responseText holds everything received so far; show the answer portion,
      // hiding the sources sentinel if it's already arrived.
      handlers.onToken(split(xhr.responseText).answer);
    };
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        let msg = xhr.responseText || `Request failed: ${xhr.status}`;
        try { const d = JSON.parse(xhr.responseText)?.detail; if (typeof d === 'string' && d) msg = d; } catch {}
        reject(new Error(msg));
        return;
      }
      // Ask is the one AI action that bypasses `request()` (it streams over
      // XHR), so it has to report the spend itself — without this, the single
      // most quota-visible screen in the app is the one that never updates it.
      onMutate?.();
      const { answer, sources } = split(xhr.responseText);
      resolve({ answer: answer.trim(), sources: sources ?? [] });
    };
    xhr.onerror = () => reject(new Error("Can't reach the server. Make sure the backend is running."));
    xhr.ontimeout = () => reject(new Error('That took too long — try again.'));
    xhr.timeout = 55000;

    if (handlers.signal) {
      handlers.signal.addEventListener('abort', () => xhr.abort());
    }
    xhr.send(JSON.stringify({ question }));
  });
}

export const api = {
  // ── Reels ────────────────────────────────────────────────
  saveReel: (url: string) =>
    request<Reel>('/api/reels/save', {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),

  /** Hand the backend metadata this device fetched from the user's own IP, for
   *  links our datacenter IP can't read (Instagram/Facebook). The server ignores
   *  it whenever its own extraction succeeded. See services/clientExtract.ts. */
  sendClientMetadata: (reelId: string, meta: ClientMetadata) =>
    request<Reel>(`/api/reels/${reelId}/client-metadata`, {
      method: 'POST',
      body: JSON.stringify(meta),
    }),

  listReels: (filters?: { tag?: string; category?: string; platform?: string; limit?: number; offset?: number }) => {
    const params = new URLSearchParams(
      Object.fromEntries(
        Object.entries(filters || {})
          .filter(([, v]) => v !== undefined && v !== '' && v !== null)
          .map(([k, v]) => [k, String(v)])
      )
    );
    return request<ReelListResponse>(`/api/reels?${params}`);
  },

  getReel: (id: string) => request<Reel>(`/api/reels/${id}`),

  // ⚠️ `searchReels()` was removed on 2026-08-10 along with the endpoint it
  // called. The library header's search field went in PR #39; this client method
  // was kept one round as the seam to wire a new entry point back to, and the
  // owner then chose to delete the vertical rather than carry it unreachable.

  resummarize: (id: string) =>
    request<Reel>(`/api/reels/${id}/resummarize`, { method: 'POST' }),

  // Run/retry the first summary (for a reel still pending or failed).
  summarizeReel: (id: string) =>
    request<Reel>(`/api/reels/${id}/summarize`, { method: 'POST' }),

  /** Re-resolve a dead or missing preview image. Costs no AI action — see
   *  `services/thumbRefresh.ts` for why Instagram thumbnails expire at all. */
  refreshThumbnail: (id: string) =>
    request<Reel>(`/api/reels/${id}/thumbnail`, { method: 'POST' }),

  updateNotes: (id: string, notes: string) =>
    request<Reel>(`/api/reels/${id}/notes`, {
      method: 'PATCH',
      body: JSON.stringify({ notes }),
    }),

  updateCategory: (id: string, category: string) =>
    request<Reel>(`/api/reels/${id}/category`, {
      method: 'PATCH',
      body: JSON.stringify({ category }),
    }),

  deleteReel: (id: string) =>
    request<{ message: string }>(`/api/reels/${id}`, { method: 'DELETE' }),

  ask: (question: string) =>
    request<AskResponse>('/api/ask', { method: 'POST', body: JSON.stringify({ question }) }),

  askStream,

  // ── Workout ──────────────────────────────────────────────
  generateWorkout: (reelId: string) =>
    request<WorkoutPlan>(`/api/reels/${reelId}/workout`, { method: 'POST' }),

  getWorkout: (reelId: string) =>
    request<WorkoutPlan>(`/api/reels/${reelId}/workout`),

  // ── Trip Itinerary (travel reels) ────────────────────────
  generateItinerary: (reelId: string) =>
    request<ItineraryResponse>(`/api/reels/${reelId}/itinerary`, { method: 'POST' }),

  getItinerary: (reelId: string) =>
    request<ItineraryResponse>(`/api/reels/${reelId}/itinerary`),

  updateExercise: (exerciseId: string, patch: { sets?: number; reps?: number; duration_seconds?: number; rest_seconds?: number }) =>
    request<WorkoutExercise>(`/api/exercises/${exerciseId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  // ── Tasks ────────────────────────────────────────────────
  generateTasks: (reelId: string) =>
    request<TaskListResponse>(`/api/reels/${reelId}/tasks`, { method: 'POST' }),

  getTasks: (reelId: string) =>
    request<TaskListResponse>(`/api/reels/${reelId}/tasks`),

  toggleTask: (taskId: string, completed: boolean) =>
    request<Task>(`/api/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify({ completed }),
    }),

  // Manual task editing — no AI.
  addTask: (reelId: string, text: string) =>
    request<Task>(`/api/reels/${reelId}/tasks/manual`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  editTask: (taskId: string, text: string) =>
    request<Task>(`/api/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify({ text }),
    }),

  deleteTask: (taskId: string) =>
    request<{ message: string }>(`/api/tasks/${taskId}`, { method: 'DELETE' }),

  // ── To-do list (no AI, no quota) ─────────────────────────
  /** `today` is the caller's LOCAL date; pass it to get `stats.completed_today`
   *  for the daily goal without downloading every completed row. */
  listTodos: (includeCompleted = false, today?: string) =>
    request<TodoListResponse>(
      `/api/todos?include_completed=${includeCompleted}${today ? `&today=${today}` : ''}`
    ),

  /** Is there already an open to-do for this save? */
  getReelTodo: (reelId: string) => request<ReelTodo>(`/api/reels/${reelId}/todo`),

  createTodo: (body: TodoInput & { title: string }) =>
    request<Todo>('/api/todos', { method: 'POST', body: JSON.stringify(body) }),

  /** Add a save to the list — the server copies the reel's title and summary in,
   *  so the todo still reads correctly if the reel is deleted later. */
  createTodoFromReel: (reelId: string, body: TodoInput = {}) =>
    request<Todo>(`/api/reels/${reelId}/todo`, { method: 'POST', body: JSON.stringify(body) }),

  updateTodo: (id: string, body: TodoInput) =>
    request<Todo>(`/api/todos/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  deleteTodo: (id: string) =>
    request<{ message: string }>(`/api/todos/${id}`, { method: 'DELETE' }),

  // ── Billing ───────────────────────────────────────────────
  /**
   * Ask the server to confirm this user's purchase with RevenueCat and stamp the
   * tier now.
   *
   * ⚠️ CALLED AFTER A PURCHASE BECAUSE THE WEBHOOK IS TOO SLOW TO BE A PURCHASE
   * FLOW. RevenueCat's webhook lands asynchronously and the tier it writes only
   * reaches the app on the next JWT refresh (≤1h), so without this a user who has
   * just paid keeps seeing the free tier with a receipt in their hand. Grant-only
   * on the server — it can never downgrade anyone. See backend/app/routes/billing.py.
   */
  syncBilling: () =>
    request<{ tier: 'pro' | null; active: boolean }>('/api/billing/sync', { method: 'POST' }, 20000),

  // ── Account ───────────────────────────────────────────────
  getUsage: () => request<Usage>('/api/account/usage'),

  getUsageLog: () => request<UsageLog>('/api/account/usage/log'),

  deleteAccount: () =>
    request<{ deleted: boolean; reels_removed: number; message: string }>(`/api/account`, { method: 'DELETE' }),

  /** Mint the save-scoped key the Android share Activity carries. See
   *  services/shareKey.ts for why the Supabase session can't be used there. */
  createShareKey: () =>
    request<{ key: string }>('/api/account/share-key', { method: 'POST' }),

  revokeShareKey: () =>
    request<{ revoked: boolean }>('/api/account/share-key', { method: 'DELETE' }),
};

/** The backend the app is talking to. The Android share Activity runs outside
 *  the JS runtime, where `EXPO_PUBLIC_API_URL` (inlined at bundle time) does
 *  not exist — so it has to be handed the value rather than read it. */
export const apiBaseUrl = () => BASE_URL;
