# ⚠️ DO NOT ADD SCRIPTS TO `package.json` FOR A JS-ONLY CHANGE

`runtimeVersion` is the **`fingerprint`** policy, and `@expo/fingerprint` hashes
**package.json's `scripts` block**. Adding one dev-only line (`"test:cover": …`)
on 2026-08-15 changed the runtime version from `dcafdcb7…` to `b0a8b156…`, and
the OTA update published from it reached **no device** — the installed build
only accepts its own fingerprint.

**A mismatched runtime version does not warn. It just silently never applies.**

So: new self-checks are invoked **directly** in `.github/workflows/mobile-ci.yml`
(`node --experimental-strip-types … path/to.test.ts`), not via a new npm script.
The six existing `test:*` scripts predate build 9 and are baked into its
fingerprint — leave them exactly as they are.

Verify before publishing an update — `compare`, not `generate`:

```bash
cd mobile && npx eas-cli@latest fingerprint:compare --build-id <installed build id>
```

It prints the build's fingerprint and this directory's side by side and names the
differing source when they disagree. `generate` gives you a number with nothing
to check it against, and on this machine (`core.autocrlf=true`) it has returned
three different values for one commit.

# ⚠️ AND THE SAME TRAP RUNS BACKWARDS

**`mobile/plugins/android/ShareSave.kt` is NOT in the fingerprint.** Measured
2026-09-25: editing it left the Android runtime on `19e8d21e…`, so the update
published from that tree applied perfectly — on top of a native share service
still running the old Kotlin.

So a fingerprint that matches proves the update will REACH the build. It proves
nothing about whether the native half of your change is in it. **Kotlin and Swift
changes need an APK/IPA, always**, and nothing will warn you.

# ⚠️ AND A CONFIG PLUGIN FREEZES BOTH PLATFORMS

`plugins/withInvisibleShareIOS.js` is iOS-only by name and by content. Editing it
moved the **ANDROID** runtime as well (`19e8d21e…` → `7bc363b6…`, measured
2026-09-25) — config-plugin files are hashed for every platform, because the
fingerprint cannot know which parts of a plugin apply where.

So touching one line of an iOS plugin blocks Android OTAs until an Android build
ships. Check `fingerprint:compare` against **both** installed builds before
assuming a change is OTA-safe, and prefer keeping native-adjacent work on a
branch until you actually intend to build.

---

# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

⚠️ This link is **version-pinned on purpose** and it is load-bearing: it is
auto-loaded into every session that touches `mobile/`, so a stale version here
sends every future session to the wrong API surface. It said `v56.0.0` until the
SDK 57 upgrade on 2026-08-15. **Bump it in the same commit as any SDK upgrade.**
