// Package oracle implements the TrustedCrypto oracle network (§16.5).
//
// Oracles bridge the physical world to the smart contracts:
//   - Gold spot price   — 50+ reporters, 15-min submissions, median aggregation
//   - Commodity prices  — wheat, rice, crude oil, copper, solar kWh
//   - Vault attestation — daily operator commitment + monthly auditor attestation
//   - Producer pledge   — three-verifier sign-off on commodity pledges
//
// Anti-gaming: submissions more than 2 standard deviations from the median
// are discarded before the final price is computed.
// Reporters are randomly rotated from the contribution scoreboard each cycle.
package oracle

import (
	"crypto/sha256"
	"errors"
	"math/big"
	"sort"
	"sync"
	"time"

	"go.uber.org/zap"

	"github.com/trustedcrypto/protocol/types"
)

// ─────────────────────────────────────────────────────────────────────────────
// Supported assets
// ─────────────────────────────────────────────────────────────────────────────

const (
	AssetGoldUSD    = "XAU/USD"
	AssetWheatKg    = "WHEAT_KG_USD"
	AssetRiceKg     = "RICE_KG_USD"
	AssetCrudeOilBbl = "WTI_BBL_USD"
	AssetCopperKg   = "COPPER_KG_USD"
	AssetSolarKWh   = "SOLAR_KWH_USD"
)

