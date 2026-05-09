/**
 * src/screens/ReceiveScreen.tsx
 *
 * Shows the user's QR code and address for receiving TRC-G / TRC-U.
 */

import React, { useState } from 'react';
import {
  Clipboard,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import QRCode from 'react-native-qrcode-svg';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { Colors, Radius, Spacing, Typography } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Receive'>;

export default function ReceiveScreen({ route }: Props) {
  const { address } = route.params;
  const [copied, setCopied] = useState(false);

  const onCopy = () => {
    Clipboard.setString(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.heading}>Receive</Text>
      <Text style={styles.subtext}>
        Share this address or QR code to receive TRC-G or TRC-U.
      </Text>

      <View style={styles.qrWrapper}>
        <QRCode
          value={address}
          size={220}
          backgroundColor={Colors.surface}
          color={Colors.textPrimary}
        />
      </View>

      <View style={styles.addressBox}>
        <Text style={styles.addressText} selectable>
          {address}
        </Text>
      </View>

      <TouchableOpacity style={styles.copyBtn} onPress={onCopy}>
        <Text style={styles.copyBtnText}>{copied ? 'Copied ✓' : 'Copy address'}</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
    alignItems: 'center',
    padding: Spacing.lg,
    gap: Spacing.md,
  },
  heading: { ...Typography.heading2, color: Colors.textPrimary },
  subtext: { ...Typography.body, color: Colors.textSecondary, textAlign: 'center' },
  qrWrapper: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  addressBox: {
    backgroundColor: Colors.surfaceAlt,
    borderRadius: Radius.md,
    padding: Spacing.md,
    width: '100%',
  },
  addressText: { ...Typography.mono, color: Colors.textPrimary, textAlign: 'center' },
  copyBtn: {
    backgroundColor: Colors.gold,
    borderRadius: Radius.md,
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.xl,
  },
  copyBtnText: { ...Typography.heading3, color: Colors.background },
});
