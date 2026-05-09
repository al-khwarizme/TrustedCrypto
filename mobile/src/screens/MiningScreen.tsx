/**
 * src/screens/MiningScreen.tsx
 *
 * Proof-of-Contribution dashboard:
 *   - Live session timer (uptime, points earned this session)
 *   - Cumulative score breakdown by contribution type
 *   - Estimated epoch reward (TRC-U)
 *   - Start / stop mining toggle
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import {
  getActiveMiningSession,
  refreshContributionScore,
  startMiningSession,
  stopMiningSession,
} from '../services/mining';
import { Colors, Radius, Spacing, Typography } from '../theme';
import { ContributionType, CONTRIBUTION_LABELS } from '../types';
import { formatDuration, formatPoints, formatToken } from '../utils/format';
import type { ContributionScore } from '../types';

export default function MiningScreen() {
  const [score, setScore] = useState<ContributionScore | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sessionSeconds, setSessionSeconds] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const session = getActiveMiningSession();
  const miningActive = session?.active === true;

  const loadScore = useCallback(async () => {
    const s = await refreshContributionScore();
    setScore(s);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    void loadScore();
    const poll = setInterval(() => void loadScore(), 60_000);
    return () => clearInterval(poll);
  }, [loadScore]);

  // Session timer
  useEffect(() => {
    if (miningActive && session) {
      timerRef.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - session.startedAt.getTime()) / 1000);
        setSessionSeconds(elapsed);
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
      setSessionSeconds(0);
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [miningActive, session]);

  const onToggleMining = useCallback(async () => {
    if (miningActive) {
      stopMiningSession();
    } else {
      await startMiningSession();
    }
    void loadScore();
  }, [miningActive, loadScore]);

  const onRefresh = () => {
    setRefreshing(true);
    void loadScore();
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.gold} />}
        contentContainerStyle={styles.scroll}
      >
        <Text style={styles.heading}>Mining</Text>

        {/* Session card */}
        <View style={[styles.card, miningActive && styles.cardActive]}>
          <Text style={styles.sessionLabel}>
            {miningActive ? 'Session running' : 'Not mining'}
          </Text>
          {miningActive ? (
            <>
              <Text style={styles.sessionTimer}>{formatDuration(sessionSeconds)}</Text>
              <Text style={styles.sessionPts}>
                +{session?.pointsEarned ?? 0} pts this session
              </Text>
            </>
          ) : (
            <Text style={styles.sessionHint}>
              Start mining to earn uptime contributions and oracle data points.
            </Text>
          )}
          <TouchableOpacity
            style={[styles.toggleBtn, miningActive && styles.toggleBtnStop]}
            onPress={onToggleMining}
          >
            <Text style={styles.toggleBtnText}>{miningActive ? 'Stop' : 'Start Mining'}</Text>
          </TouchableOpacity>
        </View>

        {/* Cumulative score */}
        {loading ? (
          <ActivityIndicator color={Colors.gold} />
        ) : score ? (
          <>
            <View style={styles.scoreCard}>
              <Text style={styles.scoreTotal}>{formatPoints(score.total)} pts</Text>
              <Text style={styles.scoreSubtitle}>Total contribution score</Text>
              {score.estimatedReward > 0n && (
                <Text style={styles.scoreReward}>
                  Est. reward: {formatToken(score.estimatedReward)} TRC-U
                </Text>
              )}
            </View>

            <Text style={styles.sectionTitle}>By contribution type</Text>
            {CONTRIBUTION_TYPE_ORDER.map((type) => (
              <TypeRow
                key={type}
                type={type}
                pts={score.byType[type] ?? 0}
              />
            ))}
          </>
        ) : (
          <Text style={styles.emptyText}>No score data yet. Start mining to begin.</Text>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

const CONTRIBUTION_TYPE_ORDER = [
  ContributionType.NodeUptime,
  ContributionType.OracleData,
  ContributionType.GovernanceVote,
  ContributionType.PhysicalVerification,
  ContributionType.TransactionActivity,
];

const TYPE_COLORS: Record<ContributionType, string> = {
  [ContributionType.NodeUptime]: Colors.nodeUptime,
  [ContributionType.OracleData]: Colors.oracleData,
  [ContributionType.GovernanceVote]: Colors.governanceVote,
  [ContributionType.PhysicalVerification]: Colors.physicalVerification,
  [ContributionType.TransactionActivity]: Colors.transactionActivity,
};

function TypeRow({ type, pts }: { type: ContributionType; pts: number }) {
  return (
    <View style={styles.typeRow}>
      <View style={[styles.typeDot, { backgroundColor: TYPE_COLORS[type] }]} />
      <Text style={styles.typeLabel}>{CONTRIBUTION_LABELS[type]}</Text>
      <Text style={styles.typePts}>{formatPoints(pts)} pts</Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  scroll: { padding: Spacing.md, gap: Spacing.md },
  heading: { ...Typography.heading2, color: Colors.textPrimary },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: Spacing.sm,
  },
  cardActive: { borderColor: Colors.success },
  sessionLabel: { ...Typography.bodySmall, color: Colors.textSecondary },
  sessionTimer: { ...Typography.heading1, color: Colors.textPrimary },
  sessionPts: { ...Typography.body, color: Colors.success },
  sessionHint: { ...Typography.body, color: Colors.textMuted },
  toggleBtn: {
    backgroundColor: Colors.gold,
    borderRadius: Radius.md,
    padding: Spacing.sm,
    alignItems: 'center',
    marginTop: Spacing.xs,
  },
  toggleBtnStop: { backgroundColor: Colors.error },
  toggleBtnText: { ...Typography.heading3, color: Colors.background },
  scoreCard: {
    backgroundColor: Colors.surfaceAlt,
    borderRadius: Radius.md,
    padding: Spacing.md,
    alignItems: 'center',
    gap: Spacing.xs,
  },
  scoreTotal: { ...Typography.heading1, color: Colors.gold },
  scoreSubtitle: { ...Typography.bodySmall, color: Colors.textSecondary },
  scoreReward: { ...Typography.body, color: Colors.utility },
  sectionTitle: { ...Typography.bodySmall, color: Colors.textSecondary, marginTop: Spacing.sm },
  typeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  typeDot: { width: 10, height: 10, borderRadius: 5 },
  typeLabel: { ...Typography.body, color: Colors.textPrimary, flex: 1 },
  typePts: { ...Typography.body, color: Colors.textSecondary },
  emptyText: { ...Typography.body, color: Colors.textMuted, textAlign: 'center' },
});
