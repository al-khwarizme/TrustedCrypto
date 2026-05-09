/**
 * src/screens/ScanQRScreen.tsx
 *
 * Camera QR scanner used by the Send screen.
 */

import React, { useRef, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { RNCamera } from 'react-native-camera';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { Colors, Spacing, Typography } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'ScanQR'>;

export default function ScanQRScreen({ route, navigation }: Props) {
  const { onScan } = route.params;
  const [scanned, setScanned] = useState(false);
  const cameraRef = useRef<RNCamera>(null);

  const onBarCodeRead = ({ data }: { data: string }) => {
    if (scanned) {
      return;
    }
    setScanned(true);
    onScan(data);
    navigation.goBack();
  };

  return (
    <View style={styles.container}>
      <RNCamera
        ref={cameraRef}
        style={styles.camera}
        type={RNCamera.Constants.Type.back}
        onBarCodeRead={onBarCodeRead}
        barCodeTypes={[RNCamera.Constants.BarCodeType.qr]}
        captureAudio={false}
      >
        <View style={styles.overlay}>
          <View style={styles.frame} />
          <Text style={styles.hint}>Align QR code within the frame</Text>
          <TouchableOpacity style={styles.cancelBtn} onPress={() => navigation.goBack()}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </RNCamera>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  camera: { flex: 1 },
  overlay: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: Spacing.lg },
  frame: {
    width: 240,
    height: 240,
    borderWidth: 2,
    borderColor: Colors.gold,
    borderRadius: 16,
  },
  hint: { ...Typography.body, color: '#fff', textAlign: 'center' },
  cancelBtn: {
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.sm,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: Colors.gold,
  },
  cancelText: { ...Typography.body, color: Colors.gold },
});
