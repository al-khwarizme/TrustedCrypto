/**
 * src/theme/index.ts
 *
 * TrustedCrypto design system.
 * Colours inspired by gold, earth, and trust.
 */

export const Colors = {
  // Brand
  gold: '#C9973A',
  goldLight: '#F0D080',
  goldDark: '#8A6520',

  // Utility token
  utility: '#3A7CC9',
  utilityLight: '#80B4F0',

  // Backgrounds
  background: '#0E0E12',
  surface: '#1A1A22',
  surfaceAlt: '#22222E',
  border: '#2E2E3E',

  // Text
  textPrimary: '#F5F0E8',
  textSecondary: '#9090A0',
  textMuted: '#5A5A6A',

  // Status
  success: '#3AC97C',
  warning: '#C9A03A',
  error: '#C93A3A',

  // Charts / contribution types
  nodeUptime: '#3A7CC9',
  oracleData: '#C9973A',
  governanceVote: '#7C3AC9',
  physicalVerification: '#3AC97C',
  transactionActivity: '#C93A7C',
} as const;

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const Radius = {
  sm: 6,
  md: 12,
  lg: 20,
  full: 999,
} as const;

export const Typography = {
  heading1: { fontSize: 28, fontWeight: '700' as const, letterSpacing: -0.5 },
  heading2: { fontSize: 22, fontWeight: '700' as const },
  heading3: { fontSize: 18, fontWeight: '600' as const },
  body: { fontSize: 15, fontWeight: '400' as const },
  bodySmall: { fontSize: 13, fontWeight: '400' as const },
  caption: { fontSize: 11, fontWeight: '400' as const },
  mono: { fontSize: 13, fontFamily: 'Courier' },
} as const;
