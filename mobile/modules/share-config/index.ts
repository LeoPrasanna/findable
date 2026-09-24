import { NativeModule, requireOptionalNativeModule } from 'expo';

declare class ShareConfigNative extends NativeModule {
  set(json: string): boolean;
  clear(): boolean;
  takePending(): string;
}

/**
 * iOS only, and OPTIONAL on purpose.
 *
 * `requireOptionalNativeModule` rather than `requireNativeModule`: this ships
 * in a native build, and the app also runs on Android, on web, and — during
 * development — in bundles that predate this module. A missing native module
 * must degrade to "no invisible share", never to a crash on launch.
 */
const native = requireOptionalNativeModule<ShareConfigNative>('ShareConfig');

/** Hand the share key to the Share Extension. Returns false if it could not. */
export function setShareConfig(json: string): boolean {
  try {
    return native?.set(json) ?? false;
  } catch {
    return false;
  }
}

/** Revoke it locally on sign-out. */
export function clearShareConfig(): boolean {
  try {
    return native?.clear() ?? false;
  } catch {
    return false;
  }
}

/**
 * Receipts the Share Extension left behind, cleared as they are read.
 *
 * Returns [] on Android, on web, and on any build whose native module predates
 * `takePending` — `requireOptionalNativeModule` gives us an object without the
 * function there, so the call itself is guarded rather than the platform.
 */
export function takePendingShares(): { title: string; body: string; at: number }[] {
  try {
    const raw = native?.takePending?.();
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
