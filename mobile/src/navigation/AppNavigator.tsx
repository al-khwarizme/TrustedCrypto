/**
 * src/navigation/AppNavigator.tsx
 *
 * Root navigator:
 *   - Bottom tab: Wallet | Mine | Govern | Oracle
 *   - Modal stack for Send, Receive, ScanQR
 */

import React from 'react';
import { Text } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import WalletScreen from '../screens/WalletScreen';
import SendScreen from '../screens/SendScreen';
import ReceiveScreen from '../screens/ReceiveScreen';
import ScanQRScreen from '../screens/ScanQRScreen';
import MiningScreen from '../screens/MiningScreen';
import GovernanceScreen from '../screens/GovernanceScreen';
import OracleScreen from '../screens/OracleScreen';
import OnboardingScreen from '../screens/OnboardingScreen';

import { Colors } from '../theme';
import type { RootStackParamList } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Tab navigator (inner)
// ─────────────────────────────────────────────────────────────────────────────

const Tab = createBottomTabNavigator();

function TabNavigator({ address }: { address: string }) {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: Colors.surface,
          borderTopColor: Colors.border,
        },
        tabBarActiveTintColor: Colors.gold,
        tabBarInactiveTintColor: Colors.textMuted,
      }}
    >
      <Tab.Screen
        name="Wallet"
        options={{ tabBarIcon: ({ color }) => <TabIcon label="💰" color={color} /> }}
      >
        {(props) => <WalletScreen {...props} address={address} />}
      </Tab.Screen>
      <Tab.Screen
        name="Mine"
        component={MiningScreen}
        options={{ tabBarIcon: ({ color }) => <TabIcon label="⛏" color={color} /> }}
      />
      <Tab.Screen
        name="Governance"
        component={GovernanceScreen}
        options={{ tabBarIcon: ({ color }) => <TabIcon label="🏛" color={color} /> }}
      />
      <Tab.Screen
        name="Oracle"
        component={OracleScreen}
        options={{ tabBarIcon: ({ color }) => <TabIcon label="📡" color={color} /> }}
      />
    </Tab.Navigator>
  );
}

function TabIcon({ label, color }: { label: string; color: string }) {
  return <Text style={{ fontSize: 20, color }}>{label}</Text>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Root stack (wraps tabs + modal screens)
// ─────────────────────────────────────────────────────────────────────────────

const Stack = createNativeStackNavigator<RootStackParamList>();

interface Props {
  /** Wallet address — undefined until identity is bootstrapped. */
  address?: string;
  /** True if the user has not completed onboarding yet. */
  needsOnboarding: boolean;
  onOnboardingComplete: () => void;
}

export default function AppNavigator({ address, needsOnboarding, onOnboardingComplete }: Props) {
  return (
    <NavigationContainer
      theme={{
        dark: true,
        colors: {
          primary: Colors.gold,
          background: Colors.background,
          card: Colors.surface,
          text: Colors.textPrimary,
          border: Colors.border,
          notification: Colors.gold,
        },
      }}
    >
      <Stack.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: Colors.surface },
          headerTintColor: Colors.textPrimary,
        }}
      >
        {needsOnboarding ? (
          <Stack.Screen name="Onboarding" options={{ headerShown: false }}>
            {() => <OnboardingScreen onComplete={onOnboardingComplete} />}
          </Stack.Screen>
        ) : (
          <>
            <Stack.Screen name="Wallet" options={{ headerShown: false }}>
              {(props) => <TabNavigator address={address ?? ''} />}
            </Stack.Screen>
            <Stack.Screen name="Send" component={SendScreen} options={{ title: 'Send' }} />
            <Stack.Screen name="Receive" component={ReceiveScreen} options={{ title: 'Receive' }} />
            <Stack.Screen
              name="ScanQR"
              component={ScanQRScreen}
              options={{ title: 'Scan QR', presentation: 'modal' }}
            />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
