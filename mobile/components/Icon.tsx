import { StyleProp, ViewStyle } from 'react-native';
import {
  Play, X, Sparkles, Tags, Tag, SquarePen, Zap, Dumbbell, UtensilsCrossed,
  List, ListChecks, Footprints, Info, ExternalLink, Trash2, Check, Copy,
  CircleAlert, CloudDownload, Link2, FileText, Hourglass, Clock, House,
  ArrowRight, Minus, Plus, Activity, Repeat, Lock, RefreshCw, Circle,
  ChefHat, Cpu, Flame, GraduationCap, Clapperboard, Shirt, Plane, Briefcase,
  Newspaper, HeartPulse, Wallet, Globe, ShoppingCart, ShoppingBag, CookingPot, Soup, Timer,
  BookOpen, Code, PenLine, Search, Phone, Target, Brain, Wrench, Palette, Leaf,
  PartyPopper, Eye, EyeOff, Scissors, Mail, KeyRound,
  Menu, UserRound, Settings, Bell, Download, LogIn, ChevronRight, Bookmark, Layers, Shield,
  MessageCircle, Compass, ArrowLeft, Send, Brush,
  Rocket, BicepsFlexed, PersonStanding, Trophy, ThumbsUp,
} from 'lucide-react-native';

// One icon family for the whole app (Lucide). Platform brand logos are the only
// exception — they stay on Ionicons because Lucide has no brand glyphs.
const MAP: Record<string, any> = {
  // ── UI ──
  play: Play, close: X, sparkles: Sparkles, pricetags: Tags, create: SquarePen,
  flash: Zap, list: List, checkbox: ListChecks, footsteps: Footprints,
  'information-circle': Info, 'open-outline': ExternalLink, 'trash-outline': Trash2,
  checkmark: Check, copy: Copy, 'alert-circle': CircleAlert, 'cloud-download': CloudDownload,
  link: Link2, 'document-text': FileText, hourglass: Hourglass, time: Clock,
  'time-outline': Clock, home: House, 'arrow-forward': ArrowRight, remove: Minus,
  add: Plus, repeat: Repeat, 'lock-closed': Lock, refresh: RefreshCw,
  restaurant: UtensilsCrossed, lock: Lock, eye: Eye, 'eye-off': EyeOff,
  mail: Mail, key: KeyRound, celebrate: PartyPopper,
  menu: Menu, user: UserRound, settings: Settings, bell: Bell, download: Download,
  login: LogIn, 'chevron-right': ChevronRight, bookmark: Bookmark, layers: Layers, shield: Shield,
  ask: MessageCircle, rediscover: Compass, back: ArrowLeft, send: Send,
  barbell: Dumbbell, 'barbell-outline': Dumbbell, trash: Trash2,
  search: Search, trophy: Trophy, flame: Flame, 'thumbs-up': ThumbsUp,

  // ── Categories ──
  // motivation is Rocket (not Flame) so it never collides with the 'cook' step icon.
  fitness: Dumbbell, cooking: ChefHat, tech: Cpu, motivation: Rocket,
  education: GraduationCap, entertainment: Clapperboard, fashion: Shirt,
  beauty: Brush, travel: Plane, business: Briefcase, news: Newspaper, health: HeartPulse,
  // `hobby` is Palette — crafts/music/painting/model-making. Deliberately not
  // Leaf (already gardening-flavoured elsewhere) and not Sparkles (taken by
  // `general`); a category bubble that duplicates another's glyph is unusable.
  // `shopping` is ShoppingBag, NOT ShoppingCart — the cart is already the
  // recipe step `gather` below, and the two render side by side on a cooking
  // save that was categorised as shopping.
  finance: Wallet, hobby: Palette, shopping: ShoppingBag, general: Sparkles, other: Tag, all: Globe,

  // ── Workout muscles / types ──
  strength: Dumbbell, cardio: HeartPulse, flexibility: Activity, fitness_repeat: Repeat,
  muscle: BicepsFlexed, body: PersonStanding,

  // ── Recipe / task step semantics ──
  gather: ShoppingCart, prep: Scissors, mix: CookingPot, cook: Flame, wait: Timer,
  season: Soup, serve: UtensilsCrossed, read: BookOpen, code: Code, write: PenLine,
  research: Search, money: Wallet, call: Phone, goal: Target, schedule: Clock,
  learn: Brain, build: Wrench, creative: Palette, exercise: Dumbbell, mindful: Leaf,
  analyze: Activity, shop: ShoppingCart,
};

// Maps the emoji characters our AI / data produce to the semantic icon keys above,
// so stored emojis render as matching line icons with no data migration.
const EMOJI: Record<string, string> = {
  '💪': 'exercise', '🍳': 'cooking', '💻': 'code', '🔥': 'cook', '📚': 'read',
  '🎬': 'entertainment', '👗': 'fashion', '✈️': 'travel', '💼': 'business',
  '📰': 'news', '🩺': 'health', '💰': 'money', '✨': 'sparkles', '✅': 'checkmark',
  '🛒': 'gather', '🔪': 'prep', '🥣': 'mix', '⏲️': 'wait', '🧂': 'season',
  '🍽️': 'serve', '📝': 'write', '🔍': 'research', '📞': 'call', '🎯': 'goal',
  '⏰': 'schedule', '🧠': 'learn', '🔧': 'build', '🎨': 'creative', '🧘': 'mindful',
  '📊': 'analyze', '🎉': 'celebrate', '🔒': 'lock', '👁️': 'eye', '🏋️': 'exercise',
};

function resolve(name: string): any {
  if (MAP[name]) return MAP[name];
  const stripped = (name || '').replace(/️/g, ''); // drop emoji variation selector
  const key = EMOJI[name] || EMOJI[stripped];
  return (key && MAP[key]) || Circle;
}

interface Props {
  name: string;
  size?: number;
  color?: string;
  strokeWidth?: number;
  /** Fill the glyph's interior (e.g. active tab/chip states). Works best on
      simple solid shapes — Bookmark, Flame, Play — not detailed line icons. */
  fill?: string;
  /** Bump stroke weight for selected/active states without hand-tuning sizes. */
  emphasis?: boolean;
  style?: StyleProp<ViewStyle>;
}

// Optical stroke correction: tiny icons need a slightly heavier stroke to stay
// legible, large ones a lighter stroke to stay elegant. Explicit prop wins.
//
// ⚠️ Thinned across the board (was 2.4/2/1.75) to match the type. This system
// runs its display face at weight 300 and refuses to bold anything; a 2px icon
// stroke beside 300-weight text is the heaviest mark on the screen and reads as
// a different design. mono's rule: "icons are minimalist, outlined,
// monochromatic, with a fine stroke weight."
function strokeFor(size: number): number {
  if (size <= 13) return 1.6;
  if (size >= 28) return 1.1;
  return 1.35;
}

export function Icon({ name, size = 18, color = '#FFF', strokeWidth, fill = 'none', emphasis = false, style }: Props) {
  const C = resolve(name);
  const stroke = strokeWidth ?? (strokeFor(size) + (emphasis ? 0.4 : 0));
  return <C size={size} color={color} strokeWidth={stroke} fill={fill} style={style} />;
}
