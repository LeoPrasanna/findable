import ExpoModulesCore
import UserNotifications

/**
 The other half of an iOS silent share: WHAT HAPPENED TO IT.

 The Share Extension hands the save to a background `URLSession` and then calls
 `completeRequest`, which kills it — so the extension can only ever say
 "saving", never "saved". Android says "saved" because its foreground service is
 still alive to read the HTTP status. That asymmetry is the OS, and this file is
 the OS's own answer to it:

 > "If an app extension's background session finishes while the extension is not
 > running, the system launches the CONTAINING APP in the background and calls
 > `application(_:handleEventsForBackgroundURLSession:completionHandler:)`."

 Expo forwards that call to app-delegate subscribers
 (`ExpoAppDelegate.swift` → `ExpoAppDelegateSubscriberManager`), so this needs no
 AppDelegate patching — just the class name in `expo-module.config.json`.

 ⚠️ WHY THIS IS THE FAILURE CASE, NOT THE SUCCESS CASE. A save that worked is
 discoverable: the reel is in the library. A save that FAILED looked exactly like
 one that worked — the user was told "saving in the background", believed it, and
 found nothing later. That is the silent partial state the quality bar forbids.

 ⚠️ THE LIMIT, STATED HONESTLY. iOS does NOT relaunch an app the user
 force-quit. If they swipe Findable away, this callback waits until they next
 open it, and the receipt lands then. The upload itself is unaffected — the
 system owns it — so nothing is lost but the timing.

 ⚠️ FOURTH COPY OF THE WORDING, and the file that already names the problem is
 services/shareNotice.ts. JS, Kotlin, the extension's Swift and now this run in
 four processes, none of which can call the others. When the strings change they
 change in all four, in a native build.
 */
public class ShareResultSubscriber: ExpoAppDelegateSubscriber, URLSessionDataDelegate {
  /// Must match `appGroup` in ShareConfigModule.swift and `hostAppGroupIdentifier`
  /// in the generated extension controller.
  private static let appGroup = "group.com.savehere.app"
  /// The drawer receipts the app drains on foreground — see services/shareReceipts.ts.
  private static let pendingKey = "findablePendingShares"
  /// Matches the session id the extension mints in plugins/withInvisibleShareIOS.js.
  /// Anything else belongs to another library (expo-updates, Sentry) and is not ours.
  private static let sessionPrefix = "app.findable.share."
  /// The extension stashes the shared link under this + the session identifier, so
  /// a result can name the platform. The request body is a temp file the system
  /// consumed; by the time we run there is nothing else left to read the URL from.
  private static let linkPrefix = "findableShareLink."

  private let lock = NSLock()
  private var sessions: [String: URLSession] = [:]
  private var handlers: [String: () -> Void] = [:]
  private var bodies: [String: Data] = [:]

