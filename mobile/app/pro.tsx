import { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator, Platform, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';
import { Icon } from '../components/Icon';
import { Pressable } from '../components/Pressable';
import { Label, Body, Title, Rule, Index, FilledButton, TextAction } from '../components/kit';
import * as haptics from '../services/haptics';
import * as billing from '../services/billing';
import { packageFor, storeTerms, syncVerdict, type StorePackage } from '../services/billingPlans';
import { api } from '../services/api';
import { supabase } from '../services/supabase';
import { refreshUsage } from '../services/usageCache';
import { PRIVACY_URL, TERMS_URL } from '../constants/links';
import { pricingForDevice, savingPct, money, renewalTerms, PRO_BENEFITS, Plan } from '../constants/pricing';
import { colors, spacing, font, radius, tracking, typeface, themed } from '../constants/theme';

/**
 * The Pro paywall. One page: what you get, what it costs, and the system
 * purchase sheet.
 *
 * ⚠️ THE MOCK CARD FORM IS GONE AND MUST NOT COME BACK. This screen used to have
 * a second page with card number / expiry / CVC fields behind a TEST MODE banner,
 * because there was no payment provider. Two reasons it is deleted rather than
 * kept as a fallback: (1) a form that looks real and does nothing is how a real
 * person ends up typing a real card number into a dead field, and no banner is
 * reliably louder than muscle memory; (2) there is nothing for it to do — digital
 * goods go through StoreKit / Play Billing, Apple and Google take their cut, and a
 * card form would be rejected at review. When billing is unavailable this screen
 * says so in a sentence instead.
 *
 * ⚠️ THE STORE OWNS THE PRICE. `constants/pricing.ts` is the authored fallback and
 * the source of the sales copy, but the moment RevenueCat returns an offering the
 * displayed price comes from the STORE — `product.priceString`. The authored
 * numbers are chosen by DEVICE LOCALE while Apple and Google charge by the
 * ACCOUNT'S STOREFRONT, so an Indian phone signed into a US App Store is shown ₹99
 * and billed $7. That is a refund request and a review rejection.
 *
 * ⚠️ THE TIER COMES FROM THE SERVER. A successful purchase is not an entitlement:
 * the app calls `/api/billing/sync`, which asks RevenueCat server-to-server and
 * stamps `app_metadata.tier` — then refreshes the Supabase session so the new JWT
 * claim is what `entitlements.py` reads. Trusting `customerInfo` on the client
 * would make Pro a thing you could grant yourself.
 */
export default function ProScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const pricing = pricingForDevice();
  const saving = savingPct(pricing);

  const [planId, setPlanId] = useState<Plan['id']>('monthly');
  const [busy, setBusy] = useState(false);
  /** Store packages: `undefined` while asking, `null` when there is nothing to sell. */
  const [pkgs, setPkgs] = useState<StorePackage[] | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    billing.packages()
      .then(p => { if (alive) setPkgs(p); })
      .catch(() => { if (alive) setPkgs(null); });
    return () => { alive = false; };
  }, []);

  const plan = pricing.plans.find(p => p.id === planId)!;
  const pkg = pkgs ? packageFor(pkgs, planId) : null;
  /** Whether this build can actually take money for the selected plan. */
  const live = !!pkg;

  /** The store's price for a plan when it has one, else the authored number. */
  const priceOf = (p: Plan) => {
    const sp = pkgs ? packageFor(pkgs, p.id) : null;
    return sp?.product?.priceString ?? money(pricing, p.price);
  };
  const terms = (pkg && storeTerms(pkg, planId)) || renewalTerms(pricing, plan);

  const close = () => { haptics.tap(); router.back(); };

  const tell = (title: string, msg: string) => {
    if (Platform.OS === 'web') window.alert(`${title}\n\n${msg}`);
    else Alert.alert(title, msg);
  };

  /**
   * Apply a completed purchase or restore.
   *
   * ⚠️ IT READS THE SYNC RESPONSE NOW. It used to call `/sync`, throw the body
   * away and show "You're on Pro" on any 2xx — but `{tier: null, active: false}`
   * is a perfectly successful answer meaning "RevenueCat has never heard of you".
   * So Restore, with nothing to restore, congratulated people on a subscription
   * they did not have. The branch table lives in `syncVerdict` with its own
   * tests; this function only picks the sentence.
   *
   * ⚠️ `paid` SEPARATES THE TWO PATHS AND IS NOT COSMETIC. After a purchase the
   * money is already gone — "not applied yet" must never read as "it failed", and
   * the webhook finishes the job within the hour. After a restore nothing was
   * charged, so every sentence about a payment is simply untrue.
   */
  const apply = async (paid: boolean) => {
    // null means the call FAILED, which is not the same as the server saying no.
    let active: boolean | null = null;
    try {
      ({ active } = await api.syncBilling());
      // Re-mint the JWT so the new app_metadata.tier claim is in hand — the
      // claim is what the server reads, not the Supabase user row.
      await supabase.auth.refreshSession();
      await refreshUsage();
    } catch {
      // Swallowed on purpose: `active` stays null and the verdict handles it.
    }

    const verdict = syncVerdict(paid, active);
    if (verdict === 'pro') {
      haptics.success();
      tell('You’re on Pro', 'Everything is unlocked. Thanks for backing Findable.');
    } else if (verdict === 'pending') {
      haptics.success();
      tell(
        'Payment received',
        'Your purchase went through. It can take up to an hour to appear — reopen the app if it has not by then, and nothing is lost either way.',
      );
    } else if (verdict === 'none') {
      haptics.tap();
      tell(
        'Nothing to restore',
        'This account has no active Findable subscription. If you subscribed with a different Apple ID or Google account, sign in to that one and restore from there.',
      );
    } else {
      haptics.error();
      tell(
        'Couldn’t check',
        'We could not reach Findable to look up your subscription. Nothing was charged — try again in a moment.',
      );
    }

    // ⚠️ ONLY LEAVE IF SOMETHING HAPPENED. Closing the paywall after "nothing to
    // restore" takes away the screen they still need; the old code dismissed it
    // unconditionally because every outcome was treated as success.
    if (verdict === 'pro' || verdict === 'pending') router.back();
  };

  const buy = async () => {
    haptics.tap();
    setBusy(true);
    const out = await billing.purchase(planId);
    setBusy(false);
    // ⚠️ A CANCELLED PURCHASE SHOWS NOTHING. Tapping the system sheet away is a
    // decision, not a failure, and "Purchase failed" reads as *we* broke it.
    if (out.status === 'cancelled') return;
    if (out.status === 'unavailable') return tell('Not available yet', UNAVAILABLE);
    if (out.status === 'error') { haptics.error(); return tell('Nothing was charged', out.message); }
    await apply(true);
  };

  const restore = async () => {
    haptics.tap();
    setBusy(true);
    const out = await billing.restore();
    setBusy(false);
    if (out.status === 'cancelled') return;
    if (out.status === 'unavailable') return tell('Not available yet', UNAVAILABLE);
    if (out.status === 'error') { haptics.error(); return tell("Couldn't restore", out.message); }
    await apply(false);
  };

  const open = (url: string) => { haptics.tap(); WebBrowser.openBrowserAsync(url); };

  return (
    <View style={styles.screen}>
      <View style={[styles.top, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={close} hitSlop={12} style={styles.topBtn}>
          <Icon name="close" size={20} color={colors.textPrimary} />
        </Pressable>
      </View>
      <Rule />

      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: spacing.lg }]}
        showsVerticalScrollIndicator={false}
      >
        <Label wide style={styles.eyebrow}>Findable Pro</Label>
        <Title style={styles.hero}>Everything you save,{'\n'}actually working for you.</Title>
        <Body style={styles.lede}>
          The free tier keeps your links safe. Pro is what turns them into something you use.
        </Body>

        <View style={styles.benefits}>
          <Rule />
          {PRO_BENEFITS.map((b, i) => (
            <View key={b.title} style={styles.benefit}>
              <Index n={i + 1} style={styles.benefitIndex} />
              <View style={styles.benefitText}>
                <Text style={styles.benefitTitle}>{b.title}</Text>
                <Body style={styles.benefitDetail}>{b.detail}</Body>
              </View>
            </View>
          ))}
        </View>
      </ScrollView>

      {/* ⚠️ PLAN + PRICE ARE PINNED, NOT AT THE END OF THE SCROLL.
          Five benefit paragraphs sat above this, so on a phone the price and the
          button were both below the fold — a paywall where you cannot see what it
          costs without scrolling past the sales pitch. The benefits scroll; what
          you are being asked to pay does not move. */}
      <View style={[styles.dock, { paddingBottom: insets.bottom + spacing.md }]}>
        {/* ⚠️ COMPACT, AND A ROW. These were two stacked full-width cards with
            display-size prices; the dock ate roughly half the screen (owner).
            Side by side at body size it is about a quarter. */}
        <Label wide style={styles.pickHead}>Choose a plan</Label>
        <View style={styles.plans}>
          {pricing.plans.map(p => {
            const on = p.id === planId;
            return (
              <Pressable
                key={p.id}
                onPress={() => { haptics.tap(); setPlanId(p.id); }}
                style={[styles.plan, on && styles.planOn]}
                accessibilityLabel={`${p.period}, ${priceOf(p)}`}
              >
                <Label tone={on ? 'ink' : 'muted'} wide numberOfLines={1}>{p.period}</Label>
                <View style={styles.planPriceRow}>
                  <Text style={[styles.planPrice, on && styles.planPriceOn]}>
                    {priceOf(p)}
                  </Text>
                  {!live && p.wasPrice != null && (
                    <Text style={styles.planWas}>{money(pricing, p.wasPrice)}</Text>
                  )}
                </View>
                {/* Only rendered when the maths actually supports it — see
                    savingPct() in constants/pricing.ts. */}
                <Label numberOfLines={1}>
                  {p.id === 'monthly' && saving !== null ? `Save ${saving}%` : p.note}
                </Label>
              </Pressable>
            );
          })}
        </View>

        {busy ? (
          <View style={styles.busy}><ActivityIndicator color={colors.textPrimary} /></View>
        ) : (
          <FilledButton
            label={live ? `Subscribe · ${priceOf(plan)}` : 'Continue'}
            trailing={live ? undefined : '→'}
            onPress={live ? buy : () => tell('Not available yet', UNAVAILABLE)}
            style={styles.cta}
          />
        )}

        <View style={styles.footLinks}>
          <TextAction label="Restore purchases" onPress={restore} />
          <TextAction label="Terms" onPress={() => open(TERMS_URL)} />
          <TextAction label="Privacy" onPress={() => open(PRIVACY_URL)} />
        </View>

        {/* ⚠️ "Prices in INR/USD" ONLY WHEN THE STORE IS NOT THE SOURCE. The
            authored prices are picked by device locale and the currency has to be
            stated; a store priceString already carries its own currency, and
            naming a second one next to it is how you contradict yourself. */}
        <Text style={styles.terms}>
          No commitment. Cancel anytime. {terms}{live ? '' : ` Prices in ${pricing.code}.`}
        </Text>

        {/* The honest replacement for the old TEST MODE banner: no fake form,
            one sentence, only when there is genuinely nothing to buy. */}
        {pkgs === null && (
          <Text style={styles.unavailable}>{UNAVAILABLE}</Text>
        )}
      </View>
    </View>
  );
}

