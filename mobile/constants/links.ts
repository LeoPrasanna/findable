// Outbound legal / store links. One place, because App Store Connect asks for
// the same Support, Privacy and Terms URLs in app metadata — they must match
// what the app shows, and all three must be live before submission.
//
// The pages are in this repo under `site/` and publish to GitHub Pages via
// .github/workflows/pages.yml. Swap the base below for a custom domain later;
// nothing else changes.
//
// ⚠️ The path is `/findable` because that is the REPO name — GitHub Pages derives
// the URL from the repo, not from the product. The repo was renamed from
// `savehere` on 2026-09-13 and the OLD PAGES URL DIES WITH THE RENAME (GitHub
// redirects repo and clone URLs; it does not redirect a project Pages path).
// Nothing had been pasted into App Store Connect yet, which is the only reason
// this was free. It will not be free a second time.
//
// ⚠️ SUPPORT_EMAIL is NOT here — it lives in `app/support.tsx`, which is the one
// place it is written down. Two copies of a support address is how you end up
// publishing one nobody reads.
//
// Apple's own pages cover ONLY billing (cancel a subscription, request a refund)
// — those two are genuinely Apple's job. Everything about Findable itself has to
// come from us; pointing App Review at apple.com/support is a Guideline 1.5
// rejection.

const SITE = 'https://leoprasanna.github.io/findable';

export const SUPPORT_URL = `${SITE}/`;
export const PRIVACY_URL = `${SITE}/privacy.html`;
export const TERMS_URL = `${SITE}/terms.html`;

/** Apple-hosted. Deep-links to the user's own subscription list. */
export const APPLE_SUBSCRIPTIONS_URL = 'https://apps.apple.com/account/subscriptions';
/** Apple-hosted. Refunds for IAP go through Apple — we cannot issue them. */
export const APPLE_REFUNDS_URL = 'https://reportaproblem.apple.com';
/** Play-hosted, the Android half of the same two rows. */
export const PLAY_SUBSCRIPTIONS_URL = 'https://play.google.com/store/account/subscriptions';
