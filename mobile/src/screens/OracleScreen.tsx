/**
 * src/screens/OracleScreen.tsx
 *
 * Oracle price reporting:
 *   - Asset selector (TRC oracle assets)
 *   - Live latest prices from the network
 *   - Price entry form → submit signed price report
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getAllPrices } from '../services/node';
import { submitPrice } from '../services/oracle';
import { Colors, Radius, Spacing, Typography } from '../theme';
import { ORACLE_ASSETS, ORACLE_ASSET_LABELS } from '../types';
import { formatUsd } from '../utils/format';
import type { AggregatedPrice, OracleAsset } from '../types';

export default function OracleScreen() {
  const [prices, setPrices] = useState<AggregatedPrice[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<OracleAsset>(ORACLE_ASSETS[0]);
  const [priceInput, setPriceInput] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const loadPrices = useCallback(async () => {
    try {
      const data = await getAllPrices();
      setPrices(data);
    } catch {
      // tolerate; show stale
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadPrices();
    const iv = setInterval(() => void loadPrices(), 15_000);
    return () => clearInterval(iv);
  }, [loadPrices]);

  const onRefresh = () => {
    setRefreshing(true);
    void loadPrices();
  };

  const onSubmit = useCallback(async () => {
    const trimmed = priceInput.trim();
    if (!trimmed || isNaN(Number(trimmed))) {
      Alert.alert('Invalid price', 'Enter a valid decimal number, e.g. 1923.45');
      return;
    }
    setSubmitting(true);
    try {
      await submitPrice(selectedAsset, trimmed);
      Alert.alert('Submitted', `Price ${trimmed} for ${selectedAsset} reported.`);
      setPriceInput('');
      void loadPrices();
    } catch (e: unknown) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Submission failed');
    } finally {
      setSubmitting(false);
    }
  }, [priceInput, selectedAsset, loadPrices]);

  const currentPrice = prices.find((p) => p.asset === selectedAsset);

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        style={styles.kav}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.gold} />}
          contentContainerStyle={styles.scroll}
        >
          <Text style={styles.heading}>Oracle</Text>
          <Text style={styles.subtext}>
            Report real-world commodity prices to earn oracle contribution points.
          </Text>

          {/* Asset selector */}
          <Text style={styles.label}>Select asset</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.assetScroll}>
            {ORACLE_ASSETS.map((asset) => (
              <TouchableOpacity
                key={asset}
                style={[
                  styles.assetChip,
                  selectedAsset === asset && styles.assetChipSelected,
                ]}
                onPress={() => setSelectedAsset(asset)}
              >
                <Text
                  style={[
                    styles.assetChipText,
                    selectedAsset === asset && styles.assetChipTextSelected,
                  ]}
                >
                  {ORACLE_ASSET_LABELS[asset] ?? asset}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {/* Current network price */}
          {loading ? (
            <ActivityIndicator color={Colors.gold} />
          ) : currentPrice ? (
            <View style={styles.networkPriceCard}>
              <Text style={styles.networkPriceLabel}>Network consensus price</Text>
              <Text style={styles.networkPriceValue}>{formatUsd(currentPrice.price)}</Text>
              <Text style={styles.networkPriceSources}>
                {currentPrice.reportCount} reporters · confidence{' '}
                {(currentPrice.confidence * 100).toFixed(1)}%
              </Text>
            </View>
          ) : (
            <View style={styles.networkPriceCard}>
              <Text style={styles.networkPriceLabel}>No network data yet for {selectedAsset}</Text>
            </View>
          )}

          {/* Price entry */}
          <Text style={styles.label}>Your price observation (USD)</Text>
          <TextInput
            style={styles.input}
            placeholder={currentPrice ? formatUsd(currentPrice.price).replace('$', '') : '0.00'}
            placeholderTextColor={Colors.textMuted}
            value={priceInput}
            onChangeText={setPriceInput}
            keyboardType="decimal-pad"
            returnKeyType="done"
          />

          <TouchableOpacity
            style={[styles.submitBtn, (submitting || !priceInput) && styles.submitBtnDisabled]}
            onPress={onSubmit}
            disabled={submitting || !priceInput}
          >
            {submitting ? (
              <ActivityIndicator color={Colors.background} />
            ) : (
              <Text style={styles.submitBtnText}>Submit price</Text>
            )}
          </TouchableOpacity>

          {/* All asset prices strip */}
          {prices.length > 0 && (
            <>
              <Text style={styles.sectionTitle}>All oracle prices</Text>
              {prices.map((p) => (
                <View key={p.asset} style={styles.priceRow}>
                  <Text style={styles.priceAsset}>{ORACLE_ASSET_LABELS[p.asset as OracleAsset] ?? p.asset}</Text>
                  <Text style={styles.priceValue}>{formatUsd(p.price)}</Text>
                </View>
              ))}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  kav: { flex: 1 },
  scroll: { padding: Spacing.md, gap: Spacing.md },
  heading: { ...Typography.heading2, color: Colors.textPrimary },
  subtext: { ...Typography.body, color: Colors.textSecondary },
  label: { ...Typography.bodySmall, color: Colors.textSecondary },
  assetScroll: { flexGrow: 0, marginBottom: Spacing.xs },
  assetChip: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.full,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    marginRight: Spacing.xs,
    backgroundColor: Colors.surface,
  },
  assetChipSelected: { borderColor: Colors.gold, backgroundColor: Colors.goldDark },
  assetChipText: { ...Typography.bodySmall, color: Colors.textSecondary },
  assetChipTextSelected: { color: Colors.goldLight },
  networkPriceCard: {
    backgroundColor: Colors.surfaceAlt,
    borderRadius: Radius.md,
    padding: Spacing.md,
    gap: Spacing.xs,
  },
  networkPriceLabel: { ...Typography.caption, color: Colors.textSecondary },
  networkPriceValue: { ...Typography.heading2, color: Colors.gold },
  networkPriceSources: { ...Typography.caption, color: Colors.textMuted },
  input: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.sm,
    color: Colors.textPrimary,
    ...Typography.body,
  },
  submitBtn: {
    backgroundColor: Colors.gold,
    borderRadius: Radius.md,
    padding: Spacing.md,
    alignItems: 'center',
  },
  submitBtnDisabled: { opacity: 0.4 },
  submitBtnText: { ...Typography.heading3, color: Colors.background },
  sectionTitle: { ...Typography.bodySmall, color: Colors.textSecondary, marginTop: Spacing.sm },
  priceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: Spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  priceAsset: { ...Typography.body, color: Colors.textPrimary },
  priceValue: { ...Typography.body, color: Colors.textSecondary },
});
