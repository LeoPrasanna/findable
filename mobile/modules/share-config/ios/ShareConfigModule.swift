import ExpoModulesCore

/**
 The ONE thing the iOS Share Extension cannot get for itself.

 An extension is a separate process with its own container, so it cannot read
 the app's AsyncStorage — which is where Android's invisible share reads the
 same credential from (see mobile/services/shareKey.ts). The App Group is the
 only shared surface the two processes have, and nothing in the project could
 write to it: expo-share-intent's module reads and clears that suite but exposes
 no writer.

 That is all this module is. One function, one key, no state.

 ⚠️ The value is a save-scoped share key, NOT a Supabase session. It can create
 a saved link and nothing else — no read, no delete, no AI action, no account
 access (backend/app/sharekey.py proves that by routing table). Do not be
 tempted to put the access token here instead: the reasoning against it is in
 shareKey.ts and it has not changed.
 */
public class ShareConfigModule: Module {
  /// Must match `hostAppGroupIdentifier` in the generated ShareExtensionViewController
  /// and the app-group entitlement in app.json. expo-share-intent derives it as
  /// "group.<bundleIdentifier>".
  private static let appGroup = "group.com.savehere.app"

  /// Read back by the extension. Deliberately not the key expo-share-intent
  /// uses for the shared payload ("savehereShareKey") — different data, and a
  /// collision would silently break the share itself.
  private static let configKey = "findableShareConfig"

  /// Written by the Share Extension, read exactly once by the app.
  ///
  /// The extension is dead by the time anyone could look at its work, so it
  /// leaves a receipt here instead. The app drains these into the notification
  /// drawer on its next foreground — see services/shareReceipts.ts. Shape is
  /// [{ title, body, at }], and it is a CONTRACT with the Swift in
  /// plugins/withInvisibleShareIOS.js.
  private static let pendingKey = "findablePendingShares"

  public func definition() -> ModuleDefinition {
    Name("ShareConfig")

    // Synchronous on purpose: it is a single small UserDefaults write, and
    // making it async would only add a promise for the caller to forget.
    Function("set") { (json: String) -> Bool in
      guard let defaults = UserDefaults(suiteName: ShareConfigModule.appGroup) else {
        return false
      }
      defaults.set(json, forKey: ShareConfigModule.configKey)
      return true
    }

    Function("clear") { () -> Bool in
      guard let defaults = UserDefaults(suiteName: ShareConfigModule.appGroup) else {
        return false
      }
      defaults.removeObject(forKey: ShareConfigModule.configKey)
      return true
    }

    /// Hand over every receipt the Share Extension left, and clear them.
    ///
    /// ⚠️ TAKE, NOT READ. Clearing in the same call is what stops the same save
    /// being reported on every foreground for the rest of the install. The cost
    /// of that choice is that a receipt lost between here and the drawer write
    /// is lost for good — acceptable, because the drawer is a convenience and
    /// the library is the record.
    ///
    /// Returns JSON rather than an array of dictionaries: Expo's bridge would
    /// need a typed Record for the latter, and this shape is already defined by
    /// the Swift that writes it. One `JSON.parse` on the other side is cheaper
    /// than two type declarations that can disagree.
    Function("takePending") { () -> String in
      guard let defaults = UserDefaults(suiteName: ShareConfigModule.appGroup),
        let raw = defaults.array(forKey: ShareConfigModule.pendingKey),
        !raw.isEmpty,
        let data = try? JSONSerialization.data(withJSONObject: raw),
        let json = String(data: data, encoding: .utf8)
      else { return "[]" }
      defaults.removeObject(forKey: ShareConfigModule.pendingKey)
      return json
    }
  }
}
