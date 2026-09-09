/**
 * TABLET DESIGN TOKENS — the single presentation authority.
 *
 * A 13.3" portrait panel read from two to four feet away, in a kitchen, often
 * by someone with wet hands. Every value below follows from that, not from
 * phone convention: this is an appliance surface, so nothing here should read
 * as Material, as a mobile app, or as a dashboard.
 *
 * Components must take visual constants from here rather than inventing their
 * own, so the whole product can be re-themed without touching a screen.
 */
export const TOKEN_VERSION = 'tablet-tokens@2.0.0';

/**
 * Deep charcoal canvas, warm off-white text, ONE restrained green accent.
 * Amber and red are reserved strictly for warning and failure — spending them
 * anywhere else would make a real problem unremarkable.
 */
export const color = {
  /** The appliance canvas. Near-black, slightly warm, never pure #000. */
  canvas: '#0C0F11',
  /** Raised content: heroes, cards, fields. */
  surface: '#15191C',
  /** Secondary surface for nested or quieter blocks. */
  surfaceMuted: '#1D2226',
  /** Pressed/active fill. */
  surfaceActive: '#252B30',
  /** Hairline borders and dividers. */
  border: '#2A3137',
  borderStrong: '#3A424A',

  textPrimary: '#F4F1EB',
  textSecondary: '#A6ADB4',
  textMuted: '#6B747C',
  textDisabled: '#4A5158',

  /** Fresh, restrained green. Positive, active, ready — never decorative. */
  accent: '#79D4A0',
  accentPressed: '#5CBB86',
  accentMuted: '#2A4438',
  onAccent: '#0C0F11',

  warning: '#E3B155',
  danger: '#DE6D5C',
  offline: '#8A919E',

  surfaceDisabled: '#1A1E22',

  /** Energy semantics. Deficit reads as the accent; surplus as warning amber. */
  deficit: '#79D4A0',
  surplus: '#E3B155',
  neutral: '#A6ADB4',

  /**
   * MACRO IDENTITY. Per the approved reference, each macro ring carries its own
   * hue so the three read apart at a glance across a kitchen.
   *
   * Deliberately separate from `warning`/`danger` above: amber there means
   * something is wrong, whereas amber here simply means fat. Reusing the status
   * colours would have made a normal ring look like an alert.
   */
  macroProtein: '#6E9BE8',
  macroFat: '#D89A4E',
  macroCarbs: '#4FBFA8',

  /**
   * ORB SPECTRUM. The reference orb is a prismatic ring, not a bordered circle.
   * These are the halo stops; they are decoration only and never encode state
   * on their own — intensity and motion do that.
   */
  orbSpectrumA: '#7FD8FF',
  orbSpectrumB: '#8FA2FF',
  orbSpectrumC: '#C78BFF',
  orbSpectrumD: '#FF9BD2',
} as const;

/** 4pt base. Generous by phone standards; correct at arm's length. */
export const space = {
  xxs: 4, xs: 8, sm: 12, md: 16, lg: 24, xl: 32, xxl: 48, xxxl: 64, huge: 96,
} as const;

export const radius = { sm: 10, md: 16, lg: 24, xl: 32, pill: 999 } as const;

/**
 * Type scale. `energyHero` is the north-star number and is deliberately
 * enormous — it must be readable across a kitchen without walking over.
 */
export const type = {
  productLabel: { size: 20, weight: '600' as const, tracking: 3 },
  screenTitle: { size: 44, weight: '600' as const, tracking: -0.5 },
  sectionLabel: { size: 17, weight: '600' as const, tracking: 1.6 },
  body: { size: 22, weight: '400' as const, tracking: 0 },
  metric: { size: 40, weight: '600' as const, tracking: -0.5 },
  macroMetric: { size: 46, weight: '600' as const, tracking: -1 },
  energyHero: { size: 116, weight: '700' as const, tracking: -4 },
  button: { size: 26, weight: '600' as const, tracking: 0.2 },
  caption: { size: 17, weight: '400' as const, tracking: 0 },
} as const;

/** 72dp minimum: roughly double a phone's, sized for a wet or gloved fingertip. */
export const touch = {
  minTarget: 72,
  primaryHeight: 96,
  secondaryHeight: 76,
  fieldHeight: 96,
  cardMinHeight: 132,
} as const;

export const motion = {
  fast: 120,
  normal: 220,
  confirmation: 420,
  /** Voice presence breathes slowly; faster reads as urgency. */
  voicePulse: 1800,
} as const;

/** Soft depth. Restrained — an appliance should not look like floating cards. */
export const elevation = {
  flat: { elevation: 0 },
  raised: { elevation: 2, shadowOpacity: 0.18, shadowRadius: 12,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 } },
  hero: { elevation: 6, shadowOpacity: 0.28, shadowRadius: 28,
    shadowColor: '#000', shadowOffset: { width: 0, height: 10 } },
} as const;

/** Opacity for disabled affordances that must still look intentional. */
export const opacity = { disabled: 0.42, subtle: 0.7 } as const;
