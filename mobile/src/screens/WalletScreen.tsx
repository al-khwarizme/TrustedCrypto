/**
 * src/screens/WalletScreen.tsx
 *
 * Main wallet view:
 *   - TRC-G balance with live gold price
 *   - TRC-U balance
 *   - Wallet-cap progress bar
 *   - Quick Send / Receive buttons
 *   - Recent transaction list
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { getWalletState } from '../services/node';
import { formatToken, formatUsd, shortAddress } from '../utils/format';
import { Colors, Radius, Spacing, Typography } from '../theme';
import type { WalletState } from '../types';
import { WEI } from '../constants';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Wallet'>;
  address: string;
};

export default function WalletScreen({ navigation, address }: Props) {
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const state = await getWalletState(address);
      setWallet(state);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load wallet');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [address]);

  useEffect(() => {
    void load();
    const interval = setInterval(() => void load(), 30_000);
    return () => clearInterval(interval);
  }, [load]);

  const onRefresh = () => {
    setRefreshing(true);
    void load();
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={Colors.gold} size="large" />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.gold} />}
        contentContainerStyle={styles.scroll}
      >
        {/* Address chip */}
        <View style={styles.addressRow}>
          <Text style={styles.addressLabel}>My Wallet</Text>
          <Text style={styles.address}>{shortAddress(address)}</Text>
        </View>

        {/* TRC-G card */}
        <BalanceCard
          label="TRC-G"
          sublabel="Gold-backed"
          amount={wallet?.trcG.amount ?? 0n}
          usdValue={
            wallet
              ? (wallet.trcG.amount * BigInt(Math.round(wallet.goldUsdPrice * 100))) /
                (WEI * 100n)
              : 0n
          }
          capRemaining={wallet?.trcG.capRemaining ?? 0n}
          accentColor={Colors.gold}
          onPress={() => navigation.navigate('Send', { token: 'TRC-G', address })}
        />

        {/* TRC-U card */}
        <BalanceCard
          label="TRC-U"
          sublabel="Utility / Mining"
          amount={wallet?.trcU.amount ?? 0n}
          capRemaining={wallet?.trcU.capRemaining ?? 0n}
          accentColor={Colors.utility}
          onPress={() => navigation.navigate('Send', { token: 'TRC-U', address })}
        />

        {/* Action buttons */}
        <View style={styles.actions}>
          <ActionButton
            label="Send"
            color={Colors.gold}
            onPress={() => navigation.navigate('Send', { token: 'TRC-G', address })}
          />
          <ActionButton
            label="Receive"
            color={Colors.utility}
            onPress={() => navigation.navigate('Receive', { address })}
          />
        </View>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        {/* Oracle price strip */}
        {wallet && (
          <View style={styles.priceStrip}>
            <Text style={styles.priceStripLabel}>Gold price</Text>
            <Text style={styles.priceStripValue}>
              {wallet.goldUsdPrice > 0 ? `$${wallet.goldUsdPrice.toFixed(2)} / troy oz` : '—'}
            </Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

interface BalanceCardProps {
  label: string;
  sublabel: string;
  amount: bigint;
  usdValue?: bigint;
  capRemaining: bigint;
  accentColor: string;
  onPress: () => void;
}

function BalanceCard({ label, sublabel, amount, usdValue, capRemaining, accentColor, onPress }: BalanceCardProps) {
  const total = amount + capRemaining;
  const capPct = total > 0n ? Number((amount * 100n) / total) : 0;

  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.85}>
      <View style={styles.cardHeader}>
        <View style={[styles.tokenDot, { backgroundColor: accentColor }]} />
        <View>
          <Text style={[styles.tokenLabel, { color: accentColor }]}>{label}</Text>
          <Text style={styles.tokenSublabel}>{sublabel}</Text>
        </View>
        <View style={styles.cardRight}>
          <Text style={styles.balanceAmount}>{formatToken(amount)}</Text>
          {usdValue !== undefined && usdValue > 0n && (
            <Text style={styles.balanceUsd}>{formatUsd(usdValue)}</Text>
          )}
        </View>
      </View>

      {/* Wallet cap bar */}
      <View style={styles.capRow}>
        <Text style={styles.capLabel}>Cap usage</Text>
        <Text style={styles.capPct}>{capPct}%</Text>
      </View>
      <View style={styles.capTrack}>
        <View style={[styles.capFill, { width: `${capPct}%` as any, backgroundColor: accentColor }]} />
      </View>
    </TouchableOpacity>
  );
}

interface ActionButtonProps {
  label: string;
  color: string;
  onPress: () => void;
}

function ActionButton({ label, color, onPress }: ActionButtonProps) {
  return (
    <TouchableOpacity style={[styles.actionBtn, { borderColor: color }]} onPress={onPress}>
      <Text style={[styles.actionBtnText, { color }]}>{label}</Text>
    </TouchableOpacity>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.background },
  scroll: { padding: Spacing.md, gap: Spacing.md },
  addressRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.sm },
  addressLabel: { ...Typography.bodySmall, color: Colors.textSecondary },
  address: { ...Typography.mono, color: Colors.textPrimary },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: Spacing.sm,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  tokenDot: { width: 10, height: 10, borderRadius: 5 },
  tokenLabel: { ...Typography.heading3 },
  tokenSublabel: { ...Typography.caption, color: Colors.textSecondary },
  cardRight: { marginLeft: 'auto', alignItems: 'flex-end' },
  balanceAmount: { ...Typography.heading2, color: Colors.textPrimary },
  balanceUsd: { ...Typography.bodySmall, color: Colors.textSecondary },
  capRow: { flexDirection: 'row', justifyContent: 'space-between' },
  capLabel: { ...Typography.caption, color: Colors.textMuted },
  capPct: { ...Typography.caption, color: Colors.textMuted },
  capTrack: { height: 4, backgroundColor: Colors.surfaceAlt, borderRadius: Radius.full },
  capFill: { height: 4, borderRadius: Radius.full },
  actions: { flexDirection: 'row', gap: Spacing.md },
  actionBtn: {
    flex: 1,
    borderWidth: 1.5,
    borderRadius: Radius.md,
    paddingVertical: Spacing.sm,
    alignItems: 'center',
  },
  actionBtnText: { ...Typography.heading3 },
  errorText: { ...Typography.bodySmall, color: Colors.error, textAlign: 'center' },
  priceStrip: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: Colors.surfaceAlt,
    borderRadius: Radius.sm,
    padding: Spacing.sm,
  },
  priceStripLabel: { ...Typography.caption, color: Colors.textSecondary },
  priceStripValue: { ...Typography.caption, color: Colors.goldLight },
});
