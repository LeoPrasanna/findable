package com.savehere.app.share

import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.database.sqlite.SQLiteDatabase
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import androidx.core.app.NotificationCompat
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

/**
 * ANDROID PHASE B — the invisible share.
 *
 * Phase A launched the whole app to receive ACTION_SEND: it worked, but it
 * flashed SaveHere for 1–2 s in the middle of someone's Instagram scroll, which
 * is the exact interruption the share feature exists to avoid. Everything here
 * exists to delete that flash.
 *
 * ⚠️ THIS RUNS OUTSIDE THE JS RUNTIME. There is no React Native context and no
 * supabase-js, so it cannot use the Supabase session:
 *   * a stored access token lives ~1 h and only refreshes while the app is
 *     open, so most shares would 401;
 *   * refreshing from here would revoke the refresh token the app still holds
 *     and sign the user out on the next launch.
 * It carries a save-scoped share key instead — see backend/app/sharekey.py and
 * mobile/services/shareKey.ts.
 *
 * ⚠️ IT ALSO CANNOT CALL saveSharedLink(). Everything the JS path does that
 * still matters here is reproduced: the POST, the notification, and appending
 * to the notification drawer's AsyncStorage row. What is deliberately NOT
 * reproduced is the client-side metadata fetch — as of 2026-08-13 the server
 * reads Instagram captions itself through the embed route and Facebook through
 * oEmbed (docs/EXTRACTION_ROUTES.md), so the phone no longer has to lend its
 * residential IP for the platforms that mattered.
 */

/* ── Storage: AsyncStorage is SQLite on Android, not SharedPreferences ─────── */

private const val SHARE_KEY_ROW = "@savehere:sharekey:v1"
private const val NOTES_ROW = "@savehere:notifications:v1"
private const val MAX_NOTES = 10
private const val CHANNEL_ID = "saves"

internal data class ShareConfig(val apiUrl: String, val key: String)

/**
 * Read one AsyncStorage row.
 *
 * `RKStorage` (table `catalystLocalStorage`) is the file @react-native-async-storage
 * writes. Read-only, and every failure returns null so a schema change in a
 * future AsyncStorage release degrades to "open the app" rather than crashing
 * in someone's share sheet.
 */
internal fun readRow(ctx: Context, key: String): String? {
    val file = ctx.getDatabasePath("RKStorage")
    if (file == null || !file.exists()) return null
    var db: SQLiteDatabase? = null
    return try {
        db = SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READONLY)
        db.rawQuery("SELECT value FROM catalystLocalStorage WHERE key = ?", arrayOf(key)).use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
    } catch (t: Throwable) {
        null
    } finally {
        try { db?.close() } catch (t: Throwable) { }
    }
}

internal fun writeRow(ctx: Context, key: String, value: String) {
    val file = ctx.getDatabasePath("RKStorage")
    if (file == null || !file.exists()) return
    var db: SQLiteDatabase? = null
    try {
        db = SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READWRITE)
        db.execSQL(
            "INSERT OR REPLACE INTO catalystLocalStorage (key, value) VALUES (?, ?)",
            arrayOf<Any>(key, value)
        )
    } catch (t: Throwable) {
        // The app may hold a write lock. Losing a drawer entry is survivable;
        // crashing the share is not.
    } finally {
        try { db?.close() } catch (t: Throwable) { }
    }
}

internal fun readConfig(ctx: Context): ShareConfig? {
    val raw = readRow(ctx, SHARE_KEY_ROW) ?: return null
    return try {
        val o = JSONObject(raw)
        val url = o.optString("apiUrl").trimEnd('/')
        val key = o.optString("key")
        if (url.isEmpty() || key.isEmpty()) null else ShareConfig(url, key)
    } catch (t: Throwable) {
        null
    }
}

/**
 * Append to the notification drawer the profile panel reads.
 *
 * ⚠️ Without this, the ONLY notifications missing from the in-app list would be
 * the ones from invisible shares — i.e. exactly the saves the user never saw
 * happen. Shape and cap must match mobile/services/notifyLog.ts.
 */
