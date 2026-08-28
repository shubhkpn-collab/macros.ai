/**
 * TABLET DESIGN TOKENS.
 *
 * A 13.3" portrait panel viewed from two to four feet away, often by someone
 * with wet hands. Every value below exists because of that, not because of a
 * phone convention.
 *
 * Tokens are plain data so the palette can change later without touching a
 * single component.
 */
export const TOKEN_VERSION = 'tablet-tokens@1.0.0';

/** Deep neutral foundation, warm text, ONE restrained accent. */
export const color = {
  // Surfaces, darkest first. Depth comes from elevation, not from borders.
  surfaceBase: '#0E1113',
  surfaceRaised: '#171B1E',
  surfaceOverlay: '#1F2429',
  surfaceHairline: '#2A3036',

  // Warm off-white rather than pure white: less glare in a lit kitchen.
  textPrimary: '#F2EFE9',
  textSecondary: '#A8AFB5',
  textMuted: '#6E767D',

  /** The single energetic accent. Used sparingly, mostly for the primary act. */
  accent: '#7DD3A0',
  accentPressed: '#5FBB86',
  onAccent: '#0E1113',

  // Semantic roles. NEVER the sole carrier of meaning — see a11y below.
  deficit: '#7DD3A0',
  surplus: '#E8B54D',
  warning: '#E8B54D',
  danger: '#E2705F',
  offline: '#8C93A8',
} as const;

/** 4pt base. Generous by phone standards, correct at arm's length. */
export const space = {
  xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48, xxxl: 64,
} as const;

export const radius = { sm: 8, md: 16, lg: 24, pill: 999 } as const;

/**
 * Type scale. `hero` is the energy balance and is deliberately enormous — it
 * must be legible across a kitchen.
 */
export const type = {
  hero: { size: 96, weight: '700', tracking: -2 },
  display: { size: 56, weight: '600', tracking: -1 },
  title: { size: 32, weight: '600', tracking: 0 },
  body: { size: 22, weight: '400', tracking: 0 },
  label: { size: 18, weight: '500', tracking: 0.5 },
  caption: { size: 16, weight: '400', tracking: 0 },
} as const;

/**
 * Minimum 72pt targets: roughly double a phone's, sized for a fingertip that
 * may be wet, greasy or gloved.
 */
export const touch = { minTarget: 72, primaryHeight: 96, cardMinHeight: 120 } as const;

export const motion = {
  instant: 0, quick: 120, standard: 220, deliberate: 400,
  /** Voice presence breathes slowly; anything faster reads as urgency. */
  voicePulse: 1600,
} as const;

export const elevation = {
  flat: 0, raised: 2, floating: 8,
} as const;
