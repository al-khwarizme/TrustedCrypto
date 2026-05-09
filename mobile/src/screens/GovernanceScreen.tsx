/**
 * src/screens/GovernanceScreen.tsx
 *
 * Governance proposal list, proposal detail, and vote submission.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { fetchProposals, castVote } from '../services/governance';
import { Colors, Radius, Spacing, Typography } from '../theme';
import { ProposalStatus, PROPOSAL_TYPE_LABELS } from '../types';
import { formatDate } from '../utils/format';
import type { Proposal } from '../types';

export default function GovernanceScreen() {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<Proposal | null>(null);
  const [voting, setVoting] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await fetchProposals();
      setProposals(list);
    } catch {
      // silently swallow; user sees stale data
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = () => {
    setRefreshing(true);
    void load();
  };

  const onVote = async (support: boolean) => {
    if (!selected) {
      return;
    }
    setVoting(true);
    try {
      await castVote(selected.id, support);
      Alert.alert('Vote cast', support ? 'You voted in favour.' : 'You voted against.');
      setSelected(null);
      void load();
    } catch (e: unknown) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Vote failed');
    } finally {
      setVoting(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={Colors.gold} size="large" />
      </View>
    );
  }

  // ── Proposal detail view ──────────────────────────────────────────────────
  if (selected) {
    const totalVotes = selected.votesFor + selected.votesAgainst;
    const forPct = totalVotes > 0n
      ? Number((selected.votesFor * 100n) / totalVotes)
      : 0;
    return (
      <SafeAreaView style={styles.container}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <TouchableOpacity onPress={() => setSelected(null)}>
            <Text style={styles.backBtn}>← Back</Text>
          </TouchableOpacity>
          <Text style={styles.heading}>{selected.title}</Text>
          <Text style={styles.proposalMeta}>
            {PROPOSAL_TYPE_LABELS[selected.type]} · {selected.status}
          </Text>
          <Text style={styles.proposalBody}>{selected.description}</Text>

          <Text style={styles.sectionTitle}>Votes</Text>
          <VoteBar forPct={forPct} votesFor={selected.votesFor} votesAgainst={selected.votesAgainst} />

          {selected.status === ProposalStatus.Active && (
            <View style={styles.voteButtons}>
              <VoteButton
                label="For"
                color={Colors.success}
                onPress={() => void onVote(true)}
                disabled={voting}
              />
              <VoteButton
                label="Against"
                color={Colors.error}
                onPress={() => void onVote(false)}
                disabled={voting}
              />
            </View>
          )}

          {selected.endTime && (
            <Text style={styles.deadline}>
              Voting ends: {formatDate(selected.endTime)}
            </Text>
          )}
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ── Proposal list ─────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.gold} />}
        contentContainerStyle={styles.scroll}
      >
        <Text style={styles.heading}>Governance</Text>
        {proposals.length === 0 ? (
          <Text style={styles.emptyText}>No proposals yet.</Text>
        ) : (
          proposals.map((p) => (
            <ProposalCard key={p.id} proposal={p} onPress={() => setSelected(p)} />
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function ProposalCard({ proposal, onPress }: { proposal: Proposal; onPress: () => void }) {
  const isActive = proposal.status === ProposalStatus.Active;
  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.85}>
      <View style={styles.cardHeader}>
        <Text style={[styles.statusBadge, { color: isActive ? Colors.success : Colors.textMuted }]}>
          {proposal.status}
        </Text>
        <Text style={styles.proposalType}>{PROPOSAL_TYPE_LABELS[proposal.type]}</Text>
      </View>
      <Text style={styles.proposalTitle}>{proposal.title}</Text>
      <Text style={styles.proposalDescription} numberOfLines={2}>
        {proposal.description}
      </Text>
      {proposal.endTime && (
        <Text style={styles.proposalDeadline}>Ends {formatDate(proposal.endTime)}</Text>
      )}
    </TouchableOpacity>
  );
}

function VoteBar({
  forPct,
  votesFor,
  votesAgainst,
}: {
  forPct: number;
  votesFor: bigint;
  votesAgainst: bigint;
}) {
  return (
    <View style={styles.voteBarWrapper}>
      <View style={styles.voteTrack}>
        <View style={[styles.voteForFill, { width: `${forPct}%` as any }]} />
      </View>
      <View style={styles.voteBarLabels}>
        <Text style={styles.voteForLabel}>For: {votesFor.toLocaleString()}</Text>
        <Text style={styles.voteAgainstLabel}>Against: {votesAgainst.toLocaleString()}</Text>
      </View>
    </View>
  );
}

function VoteButton({
  label,
  color,
  onPress,
  disabled,
}: {
  label: string;
  color: string;
  onPress: () => void;
  disabled: boolean;
}) {
  return (
    <TouchableOpacity
      style={[styles.voteBtn, { borderColor: color }, disabled && styles.voteBtnDisabled]}
      onPress={onPress}
      disabled={disabled}
    >
      {disabled ? (
        <ActivityIndicator color={color} />
      ) : (
        <Text style={[styles.voteBtnText, { color }]}>{label}</Text>
      )}
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
  heading: { ...Typography.heading2, color: Colors.textPrimary },
  backBtn: { ...Typography.body, color: Colors.gold, marginBottom: Spacing.sm },
  proposalMeta: { ...Typography.bodySmall, color: Colors.textSecondary },
  proposalBody: { ...Typography.body, color: Colors.textPrimary, marginTop: Spacing.sm },
  sectionTitle: { ...Typography.bodySmall, color: Colors.textSecondary, marginTop: Spacing.sm },
  voteButtons: { flexDirection: 'row', gap: Spacing.md, marginTop: Spacing.sm },
  deadline: { ...Typography.caption, color: Colors.textMuted, marginTop: Spacing.md },
  emptyText: { ...Typography.body, color: Colors.textMuted, textAlign: 'center' },

  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: Spacing.xs,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between' },
  statusBadge: { ...Typography.caption, fontWeight: '600' },
  proposalType: { ...Typography.caption, color: Colors.textMuted },
  proposalTitle: { ...Typography.heading3, color: Colors.textPrimary },
  proposalDescription: { ...Typography.body, color: Colors.textSecondary },
  proposalDeadline: { ...Typography.caption, color: Colors.textMuted },

  voteBarWrapper: { gap: Spacing.xs },
  voteTrack: {
    height: 8,
    backgroundColor: Colors.error,
    borderRadius: Radius.full,
    overflow: 'hidden',
  },
  voteForFill: { height: 8, backgroundColor: Colors.success },
  voteBarLabels: { flexDirection: 'row', justifyContent: 'space-between' },
  voteForLabel: { ...Typography.caption, color: Colors.success },
  voteAgainstLabel: { ...Typography.caption, color: Colors.error },

  voteBtn: {
    flex: 1,
    borderWidth: 1.5,
    borderRadius: Radius.md,
    paddingVertical: Spacing.sm,
    alignItems: 'center',
  },
  voteBtnDisabled: { opacity: 0.4 },
  voteBtnText: { ...Typography.heading3 },
});