internal fun appendNote(ctx: Context, title: String, body: String) {
    try {
        val now = System.currentTimeMillis()
        val note = JSONObject()
            .put("id", now.toString() + "-" + UUID.randomUUID().toString().take(6))
            .put("title", title)
            .put("body", body)
            .put("at", now)
            .put("read", false)
        val existing = try { JSONArray(readRow(ctx, NOTES_ROW) ?: "[]") } catch (t: Throwable) { JSONArray() }
        val out = JSONArray().put(note)
        var i = 0
        while (i < existing.length() && out.length() < MAX_NOTES) {
            existing.optJSONObject(i)?.let { out.put(it) }
            i++
        }
        writeRow(ctx, NOTES_ROW, out.toString())
    } catch (t: Throwable) {
    }
}

/* ── Notifications ────────────────────────────────────────────────────────── */

internal fun ensureChannel(ctx: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val mgr = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
    // Same id the JS path uses (services/shareSave.ts), so both land in one
    // channel and the user has one switch, not two.
    mgr.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Saved links", NotificationManager.IMPORTANCE_DEFAULT)
    )
}

internal fun buildNotification(ctx: Context, title: String, body: String, ongoing: Boolean): android.app.Notification {
    val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
    val pending = if (launch == null) null else PendingIntent.getActivity(
        ctx, 0, launch,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    return NotificationCompat.Builder(ctx, CHANNEL_ID)
        // A framework status drawable on purpose: it is guaranteed to exist and
        // to be a real status-bar icon. The app's own launcher icon is an
        // adaptive mipmap, which renders as a blank square in the status bar on
        // several Android versions.
        .setSmallIcon(android.R.drawable.stat_sys_download_done)
        .setContentTitle(title)
        .setContentText(body)
        .setStyle(NotificationCompat.BigTextStyle().bigText(body))
        .setOngoing(ongoing)
        .setAutoCancel(!ongoing)
        .setContentIntent(pending)
        .build()
}

/* ── The Activity: receives the share, decides, and gets out of the way ───── */

/**
 * Translucent and content-less, so the user keeps looking at Instagram. It does
 * no network at all — it hands the URL to the service and finishes, which is
 * what makes the share feel instantaneous.
 */
class ShareActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val url = extractUrl(intent?.getStringExtra(Intent.EXTRA_TEXT))

        if (url == null) {
            finish()
            return
        }

        // No key yet: never signed in on this device, or this build's first
        // run. Fall back to Phase A rather than dropping the link.
        val config = readConfig(this)
        if (config == null) {
            forwardToApp(url)
            finish()
            return
        }

        val work = Intent(this, ShareSaveService::class.java)
            .putExtra(ShareSaveService.EXTRA_URL, url)
            .putExtra(ShareSaveService.EXTRA_API, config.apiUrl)
            .putExtra(ShareSaveService.EXTRA_KEY, config.key)
        try {
            // Legal without restriction because we are the foreground app at
            // this instant — the service promotes itself before that stops
            // being true.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(work)
            else startService(work)
        } catch (t: Throwable) {
            // ⚠️ Android 12+ can still refuse a foreground-service start in
            // edge cases (an exemption we thought we had, expired). Falling
            // through to finish() here would make the share VANISH — no app,
            // no save, no notification, and the user watched nothing happen.
            forwardToApp(url)
        }
        finish()
    }

    /**
     * Hand the share to the app itself — Phase A's path. A 1–2 s flash beats a
     * lost link, every time.
     *
     * The component is explicit, so no intent filter has to match (MainActivity
     * no longer declares one). The `type` MUST be set: expo-share-intent's
     * activity listener ignores an intent whose `type` is null.
     */
    private fun forwardToApp(url: String) {
        val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return
        launch.action = Intent.ACTION_SEND
        launch.type = "text/plain"
        launch.putExtra(Intent.EXTRA_TEXT, url)
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try { startActivity(launch) } catch (t: Throwable) { }
    }
}

/**
 * Instagram and YouTube share a bare URL; other apps share "Look at this <url>"
 * or append a title. Same rule as the JS handler — pluck the first URL rather
 * than refusing anything that is not exactly a link.
 */
internal fun extractUrl(text: String?): String? {
    if (text.isNullOrBlank()) return null
    val m = Regex("https?://\\S+").find(text) ?: return null
    return m.value
}

