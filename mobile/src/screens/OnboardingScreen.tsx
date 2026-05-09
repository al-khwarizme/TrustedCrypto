/**
 * src/screens/OnboardingScreen.tsx
 *
 * First-run onboarding:
 *   1. Generate / recover identity key
 *   2. Display DID + wallet address
 *   3. Optionally initiate Proof-of-Humanity credential flow
 *   4. Mark onboarding complete and hand off to the main app
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadOrCreateWallet, buildDIDDocument, saveDIDDocument } from '../services/identity';
import { configureMiningBackgroundFetch } from '../services/mining';
import { Colors, Radius, Spacing, Typography } from '../theme';
import { STORAGE_KEYS } from '../constants';

interface Props {
  onComplete: () => void;
}

type Step = 'generating' | 'confirm' | 'done';

export default function OnboardingScreen({ onComplete }: Props) {
  const [step, setStep] = useState<Step>('generating');
  const [address, setAddress] = useState('');
  const [did, setDid] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void bootstrap();
  }, []);

  const bootstrap = async () => {
    try {
      const wallet = await loadOrCreateWallet();
      const doc = buildDIDDocument(wallet);
      await saveDIDDocument(doc);
      setAddress(wallet.address);
      setDid(doc.id);
      setStep('confirm');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Key generation failed');
    }
  };

  const onConfirm = useCallback(async () => {
    setStep('done');
    try {
      await configureMiningBackgroundFetch();
      await AsyncStorage.setItem(STORAGE_KEYS.ONBOARDING_DONE, '1');
    } catch {
      // non-fatal: background fetch may not be available on all platforms
    }
    onComplete();
  }, [onComplete]);

  if (step === 'generating') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <ActivityIndicator color={Colors.gold} size="large" />
          <Text style={styles.hint}>Generating your identity key…</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.btn} onPress={() => { setError(null); setStep('generating'); void bootstrap(); }}>
            <Text style={styles.btnText}>Retry</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.scroll}>
        <Text style={styles.heading}>Welcome to TrustedCrypto</Text>
        <Text style={styles.subtext}>
          Your decentralised identity has been generated and secured in the device keystore.
          No seed phrase is transmitted or stored in plaintext.
        </Text>

        <View style={styles.card}>
          <Text style={styles.cardLabel}>Wallet address</Text>
          <Text style={styles.cardValue} selectable>{address}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardLabel}>DID (Decentralised Identifier)</Text>
          <Text style={styles.cardValue} selectable>{did}</Text>
        </View>

        <Text style={styles.warningText}>
          ⚠ Back up your wallet's private key externally before sending any funds.
          If you uninstall the app without a backup, your funds are irrecoverable.
        </Text>

        <TouchableOpacity style={styles.btn} onPress={onConfirm}>
          <Text style={styles.btnText}>Let's go →</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: Spacing.md, padding: Spacing.lg },
  scroll: { flex: 1, padding: Spacing.lg, gap: Spacing.md, justifyContent: 'center' },
  heading: { ...Typography.heading1, color: Colors.textPrimary },
  subtext: { ...Typography.body, color: Colors.textSecondary },
  card: {
    backgroundColor: Colors.surfaceAlt,
    borderRadius: Radius.md,
    padding: Spacing.md,
    gap: Spacing.xs,
  },
  cardLabel: { ...Typography.caption, color: Colors.textMuted },
  cardValue: { ...Typography.mono, color: Colors.textPrimary },
  warningText: { ...Typography.bodySmall, color: Colors.warning },
  btn: {
    backgroundColor: Colors.gold,
    borderRadius: Radius.md,
    padding: Spacing.md,
    alignItems: 'center',
    marginTop: Spacing.sm,
  },
  btnText: { ...Typography.heading3, color: Colors.background },
  hint: { ...Typography.body, color: Colors.textSecondary, marginTop: Spacing.md },
  errorText: { ...Typography.body, color: Colors.error, textAlign: 'center' },
});
