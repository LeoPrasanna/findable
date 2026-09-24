/**
 * ⚠️ REGISTRATION ORDER IN app.json IS LOAD-BEARING. THIS PLUGIN MUST BE LISTED
 * *BEFORE* "expo-share-intent", WHICH LOOKS BACKWARDS AND IS NOT.
 *
 * @expo/config-plugins runs mods in REVERSE registration order. withMod.js:199:
 *
 *     const results = await action({...});   // this plugin's action
 *     return nextMod(results);               // THEN the previously registered one
 *
 * So the LAST plugin registered runs FIRST. expo-share-intent writes
 * ShareExtensionViewController.swift in its own withXcodeProject mod
 * (ios/withIosShareExtensionXcodeTarget.js:33). Registered after it, this mod
 * ran BEFORE the file existed and threw "found 0".
 *
 * Three EAS builds were spent learning that: c080fa09 (dangerous mod),
 * 1e85219c (Xcode mod, still registered last), and 7612e5a9 (plugin removed —
 * FINISHED, which is what proved the plugin was the cause). The error text was
 * only ever visible on expo.dev; the CLI reports UNKNOWN_ERROR and the
 * downloadable log is encrypted at rest. READ THE PREBUILD PHASE ON expo.dev
 * before theorising if this ever breaks again.
 */

const fs = require('fs');
const path = require('path');
const { withXcodeProject } = require('@expo/config-plugins');

/**
 * iOS PHASE B — the invisible share, matching Android.
 *
 * Android already saves without opening the app (plugins/withInvisibleShare.js
 * + ShareSave.kt). iOS did not: expo-share-intent's extension foregrounds the
 * whole app through `application.open(url)` and leaves Instagram's share sheet
 * presented behind it — the owner's "Findable opens but never closes and the
 * social media app is stuck", 2026-09-09. iOS has NO public API to exit an app,
 * so nothing in JS could fix it; the app must simply never be opened.
 *
 * ⚠️ THIS PATCHES EXACTLY ONE FUNCTION and asserts on it. expo-share-intent
 * writes ShareExtensionViewController.swift during prebuild; we replace the body
 * of `redirectToHostApp` and leave its ~600 lines of content-type handling
 * alone. If a version bump changes that function, prebuild THROWS — a two-minute
 * failure with a named cause, instead of a thirty-minute Swift compile error or,
 * far worse, a silent revert to the visible behaviour.
 *
 * ⚠️ withXcodeProject, NOT withDangerousMod — AND THAT IS THE WHOLE POINT.
 * Build c080fa09 died in Prebuild with this as a dangerous mod, because
 * "all dangerous mods run first before other mods" (withDangerousMod's own
 * docstring) and expo-share-intent writes the extension in one of those. Two
 * dangerous mods race, and this one lost: the .swift did not exist yet, so the
 * assertion below fired on a file that was simply not written yet rather than on
 * real template drift. Every dangerous mod has finished by the time an Xcode
 * mod runs, so the file is guaranteed to be there. Nothing about the Xcode
 * project itself is touched — the config is returned untouched; this mod is
 * used purely for its position in the order.
 *
 * ⚠️ IT FALLS BACK, IT DOES NOT FAIL. No share key stored (signed out, offline
 * at mint time, an older app version) means `findableSaveDirectly` returns false
 * and the original open-the-app path runs. The share always happens; only its
 * polish is conditional.
 *
 * ⚠️ THE UPLOAD IS A BACKGROUND SESSION, AND THAT IS NOT OPTIONAL.
 * `completeRequest` tears the extension process down. A plain URLSession.shared
 * task started just before it is killed mid-flight and the save silently never
 * happens — the single most likely way to get this subtly wrong. A background
 * session with `sharedContainerIdentifier` set is handed to the system and
 * survives the process; it is precisely what Apple built it for.
 */