/* ── The Service: does the save after the user has already walked away ────── */

/**
 * A foreground service, deliberately.
 *
 * The obvious cheaper version — a bare thread started from the Activity — works
 * right up until it doesn't: once the Activity finishes, the process is a
 * cached process and Android may reap it mid-request. On the free Render tier a
 * cold instance takes ~50 s to wake, which is exactly the window where that
 * happens, and the user would get no save AND no notification, having seen
 * nothing at all. This is Android's sanctioned mechanism for short work that
 * outlives the screen, and its "Saving…" notification is honest feedback during
 * that cold start instead of silence.
 */
class ShareSaveService : Service() {

    companion object {
        const val EXTRA_URL = "url"
        const val EXTRA_API = "api"
        const val EXTRA_KEY = "key"
        private const val ONGOING_ID = 4201
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val url = intent?.getStringExtra(EXTRA_URL)
        val api = intent?.getStringExtra(EXTRA_API)
        val key = intent?.getStringExtra(EXTRA_KEY)

        ensureChannel(this)
        promote(url)

        if (url == null || api == null || key == null) {
            stopSelf(startId)
            return START_NOT_STICKY
        }

        Thread {
            val where = platformLabel(url)
            val outcome = try {
                postSave(api, key, url)
            } catch (t: Throwable) {
                SaveOutcome(false, "", "No connection when it tried.")
            }
            val (title, body) = resultNotice(where, outcome)

            // Recorded before it is posted, and recorded even if posting is
            // refused: a user who declined notifications still needs one place
            // where the save is reported.
            appendNote(this, title, body)
            try {
                val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
                // A fresh id per save. A fixed one meant two shares in quick
                // succession left only the second notification on screen, so
                // the first save looked like it never happened.
                val id = (System.currentTimeMillis() % 100000L).toInt()
                mgr?.notify(id, buildNotification(this, title, body, false))
            } catch (t: Throwable) {
            }
            stopSelf(startId)
        }.start()

        return START_NOT_STICKY
    }

