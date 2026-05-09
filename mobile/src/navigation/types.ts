/**
 * src/navigation/types.ts
 *
 * React Navigation type declarations for the full route tree.
 */

export type RootStackParamList = {
  // Bottom tabs
  Wallet: undefined;
  Mine: undefined;
  Governance: undefined;
  Oracle: undefined;

  // Modal / push screens
  Send: { token: 'TRC-G' | 'TRC-U'; address: string };
  Receive: { address: string };
  ScanQR: { onScan: (data: string) => void };
  Onboarding: undefined;
};