const ANCHOR = `  private func redirectToHostApp(type: RedirectType) {
    let nonce = UUID().uuidString
    let url = URL(string: "\\(shareProtocol)://dataUrl=\\(sharedKey)?nonce=\\(nonce)#\\(type)")!
    var responder = self as UIResponder?

    while responder != nil {
      if let application = responder as? UIApplication {
        if application.canOpenURL(url) {
          application.open(url)
        } else {
          NSLog("redirectToHostApp canOpenURL KO: \\(shareProtocol)")
          self.dismissWithError(
            message: "Application not found, invalid url scheme \\(shareProtocol)")
          return
        }
      }
      responder = responder!.next
    }
    extensionContext!.completeRequest(returningItems: [], completionHandler: nil)
  }`;

const REPLACEMENT = `  // ── FINDABLE: invisible share (mobile/plugins/withInvisibleShareIOS.js) ──
  // Save from inside the extension and return the user to the app they came
  // from. Opening Findable is now the FALLBACK, not the behaviour.
  private func redirectToHostApp(type: RedirectType) {
    if findableSaveDirectly(type: type) { return }
    findableOpenHostApp(type: type)
  }

  /// Guards \`completeRequest\`, which must run exactly once — the notification
  /// callback and the 1.5 s safety net both reach for it.
  private var findableDidFinish = false

  /// The link the user actually shared. Some apps hand over a bare URL, others
  /// a sentence with a URL inside it ("Look at this <url>"), which is why the
  /// text case is scanned rather than trusted.
  private func findableSharedLink(type: RedirectType) -> String? {
    var raw: String? = nil
    if type == .weburl {
      raw = sharedWebUrl.first?.url
    } else if type == .text {
      raw = sharedText.first
    }
    guard let candidate = raw, !candidate.isEmpty else { return nil }
    if candidate.hasPrefix("http://") || candidate.hasPrefix("https://") {
      return candidate
    }
    let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
    let range = NSRange(candidate.startIndex..<candidate.endIndex, in: candidate)
    if let match = detector?.firstMatch(in: candidate, options: [], range: range),
      let matched = match.url
    {
      return matched.absoluteString
    }
    return nil
  }

  /// Returns true when the save was handed to the system. False means "could
  /// not", and the caller falls back to opening the app.
  private func findableSaveDirectly(type: RedirectType) -> Bool {
    guard let link = findableSharedLink(type: type),
      let defaults = UserDefaults(suiteName: hostAppGroupIdentifier),
      let raw = defaults.string(forKey: "findableShareConfig"),
      let data = raw.data(using: .utf8),
      let config = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      let apiUrl = config["apiUrl"] as? String,
      let shareKey = config["key"] as? String,
      !apiUrl.isEmpty, !shareKey.isEmpty
    else { return false }

    var base = apiUrl
    while base.hasSuffix("/") { base.removeLast() }
    guard let endpoint = URL(string: base + "/api/reels/share-save") else { return false }
    guard let body = try? JSONSerialization.data(withJSONObject: ["url": link]) else {
      return false
    }

    var request = URLRequest(url: endpoint)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue(shareKey, forHTTPHeaderField: "X-Share-Key")

    // A background session outlives this process. completeRequest below kills
    // the extension, and a foreground task would die with it.
    let sessionId = "app.findable.share." + UUID().uuidString
    let sessionConfig = URLSessionConfiguration.background(withIdentifier: sessionId)
    sessionConfig.sharedContainerIdentifier = hostAppGroupIdentifier
    sessionConfig.isDiscretionary = false
    let session = URLSession(configuration: sessionConfig, delegate: nil, delegateQueue: nil)

    // Background uploads must come from a FILE — httpBody is ignored outright.
    // The temp file lives long enough for the system to take its own copy.
    let tmp = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString + ".json")
    do {
      try body.write(to: tmp)
    } catch {
      NSLog("[FINDABLE] could not stage share body: \\(error)")
      return false
    }

    session.uploadTask(with: request, fromFile: tmp).resume()

    // Clear the stashed payload the app would otherwise pick up and save a
    // SECOND time on its next launch.
    defaults.removeObject(forKey: sharedKey)
    findableReportShare(link: link, defaults: defaults)
    return true
  }

  /// Human name for the platform, from the URL alone.
  ///
  /// ⚠️ THIS IS THE THIRD COPY of one list — the others are \`platformLabel\` in
  /// mobile/services/shareSave.ts and in plugins/android/ShareSave.kt. Three
  /// processes, none of which can call the others. The Kotlin copy already fell
  /// a week behind on Threads because a JS-only release physically cannot touch
  /// it; when a platform is added, all three change in the same native build.
  private func findablePlatformLabel(_ url: String) -> String {
    let u = url.lowercased()
    if u.contains("youtube.com") || u.contains("youtu.be") { return "YouTube" }
    if u.contains("instagram.com") { return "Instagram" }
    if u.contains("facebook.com") || u.contains("fb.watch") || u.contains("fb.com") { return "Facebook" }
    if u.contains("tiktok.com") { return "TikTok" }
    if u.contains("threads.net") || u.contains("threads.com") { return "Threads" }
    if u.contains("linkedin.com") { return "LinkedIn" }
    return "the web"
  }

  /// Tell the user the share happened, then end the extension.
  ///
  /// ⚠️ WITHOUT THIS, AN iOS SILENT SHARE WAS COMPLETELY INVISIBLE. Android
  /// posts a notification AND writes a drawer receipt for every invisible save;
  /// iOS posted nothing and wrote nothing, so a failure to save looked exactly
  /// like a success — the precise ambiguity the whole receipt mechanism exists
  /// to remove (owner report, 2026-09-23).
  ///
  /// ⚠️ THE WORDING CLAIMS ONLY WHAT WE KNOW. The upload is a BACKGROUND
  /// session handed to the system; it completes long after this process is
  /// dead, and iOS delivers that completion to the containing app, not here. So
  /// this says "saving", never "saved". Android can say "Saved from X" because
  /// its foreground service is still alive to see the HTTP status; this cannot,
  /// and inventing a confirmation we have not got is exactly the kind of lie
  /// that makes a lost save undiscoverable.
  ///
  /// ⚠️ \`completeRequest\` IS DEFERRED UNTIL THE NOTIFICATION IS HANDED OVER.
  /// It tears the process down, and \`UNUserNotificationCenter\` is asynchronous —
  /// completing first raced the request into a dead process and posted nothing.
  /// The 1.5 s safety net exists because a callback that never fires would
  /// otherwise leave the share sheet spinning forever, which is worse than a
  /// missing notification.
  private func findableReportShare(link: String, defaults: UserDefaults) {
    let title = "Saving from " + findablePlatformLabel(link)
    let body = "Findable is saving it in the background — it'll be in your library shortly."

    // The drawer receipt goes in FIRST, and unconditionally. A user who denied
    // notifications gets no banner at all, so this list is the only place the
    // share is ever reported to them. Capped at 10, the same as the JS drawer.
    var pending = defaults.array(forKey: "findablePendingShares") as? [[String: Any]] ?? []
    pending.append([
      "title": title,
      "body": body,
      "at": Date().timeIntervalSince1970 * 1000,
    ])
    defaults.set(Array(pending.suffix(10)), forKey: "findablePendingShares")

    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
      self?.findableFinish()
    }

    let center = UNUserNotificationCenter.current()
    center.getNotificationSettings { [weak self] settings in
      guard settings.authorizationStatus == .authorized
        || settings.authorizationStatus == .provisional
      else {
        self?.findableFinish()
        return
      }
      let content = UNMutableNotificationContent()
      content.title = title
      content.body = body
      content.sound = nil   // a save is not worth a noise
      let request = UNNotificationRequest(
        identifier: UUID().uuidString, content: content, trigger: nil)
      center.add(request) { _ in self?.findableFinish() }
    }
  }

  /// Ends the extension exactly once, on the main thread.
  private func findableFinish() {
    DispatchQueue.main.async { [weak self] in
      guard let self = self, !self.findableDidFinish else { return }
      self.findableDidFinish = true
      self.extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
    }
  }

  /// expo-share-intent's original behaviour, kept verbatim as the fallback.
  private func findableOpenHostApp(type: RedirectType) {
    let nonce = UUID().uuidString
    let url = URL(string: "\\(shareProtocol)://dataUrl=\\(sharedKey)?nonce=\\(nonce)#\\(type)")!
    var responder = self as UIResponder?

    while responder != nil {
      if let application = responder as? UIApplication {
        if application.canOpenURL(url) {
          application.open(url)
        } else {
          NSLog("redirectToHostApp canOpenURL KO: \\(shareProtocol)")
          self.dismissWithError(
            message: "Application not found, invalid url scheme \\(shareProtocol)")
          return
        }
      }
      responder = responder!.next
    }
    extensionContext!.completeRequest(returningItems: [], completionHandler: nil)
  }`;