    private fun promote(url: String?) {
        // ⚠️ THIS IS THE "IT WENT TO FINDABLE" POP. It is the foreground
        // service's own notification — the one Android requires — rather than a
        // second banner, because two notifications for one share is how a
        // useful receipt becomes noise. It names the platform for the same
        // reason the JS pop does: it fires while the user is still looking at
        // Instagram, and "which app did I just share to?" is the only question
        // it has to answer. It is replaced by the result seconds later.
        val title = if (url != null) "${platformLabel(url)} → Findable" else "Saving to Findable"
        val note = buildNotification(this, title, "Saving this one to your library…", true)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(ONGOING_ID, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            } else {
                startForeground(ONGOING_ID, note)
            }
        } catch (t: Throwable) {
            // Android 12+ can refuse a foreground start in edge cases. The work
            // still runs on the thread below; it just loses its protection.
        }
    }

    /** True when the card exists server-side. The summary continues on the
     *  backend afterwards, exactly as for a save made in the app. */
    private fun postSave(api: String, key: String, url: String): SaveOutcome {
        var conn: HttpURLConnection? = null
        return try {
            conn = URL("$api/api/reels/share-save").openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("X-Share-Key", key)
            conn.connectTimeout = 15000
            // Generous: a cold free-tier Render instance takes ~50 s to wake,
            // and giving up early would report a failure for a save that was
            // about to succeed.
            conn.readTimeout = 90000
            conn.doOutput = true
            conn.outputStream.use { it.write(JSONObject().put("url", url).toString().toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            // 409-style duplicates are still "it's in your library".
            if (code in 200..299 || code == 409) {
                // ⚠️ THE TITLE IS IN THIS RESPONSE AND WAS BEING THROWN AWAY.
                // /share-save answers with the created card, so "Saved from
                // Instagram" could always have been `Saved: "<the actual
                // reel>"` — the one thing that tells the user WHICH save this
                // notification is about, hours later in the shade.
                val title = try {
                    JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
                        .optString("title", "")
                } catch (t: Throwable) {
                    ""
                }
                SaveOutcome(true, title, null)
            } else {
                // FastAPI puts a human sentence in `detail`, already tier-aware
                // ("Your library is full (50 saves). Delete a save to make
                // room."). Inventing our own message here would be worse copy
                // AND a second place to keep in step.
                val detail = try {
                    JSONObject(conn.errorStream?.bufferedReader()?.use { it.readText() } ?: "")
                        .optString("detail", "")
                } catch (t: Throwable) {
                    ""
                }
                SaveOutcome(false, "", if (detail.isNotBlank()) detail else "The server refused it (error $code).")
            }
        } catch (t: Throwable) {
            // No response at all: offline, DNS, TLS, or a timeout on a cold
            // instance. The user can act on that, so say it.
            SaveOutcome(false, "", "No connection when it tried.")
        } finally {
            try { conn?.disconnect() } catch (t: Throwable) { }
        }
    }
}

/** What the save actually did, so the notification can say it. */
internal data class SaveOutcome(val ok: Boolean, val title: String, val reason: String?)

/**
 * ⚠️ A PLACEHOLDER IS NOT A TITLE. The backend writes "Instagram Reel" when it
 * could not read the post; quoting that back claims a read that never happened.
 * Mirrors `usableTitle` in mobile/services/shareNotice.ts.
 */
internal fun usableTitle(title: String): String? {
    val t = title.trim()
    if (t.isEmpty()) return null
    val placeholder = Regex(
        "^(instagram|facebook|linkedin|tiktok|threads|youtube|web|unknown)\\s+(reel|post|video|short|link)s?$",
        RegexOption.IGNORE_CASE,
    )
    return if (placeholder.matches(t)) null else t
}

/** Cap a title so the notification body stays one readable line. */
internal fun shortTitle(t: String, max: Int = 70): String =
    if (t.length <= max) t else t.take(max).trimEnd(' ', ',', ';', ':', '.', '-') + "…"

/**
 * The result wording. ⚠️ THIS IS A HAND-WRITTEN COPY of
 * mobile/services/shareNotice.ts — Kotlin cannot import TypeScript, and this
 * process has no JS runtime. When the wording changes there it changes here, in
 * a NATIVE BUILD. The same rule as `platformLabel` below, and for the same
 * reason it has already drifted once.
 */
internal fun resultNotice(where: String, outcome: SaveOutcome): Pair<String, String> {
    if (outcome.ok) {
        val t = usableTitle(outcome.title)
        return if (t != null) {
            "Saved to Findable" to "\u201C${shortTitle(t)}\u201D is in your library."
        } else {
            "Saved to Findable" to "Your $where link is in your library. The summary is being written."
        }
    }
    val reason = outcome.reason ?: "No connection when it tried."
    // A server detail usually carries its own instruction; only add the retry
    // line when it does not.
    val tellsThemWhatToDo = Regex("delete|open findable|try|sign in|wait", RegexOption.IGNORE_CASE)
        .containsMatchIn(reason)
    val body = if (tellsThemWhatToDo) reason else "$reason Share it again to retry."
    return "Couldn't save that $where link" to body
}

/** Human name for the notification, from the URL alone — mirrors
 *  `platformLabel` in mobile/services/shareSave.ts. */
internal fun platformLabel(url: String): String {
    val u = url.lowercase()
    return when {
        u.contains("youtube.com") || u.contains("youtu.be") -> "YouTube"
        u.contains("instagram.com") -> "Instagram"
        u.contains("facebook.com") || u.contains("fb.watch") || u.contains("fb.com") -> "Facebook"
        u.contains("tiktok.com") -> "TikTok"
        // ⚠️ THIS LIST DRIFTED ONCE ALREADY. Threads shipped on 2026-09-17 in
        // the backend and in shareSave.ts, but not here — a Kotlin string can
        // only change in a BUILD, so a JS-only round physically cannot update
        // it, and the mirror silently fell behind. A Threads share notified
        // "Saved from the web" for a week. When a platform is added, this is
        // the copy that has to wait for the next native build; put it on the
        // build's checklist rather than assuming the OTA carried it.
        u.contains("threads.net") || u.contains("threads.com") -> "Threads"
        u.contains("linkedin.com") -> "LinkedIn"
        else -> "the web"
    }
}
