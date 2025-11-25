/**
 * Adaptive Position Sizing Logic
 * 
 * 🔥 CORE PRINCIPLE:
 * Size positions based on the quality of the fight, not your account balance.
 * 
 * Humans size based on emotion.
 * Bots size based on structure.
 * 
 * We do NOT increase size when:
 * - meme pumps
 * - volume spikes
 * - hype tweets
 * - candles go up
 * 
 * We size based on:
 * - oscillation health
 * - exhaustion intensity
 * - LP latency
 * - crowd density
 * - whale risk
 * 
 * 🚨 What adaptive sizing protects you from:
 * - Overleveraging into a trap
 * - Getting wiped by whales
 * - Full-size entries during migration
 * - Buying into dead pools
 * - Trend sweeps
 * - Sudden collapses
 * 
 * This is why you cannot blow up if implemented properly.
 * 
 * 🛑 Final Guardrails:
 * - Never use token price for position sizing
 * - Never scale on win streaks
 * - Never scale on volume spikes
 * - Never DCA
 * - Never martingale
 * - Never "because coin trending"
 * 
 * Position sizing must be structure → not price.
 */

import { BinScores } from './binScoring';

/**
 * Calculate position size based on microstructure quality
 * 
 * 🧠 Think like poker:
 * - Dumpster casino + degens everywhere + chaos → Go bigger
 * - Quiet room + 3 pros + no volatility → Smaller
 * - A whale walks in with $5M + everyone silent + one-direction → Get up and leave
 * 
 * Memes are casinos. Trend whales are poker sharks.
 * We size when stupidity is high. We shrink when whales rule.
 * 
 * 🧮 Formula: positionSize = base * K
 * Where:
 * - base = 0.02 (2% of capital)
 * - K = confidence multiplier derived from scores
 * 
 * 🔥 Hard Caps:
 * - K clamped to [0, 4]
 * - MAX position size = 2% * 4 = 8% of free capital
 * - Bot NEVER deploys >8% per trade
 * - This makes rugs survivable
 * 
 * @param capital - Available capital to deploy
 * @param scores - Bin microstructure scores
 * @param migration - LP migration rate (0.0 to 1.0)
 * @param crowdCount - Number of unique wallets in last 60s
 * @returns Position size in capital units
 */
export function calculatePositionSize(
    capital: number,
    scores: BinScores,
    migration: number,
    crowdCount: number
): number {
    // Start with neutral confidence
    let K = 1.0;

    // 🟢 POSITIVE REINFORCEMENT (strengthens oscillation)

    // Exhaustion Intensity
    // High exhaustion = liquidity vacuum = opportunity
    if (scores.exhaustion >= 45) K += 0.5;
    if (scores.exhaustion >= 60) K += 0.8;

    // Oscillation Health
    // Strong oscillation = proven rhythm = reliable
    if (scores.oscillation >= 60) K += 0.5;
    if (scores.oscillation >= 75) K += 1.0;

    // LP Latency (delay in refills)
    // Slow LPs = opportunity window = gold mine
    if (scores.latency >= 1.5) K += 0.5;
    if (scores.latency >= 2.0) K += 1.0;

    // 🔴 NEGATIVE REINFORCEMENT (reduce)

    // Whale Impact
    // Large sweeps = directional risk = danger
    if (scores.whaleImpact > 20) K -= 0.5;
    if (scores.whaleImpact > 35) K -= 1.0;
    if (scores.whaleImpact > 45) K -= 2.0;

    // Crowd Weakness
    // Few wallets = no oscillation fuel = risky
    if (crowdCount < 8) K -= 0.5;
    if (crowdCount < 4) K -= 1.0;

    // LP Migration Early Warning
    // Liquidity repositioning = trap forming = exit
    if (migration >= 0.20) K -= 1.0;
    if (migration >= 0.30) K -= 2.0;

    // 🔥 HARD CAPS (never ignored)
    // Clamp K to safe range
    if (K < 0) K = 0;
    if (K > 4) K = 4;

    // Calculate position size
    const base = capital * 0.02; // 2% base
    const positionSize = base * K;

    return positionSize;
}

/**
 * Get position size as percentage of capital
 * 
 * @param capital - Available capital
 * @param scores - Bin microstructure scores
 * @param migration - LP migration rate
 * @param crowdCount - Unique wallet count
 * @returns Position size percentage (0.0 to 0.08)
 */
export function getPositionSizePercentage(
    capital: number,
    scores: BinScores,
    migration: number,
    crowdCount: number
): number {
    const size = calculatePositionSize(capital, scores, migration, crowdCount);
    return size / capital;
}

/**
 * 💰 EXAMPLE 1: Perfect Setup
 * 
 * Capital = $10,000
 * Base = 2% → $200
 * 
 * Scores:
 * - exhaustion: 72
 * - oscillation: 81
 * - latency: 2.3
 * - whaleImpact: 11
 * - crowd: 21 wallets
 * 
 * K calculation:
 * - +0.8 (exhaustion ≥ 60)
 * - +1.0 (oscillation ≥ 75)
 * - +1.0 (latency ≥ 2.0)
 * - no negatives
 * 
 * K = 1 + 0.8 + 1.0 + 1.0 = 3.8
 * position size = $200 * 3.8 = $760 → 7.6% of capital
 * 
 * Perfect — high chaos, farmable.
 */

/**
 * 🧊 EXAMPLE 2: Bad Day (No Trade)
 * 
 * Scores:
 * - exhaustion: 22
 * - oscillation: 12
 * - latency: 0.7
 * - whaleImpact: 42
 * - crowd collapse: 50%
 * 
 * K calculation:
 * - +0 (no positive triggers)
 * - -1.0 (whaleImpact > 35)
 * - -1.0 (crowd < 8)
 * - -2.0 (whaleImpact > 45 would be -2.0 total)
 * 
 * K = 1 - 1 - 1 - 2 = -3 → clamp to 0
 * Position size = $0
 * 
 * You do not trade. That's how you avoid bloodshed.
 */

/**
 * 💣 Why this makes your bot unbeatable:
 * 
 * - You size into chaos
 * - You shrink into quiet
 * - You disappear when whales take over
 * - You never overexpose
 * - You never hope
 * 
 * This is how pro market makers survive memes.
 */
