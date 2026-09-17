import { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, StyleSheet, Animated,
  KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import { Icon } from '../components/Icon';
import { api } from '../services/api';
import { fetchClientMetadata } from '../services/clientExtract';
import { getCachedUsage, refreshUsage } from '../services/usageCache';
import { resetsAtLabel } from '../services/quotaReset';
import * as haptics from '../services/haptics';
import { Pressable } from '../components/Pressable';
import { Label, Body, Title, Rule, Index, GhostButton, FilledButton } from '../components/kit';
import { colors, spacing, font, tracking, typeface, motion, themed } from '../constants/theme';

const STEPS = [
  { text: 'Checking the link' },
  { text: 'Saving your card' },
  { text: 'Handing off to the AI' },
] as const;

// Saves return in well under a second now (extraction runs in the background),
// so the arc is quick — the steps still get their moment without faking work.
const STEP_DELAYS = [0, 350, 800];
const N = STEPS.length;

const SAVE_NOTES = [
  'Public Reels, YouTube Shorts, TikToks, Threads & LinkedIn posts work best.',
  'Your card saves instantly — the title, thumbnail and AI summary fill in on their own right after.',
  "Private or login-only content (and most Facebook reels) can't be read — paste the post text into Notes and tap Re-summarize instead.",
  'Cooking and workout saves can become step-by-step recipes and guided plans.',
  'Everything is auto-categorized and searchable, so you can find any save in seconds.',
  'Summaries, recipes, workouts and questions share a daily AI limit that resets each day.',
  'Summaries are AI-made, so a small detail might slip — easy to edit anytime.',
  "We save the link and an AI summary for your personal reference — the content stays its creator's.",
];

function parseError(e: any): string {
  // api.ts already extracts FastAPI's `detail`, so e.message is the plain
  // human-readable string (was previously JSON here — the old JSON.parse made
  // this whole remap dead code, falling through to the raw detail).
  const detail: string = e?.message || '';
  if (e?.name === 'AbortError' || detail.includes('timed out'))
    return 'Request timed out. The server is taking too long — try again.';
  if (detail.includes('minutes long')) return detail;
  if (detail.includes('Could not extract')) return "Could not read this URL. Check it's a public Reel, Short, TikTok or Threads post and try again.";
  if (detail.includes('login') || detail.includes('private')) return 'This content is private or requires login. Findable can only save public content.';
  if (detail.includes('fetch') || detail.includes('Network'))
    return "Can't reach the server. Make sure the backend is running on port 8000.";
  return detail || 'Something went wrong. Try again.';
}

export default function SaveScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  /**
   * `url` arrives prefilled when the app was opened from the SHARE SHEET
   * (see ShareIntentHandler in app/_layout.tsx). Seeded as the initial state
   * rather than set in an effect, so the field is already filled on the first
   * frame — a share should land you on a ready-to-save screen, not on an empty
   * one that fills itself in a beat later.
   *
   * Deliberately NOT auto-submitting. A share is "I want to keep this", not
   * "spend an AI action now, unreviewed" — and the button is right there.
   */
  const { url: sharedUrl } = useLocalSearchParams<{ url?: string }>();
  const [url, setUrl] = useState(typeof sharedUrl === 'string' ? sharedUrl : '');
  const [loading, setLoading] = useState(false);
  const [stepIdx, setStepIdx] = useState(0);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');
  const [focused, setFocused] = useState(false);
  // null = don't know yet (or the check failed). Only a hard 0 shows the notice,
  // so a slow or broken usage call never invents a limit the user isn't at.
  const [aiRemaining, setAiRemaining] = useState<number | null>(
    () => getCachedUsage()?.remaining ?? null,
  );
  // Kept beside `aiRemaining` so the notice below re-renders with it. Reading
  // the cache inline during render would not re-run when the fetch lands.
  const [resetsAt, setResetsAt] = useState<string | null>(
    () => getCachedUsage()?.resets_at ?? null,
  );
  const aiExhausted = aiRemaining === 0;
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const pulse = useRef(new Animated.Value(1)).current;

  // Seeded from the login-time fetch, then refreshed. The seed matters here:
  // this drives the "you're out of AI actions for today" notice, and the whole
  // point of that notice is to be read BEFORE you paste — a warning that
  // arrives after you've already tapped Save has missed its moment.
  useEffect(() => {
    let alive = true;
    refreshUsage().then(u => {
      if (!alive || !u) return;
      setAiRemaining(u.remaining ?? null);
      setResetsAt(u.resets_at ?? null);
    });
    return () => { alive = false; };
  }, []);

  const inputRef = useRef<TextInput>(null);

  /**
   * TAPPING THE EMPTY FIELD PASTES (owner, 2026-08-12).
   *
   * This used to be a separate "Paste copied link" button under the box, which
   * nobody reads — the field is the thing that looks like where a link goes, so
   * the field is what people tap. Now the empty field IS the paste target and
   * says so in its own placeholder.
   *
   * It degrades to plain typing rather than trapping you: no URL on the
   * clipboard just focuses the input and opens the keyboard, so the box still
   * behaves like a box. The clipboard is only ever read inside this tap — a
   * real user gesture — so iOS raises no paste-permission prompt on open.
   */
  const tapField = async () => {
    try {
      const text = (await Clipboard.getStringAsync())?.trim();
      if (text && /^https?:\/\/\S+$/i.test(text)) {
        setUrl(text);
        setError('');
        haptics.success();
        return;
      }
    } catch {
      // Clipboard unreadable (permission denied, web without focus) — fall
      // through to typing rather than showing an error for a tap the user may
      // have meant as "let me type here".
    }
    inputRef.current?.focus();
  };

  // The one running animation on this screen: the active step's label breathes.
  // Opacity only — this direction's motion rule allows colour and opacity, and
  // nothing else. (The bouncing robot that used to live here was the single most
  // off-system element in the app.)
  useEffect(() => {
    if (!loading) return;
    const blink = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 0.4, duration: 600, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 1, duration: 600, useNativeDriver: true }),
    ]));
    blink.start();
    return () => { blink.stop(); };
  }, [loading]);

  const startStepTimers = () => {
    setStepIdx(0);
    STEP_DELAYS.forEach((delay, i) => {
      if (i === 0) return;
      timers.current.push(setTimeout(() => setStepIdx(i), delay));
    });
  };
  const clearStepTimers = () => { timers.current.forEach(clearTimeout); timers.current = []; };

  const handleSave = async () => {
    const trimmed = url.trim();
    if (!trimmed) { setError('Paste a URL first.'); return; }
    setLoading(true); setError(''); startStepTimers();
    try {
      // Kick the device-side metadata fetch off FIRST but don't await it here —
      // it runs alongside the save so the card still appears immediately. It only
      // matters for links our server's datacenter IP can't read (Instagram/
      // Facebook); the server discards it whenever its own extraction worked.
      const metaPromise = fetchClientMetadata(trimmed);

      const reel = await api.saveReel(trimmed);

      // Fire-and-forget: deliver the metadata once it lands. Failures are silent
      // by design — the save already succeeded and the server has its own path.
      metaPromise
        .then((meta) => (meta ? api.sendClientMetadata(reel.id, meta) : null))
        .catch(() => {});

      clearStepTimers();
      haptics.success();
      // A short success beat completes the sequence before the card opens —
      // feedback first, then navigation.
      setStepIdx(N - 1);
      setSuccess(true);
      setTimeout(() => router.replace(`/reel/${reel.id}`), 650);
    } catch (e: any) {
      clearStepTimers();
      haptics.error();
      setError(parseError(e));
      setLoading(false);
      setStepIdx(0);
    }
  };

  return (
    /* behavior="padding" on Android too — see the note in LoginScreen.tsx:
       edge-to-edge windows (Expo SDK 54+) never resize for the keyboard. */
    <KeyboardAvoidingView style={styles.container} behavior="padding">
      <ScrollView contentContainerStyle={styles.inner} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <Label wide>New save</Label>
        <Title style={styles.title}>Paste a link.</Title>
        <Label style={styles.hint}>YouTube · Instagram · TikTok · Threads · LinkedIn</Label>

        {/* Underlined field — the system defines inputs with the same 1px seam
            it uses for every other boundary. */}
        <View style={[styles.field, loading && styles.fieldOff]}>
          <TextInput
            ref={inputRef}
            style={styles.input}
            /* The placeholder is the instruction now — the old "https://…" told
               you the format nobody types by hand, not the action. */
            placeholder="Tap to paste the copied link"
            placeholderTextColor={colors.textTertiary}
            value={url}
            onChangeText={t => { setUrl(t); setError(''); }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            multiline
            editable={!loading}
          />
          {/* Transparent hit layer over the EMPTY field only. Deliberately not
              wired to the input's own onFocus: that would inject the clipboard
              at you every time you tried to type, which is the kind of helpful
              that becomes a fight. Once there is text the layer is gone and the
              field is an ordinary editable field again. */}
          {!loading && !url && (
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={tapField}
              accessibilityRole="button"
              accessibilityLabel="Tap to paste the copied link"
            />
          )}
          <View style={[styles.fieldRule, focused && styles.fieldRuleOn]} />
        </View>

        {/* Clearing is its own control — with tap-to-paste owning the empty
            field, there has to be a way back to empty that isn't backspace. */}
        {!loading && !!url && (
          <Pressable style={styles.paste} onPress={() => { haptics.tap(); setUrl(''); setError(''); }}>
            <Icon name="close" size={14} color={colors.textSecondary} />
            <Label tone="ink" wide>Clear</Label>
          </Pressable>
        )}

        {error ? (
          <View style={styles.errorBox}>
            <Icon name="alert-circle" size={15} color={colors.textPrimary} />
            <Body tone="primary" style={styles.errorText}>{error}</Body>
          </View>
        ) : null}

        {/* Out of AI actions — say so BEFORE the save, not after.
            ⚠️ Deliberately does NOT block saving. Saves are unrationed at every
            tier; only the AI is capped, and a user who understands that will
            still want the link kept. Blocking here would turn a soft limit into
            a hard one and lose the save entirely. Silent on a failed usage
            fetch: a wrong scare beats nothing, so we show nothing. */}
        {aiExhausted && !loading && (
          <View style={styles.quotaBox}>
            <Icon name="time" size={15} color={colors.textSecondary} />
            <Body style={styles.quotaText}>
              Today's AI actions are used up. This link will still be saved with its
              title and thumbnail — the summary, recipe and workout tools come back
              at {resetsAtLabel(resetsAt) || 'the daily reset'}.
            </Body>
          </View>
        )}

        {/* Progress — numbered rows, the same archival grammar as the rest of
            the app. A row is done, running, or waiting; the state is a word and
            a mark, never a colour. */}
        {loading && (
          <View style={styles.progress}>
            <Rule />
            {STEPS.map((step, i) => {
              const done = i < stepIdx || success;
              const active = i === stepIdx && !success;
              return (
                <View key={i}>
                  <View style={styles.stepRow}>
                    <Index n={i + 1} style={styles.stepIndex} />
                    <Animated.Text
                      style={[
                        styles.stepText,
                        (done || active) && styles.stepTextOn,
                        active && { opacity: pulse },
                      ]}
                    >
                      {step.text}
                    </Animated.Text>
                    {done
                      ? <Icon name="checkmark" size={14} color={colors.textPrimary} />
                      : <View style={[styles.stepMark, active && styles.stepMarkOn]} />}
                  </View>
                  <Rule />
                </View>
              );
            })}
            <Label style={styles.stepCount}>
              {success ? 'Saved — opening your card' : `Step ${stepIdx + 1} of ${N}`}
            </Label>
          </View>
        )}

        {!loading && (
          <View style={styles.notes}>
            <Label wide style={styles.notesTitle}>Good to know</Label>
            <Rule />
            {SAVE_NOTES.map((n, i) => (
              <View key={i}>
                <View style={styles.noteRow}>
                  <Index n={i + 1} style={styles.noteIndex} />
                  <Body style={styles.noteText}>{n}</Body>
                </View>
                <Rule />
              </View>
            ))}
          </View>
        )}

      </ScrollView>

      {/* ⚠️ PINNED, NOT AT THE END OF THE SCROLL.
          "Good to know" is eight paragraphs long, and with the button after it
          the primary action of the screen sat below the fold on a phone — you
          had to scroll past the small print to save anything. The notes scroll;
          the button does not move. */}
      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}>
        {loading ? (
          <GhostButton
            label={success ? 'Saved' : `Working  ${stepIdx + 1}/${N}`}
            disabled
          />
        ) : (
          <FilledButton
            label="Save & summarize"
            trailing="→"
            onPress={handleSave}
          />
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = themed(() => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  inner: { flexGrow: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.lg },

  title: { marginTop: spacing.sm },
  hint: { marginTop: spacing.sm },

  field: { marginTop: spacing.xl },
  fieldOff: { opacity: 0.4 },
  input: {
    color: colors.textPrimary,
    fontFamily: typeface.body,
    fontSize: font.lg,
    paddingVertical: spacing.sm,
    minHeight: 56,
    textAlignVertical: 'top',
  },
  fieldRule: { height: 1, backgroundColor: colors.ghostLine },
  fieldRuleOn: { backgroundColor: colors.textPrimary },

  paste: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    alignSelf: 'flex-start',
    paddingVertical: spacing.md,
  },

  errorBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.textPrimary,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  // Same shape as errorBox but a hairline, not a full-weight border: this is
  // information, not a failure, and it must not read louder than a real error.
  quotaBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.ghostLine,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  quotaText: { flex: 1 },
  errorText: { flex: 1, fontSize: font.sm, lineHeight: 20 },

  progress: { marginTop: spacing.xl },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md },
  stepIndex: { width: 22 },
  stepText: {
    flex: 1,
    color: colors.textTertiary,
    fontFamily: typeface.body,
    fontSize: font.md,
  },
  stepTextOn: { color: colors.textPrimary },
  stepMark: { width: 8, height: 8, borderWidth: 1, borderColor: colors.ghostLine },
  stepMarkOn: { borderColor: colors.textPrimary },
  stepCount: { marginTop: spacing.md },

  notes: { marginTop: spacing.xl },
  notesTitle: { marginBottom: spacing.sm },
  noteRow: { flexDirection: 'row', gap: spacing.md, paddingVertical: spacing.md },
  noteIndex: { width: 22, paddingTop: 3 },
  noteText: { flex: 1, fontSize: font.sm, lineHeight: 19 },

  footer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    backgroundColor: colors.background,
    borderTopWidth: 1,
    borderTopColor: colors.ghostLine,
  },
}));