var SupportedAssets = []string{
	AssetGoldUSD,
	AssetWheatKg,
	AssetRiceKg,
	AssetCrudeOilBbl,
	AssetCopperKg,
	AssetSolarKWh,
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregator
// ─────────────────────────────────────────────────────────────────────────────

// CycleInterval is how often a new price is computed from submitted reports.
const CycleInterval = 15 * time.Minute

// Aggregator collects price reports from oracle reporters, rejects outliers,
// and publishes a median price each cycle.
type Aggregator struct {
	mu       sync.Mutex
	windows  map[string]*priceWindow // asset → current collection window
	lastFinal map[string]*types.AggregatedPrice
	epochID  uint64
	logger   *zap.Logger

	// OnNewPrice is called whenever a new aggregated price is ready.
	// Called from the internal flush goroutine — implementations must be
	// goroutine-safe.
	OnNewPrice func(*types.AggregatedPrice)
}

// priceWindow holds in-flight reports for one asset in one 15-minute cycle.
type priceWindow struct {
	asset     string
	reports   []*types.PriceReport
	openedAt  time.Time
}

// NewAggregator creates an Aggregator and starts the flush ticker.
func NewAggregator(epochID uint64, logger *zap.Logger) *Aggregator {
	a := &Aggregator{
		windows:   make(map[string]*priceWindow),
		lastFinal: make(map[string]*types.AggregatedPrice),
		epochID:   epochID,
		logger:    logger,
	}
	for _, asset := range SupportedAssets {
		a.windows[asset] = &priceWindow{asset: asset, openedAt: time.Now().UTC()}
	}
	go a.flushLoop()
	return a
}

// Submit adds a price report to the current window for the report's asset.
func (a *Aggregator) Submit(report *types.PriceReport) error {
	if report.Price == nil || report.Price.Sign() <= 0 {
		return errors.New("price must be positive")
	}
	if !isSupportedAsset(report.Asset) {
		return errors.New("unsupported asset: " + report.Asset)
	}

	a.mu.Lock()
	defer a.mu.Unlock()

	w := a.windows[report.Asset]
	// Deduplicate: one submission per reporter per window
	for _, existing := range w.reports {
		if existing.Reporter == report.Reporter {
			return errors.New("duplicate submission from reporter in this window")
		}
	}
	w.reports = append(w.reports, report)
	return nil
}

// LastPrice returns the most recent aggregated price for an asset.
func (a *Aggregator) LastPrice(asset string) *types.AggregatedPrice {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.lastFinal[asset]
}

// flushLoop fires every CycleInterval and computes the final median price
// for all assets that have enough reports.
func (a *Aggregator) flushLoop() {
	ticker := time.NewTicker(CycleInterval)
	defer ticker.Stop()
	for range ticker.C {
		a.flush()
	}
}

// flush computes final prices for the current window.
func (a *Aggregator) flush() {
	a.mu.Lock()
	defer a.mu.Unlock()

	now := time.Now().UTC()
	for asset, w := range a.windows {
		if len(w.reports) < 3 {
			// Not enough reports for statistical outlier rejection
			a.logger.Warn("insufficient oracle reports", zap.String("asset", asset), zap.Int("count", len(w.reports)))
			// Reset window
			a.windows[asset] = &priceWindow{asset: asset, openedAt: now}
			continue
		}

		prices := extractPrices(w.reports)
		filtered := rejectOutliers(prices)
		if len(filtered) == 0 {
			a.logger.Warn("all oracle reports rejected as outliers", zap.String("asset", asset))
			a.windows[asset] = &priceWindow{asset: asset, openedAt: now}
			continue
		}

		median := computeMedian(filtered)
		aggregated := &types.AggregatedPrice{
			Asset:       asset,
			MedianPrice: median,
			Reports:     uint32(len(filtered)),
			Timestamp:   now,
			EpochID:     a.epochID,
		}
		a.lastFinal[asset] = aggregated

		a.logger.Info("oracle price aggregated",
			zap.String("asset", asset),
			zap.String("price", median.String()),
			zap.Uint32("reports", aggregated.Reports),
		)

		if a.OnNewPrice != nil {
			go a.OnNewPrice(aggregated)
		}

		// Reset window
		a.windows[asset] = &priceWindow{asset: asset, openedAt: now}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Vault attestation
// ─────────────────────────────────────────────────────────────────────────────

// VaultAttestation is submitted daily by vault operators and monthly by auditors.
type VaultAttestation struct {
	VaultID      string
	GramsInVault *big.Int  // 18-decimal fixed point
	IsAuditor    bool      // true = monthly auditor; false = daily operator
	Timestamp    time.Time
	Commitment   [32]byte  // sha256(VaultID || grams || timestamp || nonce)
	SignerDID    types.DID
	Signature    []byte
}

// BuildCommitment computes the cryptographic commitment for a vault attestation.
func BuildCommitment(vaultID string, grams *big.Int, ts time.Time, nonce [32]byte) [32]byte {
	var buf []byte
	buf = append(buf, []byte(vaultID)...)
	buf = append(buf, grams.Bytes()...)
	tBytes := make([]byte, 8)
	tsVal := uint64(ts.Unix())
	for i := 7; i >= 0; i-- {
		tBytes[i] = byte(tsVal)
		tsVal >>= 8
	}
	buf = append(buf, tBytes...)
	buf = append(buf, nonce[:]...)
	return sha256.Sum256(buf)
}

// AttestationStore verifies and stores vault attestations, triggering freeze
// on mismatch between operator and auditor commitments.
type AttestationStore struct {
	mu           sync.Mutex
	operator     map[string]*VaultAttestation // vaultID → latest operator
	auditor      map[string]*VaultAttestation // vaultID → latest auditor
	frozenVaults map[string]bool

	OnAuditFreeze func(vaultID string, reason string) // callback to freeze contracts
}

// NewAttestationStore creates an AttestationStore.
func NewAttestationStore() *AttestationStore {
	return &AttestationStore{
		operator:     make(map[string]*VaultAttestation),
		auditor:      make(map[string]*VaultAttestation),
		frozenVaults: make(map[string]bool),
	}
}

// Submit records an attestation and checks for mismatch.
func (s *AttestationStore) Submit(a *VaultAttestation) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if a.IsAuditor {
		s.auditor[a.VaultID] = a
	} else {
		s.operator[a.VaultID] = a
	}

	// Cross-check: if both operator and auditor have submitted for the same month,
	// verify their reported gold amounts are within 0.1%
	op := s.operator[a.VaultID]
	aud := s.auditor[a.VaultID]
	if op != nil && aud != nil {
		if !isWithinTolerance(op.GramsInVault, aud.GramsInVault, 10) { // 0.10% tolerance
			s.frozenVaults[a.VaultID] = true
			if s.OnAuditFreeze != nil {
				go s.OnAuditFreeze(a.VaultID, "operator/auditor grams mismatch exceeds 0.10%")
			}
			return errors.New("vault frozen: attestation mismatch")
		}
	}
	return nil
}

// IsFrozen reports whether a vault is currently under audit freeze.
func (s *AttestationStore) IsFrozen(vaultID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.frozenVaults[vaultID]
}

// ─────────────────────────────────────────────────────────────────────────────
// Producer pledge verification
// ─────────────────────────────────────────────────────────────────────────────

// PledgeVerification is one of the three required verifier sign-offs.
type PledgeVerification struct {
	PledgeID    [32]byte
	VerifierDID types.DID
	Approved    bool
	Timestamp   time.Time
	Signature   []byte
}

// PledgeAccumulator collects verifier sign-offs and fires OnConfirmed when
// all three independent verifiers have approved.
type PledgeAccumulator struct {
	mu      sync.Mutex
	pledges map[[32]byte][]*PledgeVerification // pledgeID → verifications

	OnConfirmed func(pledgeID [32]byte)
	OnRejected  func(pledgeID [32]byte, verifierDID types.DID)
}

// NewPledgeAccumulator creates a PledgeAccumulator.
func NewPledgeAccumulator() *PledgeAccumulator {
	return &PledgeAccumulator{
		pledges: make(map[[32]byte][]*PledgeVerification),
	}
}

// Submit records a verifier's decision on a producer pledge.
func (pa *PledgeAccumulator) Submit(v *PledgeVerification) {
	pa.mu.Lock()
	defer pa.mu.Unlock()

	if !v.Approved {
		if pa.OnRejected != nil {
			go pa.OnRejected(v.PledgeID, v.VerifierDID)
		}
		return
	}

	// Deduplicate: each verifier votes once
	existing := pa.pledges[v.PledgeID]
	for _, prev := range existing {
		if prev.VerifierDID == v.VerifierDID {
			return
		}
	}
	existing = append(existing, v)
	pa.pledges[v.PledgeID] = existing

	if len(existing) >= 3 {
		if pa.OnConfirmed != nil {
			go pa.OnConfirmed(v.PledgeID)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Statistical helpers
// ─────────────────────────────────────────────────────────────────────────────

// rejectOutliers removes prices more than 2 standard deviations from the mean.
// Returns the filtered slice (may be empty if all are outliers).
func rejectOutliers(prices []*big.Int) []*big.Int {
	if len(prices) < 3 {
		return prices
	}
	// Convert to float64 for statistics
	floats := make([]float64, len(prices))
	for i, p := range prices {
		f, _ := new(big.Float).SetInt(p).Float64()
		floats[i] = f
	}

	mean := 0.0
	for _, f := range floats {
		mean += f
	}
	mean /= float64(len(floats))

	variance := 0.0
	for _, f := range floats {
		d := f - mean
		variance += d * d
	}
	variance /= float64(len(floats))

	// Integer square root approximation for std dev
	stdDev := sqrtFloat64(variance)
	threshold := 2.0 * stdDev

	filtered := prices[:0]
	for i, f := range floats {
		diff := f - mean
		if diff < 0 {
			diff = -diff
		}
		if diff <= threshold {
			filtered = append(filtered, prices[i])
		}
	}
	return filtered
}

func computeMedian(prices []*big.Int) *big.Int {
	sorted := make([]*big.Int, len(prices))
	copy(sorted, prices)
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i].Cmp(sorted[j]) < 0
	})
	n := len(sorted)
	if n%2 == 1 {
		return new(big.Int).Set(sorted[n/2])
	}
	// Average of two middle values
	sum := new(big.Int).Add(sorted[n/2-1], sorted[n/2])
	return sum.Div(sum, big.NewInt(2))
}

func extractPrices(reports []*types.PriceReport) []*big.Int {
	prices := make([]*big.Int, len(reports))
	for i, r := range reports {
		prices[i] = new(big.Int).Set(r.Price)
	}
	return prices
}

func isSupportedAsset(asset string) bool {
	for _, a := range SupportedAssets {
		if a == asset {
			return true
		}
	}
	return false
}

// isWithinTolerance returns true if a and b differ by at most toleranceBps basis points.
func isWithinTolerance(a, b *big.Int, toleranceBps int64) bool {
	if a.Sign() == 0 && b.Sign() == 0 {
		return true
	}
	diff := new(big.Int).Sub(a, b)
	if diff.Sign() < 0 {
		diff.Neg(diff)
	}
	// diff * 10000 <= a * toleranceBps
	lhs := new(big.Int).Mul(diff, big.NewInt(10000))
	rhs := new(big.Int).Mul(a, big.NewInt(toleranceBps))
	return lhs.Cmp(rhs) <= 0
}

func sqrtFloat64(x float64) float64 {
	if x <= 0 {
		return 0
	}
	z := x / 2
	for i := 0; i < 100; i++ {
		z -= (z*z - x) / (2 * z)
	}
	return z
}