module.exports = function withInvisibleShareIOS(config) {
  return withXcodeProject(config, cfg => {
    const root = cfg.modRequest.platformProjectRoot;
    // ⚠️ "ShareViewController.swift", NOT "ShareExtensionViewController.swift".
    // The TEMPLATE inside node_modules carries the longer name; the file
    // actually written into the project has the SHORTER one — see
    // expo-share-intent/plugin/build/ios/constants.js:8
    // (`shareExtensionViewControllerFileName`). Searching for the template's
    // name finds nothing, ever, and it cost two builds. Worse, the local
    // harness "passed" because the fake file was created under the template
    // name too: it validated the mistake instead of catching it.
    const TARGET = 'ShareViewController.swift';
    const dirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
    const candidates = dirs
      .map(name => path.join(root, name, TARGET))
      .filter(p => fs.existsSync(p));

    if (candidates.length !== 1) {
      // Name what WAS found. A bare "found 0" is what turned a one-line
      // mistake into a multi-build hunt.
      const seen = dirs
        .map(name => {
          let swift = [];
          try {
            swift = fs.readdirSync(path.join(root, name)).filter(f => f.endsWith('.swift'));
          } catch {}
          return name + '/[' + swift.join(', ') + ']';
        })
        .join(' ');
      throw new Error(
        '[withInvisibleShareIOS] expected exactly one ' + TARGET + ' under ' + root +
          ', found ' + candidates.length +
          '. Swift files actually present: ' + (seen || '(no subdirectories)') +
          ". Re-check plugins/withInvisibleShareIOS.js against expo-share-intent's layout.",
      );
    }

      const file = candidates[0];
      let source = fs.readFileSync(file, 'utf8');

      // ⚠️ The generated controller imports UIKit but not UserNotifications, and
      // the receipt below posts a local notification. Added here rather than in
      // REPLACEMENT because an import has to sit at file scope, not inside the
      // class body the anchor lives in.
      if (!source.includes('import UserNotifications')) {
        source = source.replace('import UIKit', 'import UIKit\nimport UserNotifications');
      }

      // Idempotent: prebuild can run more than once against the same tree.
      if (source.includes('findableSaveDirectly')) return cfg;

      if (!source.includes(ANCHOR)) {
        throw new Error(
          '[withInvisibleShareIOS] could not find redirectToHostApp verbatim in ' +
            file +
            '. expo-share-intent changed it, so the invisible share would silently revert to ' +
            'opening the app. Update ANCHOR in plugins/withInvisibleShareIOS.js.',
        );
      }

    fs.writeFileSync(file, source.replace(ANCHOR, REPLACEMENT), 'utf8');
    return cfg;
  });
};
