/**
 * App.tsx — Root React Native component
 *
 * Responsibilities:
 *   1. Bootstrap identity on first mount (load or create wallet + DID)
 *   2. Decide whether to show onboarding or main app
 *   3. Pass wallet address down to the navigator
 */

import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadOrCreateWallet, buildDIDDocument, saveDIDDocument } from './src/services/identity';
import AppNavigator from './src/navigation/AppNavigator';
import { Colors } from './src/theme';
import { STORAGE_KEYS } from './src/constants';

type AppState = 'loading' | 'onboarding' | 'ready';

export default function App() {
  const [appState, setAppState] = useState<AppState>('loading');
  const [walletAddress, setWalletAddress] = useState<string>('');

  useEffect(() => {
    void init();
  }, []);

  const init = async () => {
    try {
      const wallet = await loadOrCreateWallet();
      const doc = buildDIDDocument(wallet);
      await saveDIDDocument(doc);
      setWalletAddress(wallet.address);

      const onboardingDone = await AsyncStorage.getItem(STORAGE_KEYS.ONBOARDING_DONE);
      setAppState(onboardingDone ? 'ready' : 'onboarding');
    } catch {
      // If key storage fails (very rare), re-run onboarding
      setAppState('onboarding');
    }
  };

  const onOnboardingComplete = async () => {
    // Re-load after onboarding finishes generating keys
    const wallet = await loadOrCreateWallet();
    setWalletAddress(wallet.address);
    setAppState('ready');
  };

  if (appState === 'loading') {
    return (
      <View style={styles.splash}>
        <ActivityIndicator color={Colors.gold} size="large" />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <AppNavigator
        address={walletAddress}
        needsOnboarding={appState === 'onboarding'}
        onOnboardingComplete={onOnboardingComplete}
      />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    backgroundColor: Colors.background,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
