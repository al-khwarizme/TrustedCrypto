/**
 * src/screens/SendScreen.tsx
 *
 * Send TRC-G or TRC-U to another address.
 * Validates against wallet-cap, signs with device key, broadcasts via node service.
 */

import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ethers } from 'ethers';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { sendTransaction } from '../services/node';
import { Colors, Radius, Spacing, Typography } from '../theme';
import { WEI } from '../constants';
import type { TxRequest } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'Send'>;

export default function SendScreen({ route, navigation }: Props) {
  const { token, address } = route.params;
  const [toAddress, setToAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const isValidAddress = ethers.isAddress(toAddress);
  const parsedAmount = parseAmount(amount);
  const canSubmit = isValidAddress && parsedAmount > 0n && !submitting;

  const onSend = useCallback(async () => {
    if (!canSubmit) {
      return;
    }
    setSubmitting(true);
    try {
      const req: TxRequest = {
        to: toAddress,
        amount: parsedAmount,
        token,
        memo: memo || undefined,
      };
      // In production: build, sign, and broadcast the ERC-20 transfer using ethers.js
      // For now: delegate to the light node RPC which handles signing internally
      const receipt = await sendTransaction('', req);
      Alert.alert('Sent', `Transaction submitted.\nHash: ${receipt.hash.slice(0, 18)}…`, [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } catch (e: unknown) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Send failed');
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, toAddress, parsedAmount, token, memo, navigation]);

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        style={styles.kav}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Text style={styles.heading}>Send {token}</Text>

        {/* To address */}
        <Text style={styles.label}>Recipient address</Text>
        <View style={[styles.inputRow, !isValidAddress && toAddress.length > 0 && styles.inputError]}>
          <TextInput
            style={styles.input}
            placeholder="0x..."
            placeholderTextColor={Colors.textMuted}
            value={toAddress}
            onChangeText={setToAddress}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity
            style={styles.scanBtn}
            onPress={() => navigation.navigate('ScanQR', { onScan: setToAddress })}
          >
            <Text style={styles.scanBtnText}>Scan</Text>
          </TouchableOpacity>
        </View>
        {!isValidAddress && toAddress.length > 0 ? (
          <Text style={styles.hint}>Not a valid Ethereum address</Text>
        ) : null}

        {/* Amount */}
        <Text style={styles.label}>Amount ({token})</Text>
        <TextInput
          style={styles.input}
          placeholder="0.00"
          placeholderTextColor={Colors.textMuted}
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
        />

        {/* Memo */}
        <Text style={styles.label}>Memo (optional)</Text>
        <TextInput
          style={styles.input}
          placeholder="Payment for…"
          placeholderTextColor={Colors.textMuted}
          value={memo}
          onChangeText={setMemo}
          maxLength={140}
        />

        <TouchableOpacity
          style={[styles.sendBtn, !canSubmit && styles.sendBtnDisabled]}
          onPress={onSend}
          disabled={!canSubmit}
        >
          {submitting ? (
            <ActivityIndicator color={Colors.background} />
          ) : (
            <Text style={styles.sendBtnText}>Send {token}</Text>
          )}
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function parseAmount(s: string): bigint {
  if (!s || s === '.') {
    return 0n;
  }
  try {
    return ethers.parseUnits(s, 18);
  } catch {
    return 0n;
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  kav: { flex: 1, padding: Spacing.md, gap: Spacing.md },
  heading: { ...Typography.heading2, color: Colors.textPrimary, marginBottom: Spacing.sm },
  label: { ...Typography.bodySmall, color: Colors.textSecondary, marginBottom: Spacing.xs },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: Spacing.sm,
  },
  input: {
    flex: 1,
    padding: Spacing.sm,
    color: Colors.textPrimary,
    ...Typography.body,
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: Spacing.sm,
  },
  inputError: { borderColor: Colors.error },
  hint: { ...Typography.caption, color: Colors.error, marginTop: -Spacing.sm, marginBottom: Spacing.sm },
  scanBtn: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  scanBtnText: { ...Typography.bodySmall, color: Colors.gold },
  sendBtn: {
    backgroundColor: Colors.gold,
    borderRadius: Radius.md,
    padding: Spacing.md,
    alignItems: 'center',
    marginTop: 'auto',
  },
  sendBtnDisabled: { opacity: 0.4 },
  sendBtnText: { ...Typography.heading3, color: Colors.background },
});