/** Said in two places, so it is written once. */
const UNAVAILABLE =
  Platform.OS === 'web'
    ? 'Subscriptions are purchased in the Findable app on your phone — the App Store and Google Play handle the payment.'
    : 'Subscriptions are not switched on in this build yet. Nothing was charged.';

const styles = themed(() => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },

  top: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  topBtn: { padding: spacing.xs, marginLeft: -spacing.xs },

  body: { paddingHorizontal: spacing.lg, paddingTop: spacing.xl, flexGrow: 1 },
  // The pinned bottom section. Keeps price + CTA on screen while the sales copy
  // scrolls behind it.
  dock: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    backgroundColor: colors.background,
    borderTopWidth: 1,
    borderTopColor: colors.ghostLine,
  },
  eyebrow: { marginBottom: spacing.md },
  hero: { marginBottom: spacing.md },
  lede: { marginBottom: spacing.xl },

  benefits: { marginBottom: spacing.xl },
  benefit: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  benefitIndex: { paddingTop: 3, width: 22 },
  benefitText: { flex: 1, minWidth: 0, gap: spacing.xs },
  benefitTitle: {
    color: colors.textPrimary,
    fontFamily: typeface.display,
    fontSize: font.lg,
    letterSpacing: tracking.heading,
  },
  benefitDetail: { fontSize: font.sm, lineHeight: 20 },

  pickHead: { marginBottom: spacing.sm },
  plans: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  // Selection reads by BORDER WEIGHT, not fill or hue — the system has no
  // second colour to spend and a filled card would out-shout the CTA.
  plan: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.ghostLine,
    borderRadius: radius.md,
    padding: spacing.sm + 2,
    gap: 2,
  },
  planOn: { borderColor: colors.textPrimary },
  planPriceRow: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
  planPrice: {
    color: colors.textSecondary,
    fontFamily: typeface.display,
    fontSize: font.xl,
    letterSpacing: tracking.heading,
  },
  planPriceOn: { color: colors.textPrimary },
  planWas: {
    color: colors.textTertiary,
    fontFamily: typeface.body,
    fontSize: font.sm,
    textDecorationLine: 'line-through',
  },

  busy: { marginTop: spacing.md, paddingVertical: spacing.md, alignItems: 'center' },
  cta: { marginTop: spacing.sm },
  footLinks: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing.lg,
    marginTop: spacing.lg,
  },
  terms: {
    color: colors.textTertiary,
    fontFamily: typeface.body,
    fontSize: 11,
    lineHeight: 16,
    textAlign: 'center',
    marginTop: spacing.md,
  },
  unavailable: {
    color: colors.textSecondary,
    fontFamily: typeface.body,
    fontSize: font.xs,
    lineHeight: 16,
    textAlign: 'center',
    marginTop: spacing.sm,
  },
}));