  public func application(
    _ application: UIApplication,
    handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void
  ) {
    /**
     ⚠️ THE HANDLER MUST BE CALLED EXACTLY ONCE, ON EVERY PATH.
     `ExpoAppDelegateSubscriberManager` counts the subscribers that respond to
     this selector and only calls the app's real handler when the LAST one
     reports back, so returning early without calling it strands every other
     subscriber's session too.

     ⚠️ AND THE AGGREGATE WILL NOT COMPLETE ANYWAY — DO NOT GO LOOKING FOR THAT
     BUG IN HERE. `expo-file-system` registers `FileSystemBackgroundSessionHandler`
     for the same selector, and it STORES the handler and only invokes it when a
     file-system session of that identifier finishes. For one of our share
     sessions that never happens, so the count never reaches zero and iOS's
     completion handler is never called. That is upstream's design, not ours; the
     only cost is a background-launch courtesy iOS mostly forgives, and the
     notification below does not depend on it.
     */
    guard identifier.hasPrefix(ShareResultSubscriber.sessionPrefix) else {
      completionHandler()
      return
    }

    lock.lock()
    handlers[identifier] = completionHandler
    bodies[identifier] = Data()
    if sessions[identifier] == nil {
      // Re-attaching means an identical configuration: same identifier, same
      // shared container, or the system hands us a different session and the
      // events we were woken for never arrive.
      let config = URLSessionConfiguration.background(withIdentifier: identifier)
      config.sharedContainerIdentifier = ShareResultSubscriber.appGroup
      sessions[identifier] = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }
    lock.unlock()

    // Safety net, the same reasoning as the extension's 1.5 s one: a session
    // with nothing left to report may never call urlSessionDidFinishEvents, and
    // an unanswered completion handler is a watchdog kill.
    DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in
      self?.finish(identifier)
    }
  }

  // MARK: - The upload's own result

  /// Upload tasks deliver the RESPONSE BODY through the data-task delegate —
  /// `URLSessionUploadTask` is a `URLSessionDataTask`. This is where the reel
  /// title comes from.
  public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard let id = session.configuration.identifier else { return }
    lock.lock()
    bodies[id, default: Data()].append(data)
    lock.unlock()
  }

  public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let id = session.configuration.identifier else { return }
    lock.lock()
    let body = bodies[id] ?? Data()
    lock.unlock()
    report(
      identifier: id,
      status: (task.response as? HTTPURLResponse)?.statusCode ?? 0,
      body: body,
      transportFailed: error != nil
    )
  }

  public func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    guard let id = session.configuration.identifier else { return }
    finish(id)
  }

  /// Answer iOS and let the session go. Idempotent — the safety net above and
  /// the real callback both land here.
  private func finish(_ identifier: String) {
    lock.lock()
    let handler = handlers.removeValue(forKey: identifier)
    let session = sessions.removeValue(forKey: identifier)
    bodies.removeValue(forKey: identifier)
    lock.unlock()
    // A session retains its delegate until invalidated, and an un-invalidated
    // background session stays registered with the system for the process's life.
    session?.finishTasksAndInvalidate()
    guard let handler = handler else { return }
    DispatchQueue.main.async { handler() }
  }

  // MARK: - Saying it

  private func report(identifier: String, status: Int, body: Data, transportFailed: Bool) {
    guard let defaults = UserDefaults(suiteName: ShareResultSubscriber.appGroup) else { return }

    let linkKey = ShareResultSubscriber.linkPrefix + identifier
    let link = defaults.string(forKey: linkKey) ?? ""
    defaults.removeObject(forKey: linkKey)
    let platform = platformLabel(link)

    let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
    // 409-style duplicates are still "it's in your library".
    let ok = !transportFailed && ((200...299).contains(status) || status == 409)

    let title: String
    let text: String
    if ok {
      title = "Saved to Findable"
      // ⚠️ `as? String` IS ALREADY NULL-SAFE HERE. JSONSerialization gives NSNull
      // for a JSON null and the cast fails, so the trap that shipped in 1.0.12 on
      // Android — optString returning the literal string "null", see jsonText in
      // plugins/android/ShareSave.kt — cannot happen in Swift.
      if let real = usableTitle(json?["title"] as? String ?? "") {
        text = "\u{201C}\(short(real))\u{201D} is in your library."
      } else {
        text = "Your \(platform) link is in your library. The summary is being written."
      }
    } else {
      title = "Couldn't save that \(platform) link"
      // The backend's `detail` is already plain English and tier-aware ("Your
      // library is full (50 saves). Delete a save to make room."), so it is
      // preferred over anything invented here.
      let detail = (json?["detail"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      let reason: String
      if !detail.isEmpty {
        reason = detail
      } else if transportFailed || status == 0 {
        reason = "No connection when it tried."
      } else {
        reason = "The server refused it (error \(status))."
      }
      // A server detail usually carries its own instruction; only add the retry
      // line when it does not.
      let tellsThemWhatToDo = reason.range(
        of: "delete|open findable|try|sign in|wait",
        options: [.regularExpression, .caseInsensitive]
      ) != nil
      text = tellsThemWhatToDo ? reason : reason + " Share it again to retry."
    }

    /**
     The drawer receipt goes in first and unconditionally, exactly as the
     extension does it: a user who denied notifications gets no banner, so this
     list is the only place the outcome is ever reported to them.

     ⚠️ THIS IS THE SECOND RECEIPT FOR ONE SHARE. The extension already wrote
     "Saving this one in the background…". Both are kept on purpose — if iOS
     defers this relaunch for hours (Low Power Mode, no network), the first
     receipt is the only record there is, and deleting it to keep the drawer tidy
     would trade a real record for a cosmetic one.
     */
    var pending = defaults.array(forKey: ShareResultSubscriber.pendingKey) as? [[String: Any]] ?? []
    pending.append([
      "title": title,
      "body": text,
      "at": Date().timeIntervalSince1970 * 1000,
    ])
    defaults.set(Array(pending.suffix(10)), forKey: ShareResultSubscriber.pendingKey)

    let center = UNUserNotificationCenter.current()
    center.getNotificationSettings { settings in
      guard settings.authorizationStatus == .authorized
        || settings.authorizationStatus == .provisional
      else { return }
      let content = UNMutableNotificationContent()
      content.title = title
      content.body = text
      content.sound = nil   // a save is not worth a noise
      center.add(
        UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil),
        withCompletionHandler: nil
      )
    }
  }

  /// ⚠️ THIRD... FOURTH COPY. See the note at the top of the file, and
  /// `platformLabel` in services/shareSave.ts, ShareSave.kt and the extension.
  private func platformLabel(_ url: String) -> String {
    let u = url.lowercased()
    if u.contains("youtube.com") || u.contains("youtu.be") { return "YouTube" }
    if u.contains("instagram.com") { return "Instagram" }
    if u.contains("facebook.com") || u.contains("fb.watch") || u.contains("fb.com") { return "Facebook" }
    if u.contains("tiktok.com") { return "TikTok" }
    if u.contains("threads.net") || u.contains("threads.com") { return "Threads" }
    if u.contains("linkedin.com") { return "LinkedIn" }
    return "the web"
  }

  /// ⚠️ A PLACEHOLDER IS NOT A TITLE. The backend writes "Instagram Reel" when
  /// it could not read the post; quoting that back claims a read that never
  /// happened. Mirrors `usableTitle` in services/shareNotice.ts.
  private func usableTitle(_ raw: String) -> String? {
    let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if t.isEmpty { return nil }
    let placeholder =
      "^(instagram|facebook|linkedin|tiktok|threads|youtube|web|unknown)\\s+(reel|post|video|short|link)s?$"
    if t.range(of: placeholder, options: [.regularExpression, .caseInsensitive]) != nil {
      return nil
    }
    return t
  }

  /// Cap a title so the notification body stays one readable line.
  private func short(_ t: String, _ max: Int = 70) -> String {
    if t.count <= max { return t }
    return String(t.prefix(max))
      .trimmingCharacters(in: CharacterSet(charactersIn: " ,;:.-")) + "\u{2026}"
  }
}
