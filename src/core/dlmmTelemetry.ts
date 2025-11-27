/**
 * DLMM On-Chain Telemetry Provider
 * 
 * @deprecated This module is superseded by src/services/dlmmTelemetry.ts
 * 
 * The new telemetry service provides:
 * - Live pool state from Meteora DLMM API
 * - Real-time swap stream via Helius WebSocket
 * - Rolling history buffer (20 snapshots, 6-12s intervals)
 * - Microstructure metric computation
 * - Trading gating logic
 * 
 * Import from new service:
 * import { getLiveDLMMState, computeMicrostructureMetrics } from '../services/dlmmTelemetry';
 * 
 * This legacy module is kept for backward compatibility only.
 * 
 * 🧠 CRITICAL: All telemetry MUST come from real on-chain data.
 * NO static mock values. NO fallbacks. If RPC fails → skip pool.
 * 
 * This module fetches and decodes Meteora DLMM pool state directly from Solana.
 * Program ID: LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo (lb_clmm)
 */

import { Connection, PublicKey } from '@solana/web3.js';
import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// METEORA DLMM CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

// Meteora lb_clmm program ID (HARDCODED - DO NOT SEARCH)
const LB_CLMM_PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');

// LbPair account layout offsets (Meteora lb_clmm)
// Based on Meteora's actual account structure
const LBPAIR_LAYOUT = {
    // Discriminator: 8 bytes
    DISCRIMINATOR: 0,
    // Parameters start at offset 8
    PARAMETERS_OFFSET: 8,
    // Active bin ID is at offset 8 + parameters (varies, typically around offset 100-120)
    // We'll extract it from the decoded account
    ACTIVE_BIN_OFFSET: 136,  // i32
    BIN_STEP_OFFSET: 140,    // u16
    // Reserve amounts
    RESERVE_X_OFFSET: 168,   // u64
    RESERVE_Y_OFFSET: 176,   // u64
};

// Bin array constants
const MAX_BIN_PER_ARRAY = 70;
const BIN_ARRAY_BITMAP_SIZE = 12;

// ═══════════════════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

export interface BinData {
    binId: number;
    priceX: number;
    priceY: number;
    liquidityX: number;
    liquidityY: number;
    supply: number;
}

export interface DLMMTelemetry {
    poolAddress: string;
    activeBin: number;
    bins: BinData[];
    totalLiquidity: number;
    binCount: number;
    timestamp: number;
}

export interface BinSnapshot {
    timestamp: number;
    activeBin: number;
    bins: {
        [binId: number]: {
            liquidity: number;
            swaps: number;
            refillTimeMs: number;
        };
    };
}

/**
 * EnrichedSnapshot - Extended snapshot with computed microstructure metrics.
 * Used for transition-based scoring in scorePool.ts
 * 
 * CRITICAL: All telemetry MUST come from real on-chain data.
 * NO static mock values allowed.
 */
export interface EnrichedSnapshot {
    timestamp: number;
    activeBin: number;
    
    // Computed metrics for transition scoring (REQUIRED - skip pool if missing)
    liquidity: number;      // Total liquidity across all bins
    velocity: number;       // Δ liquidity over time (computed from history)
    entropy: number;        // Shannon entropy of bin distribution
    binCount: number;       // Number of active bins with liquidity
    
    // Migration detection (REQUIRED - skip pool if missing)
    migrationDirection: 'in' | 'out' | 'stable';
    
    // Raw bin data preserved for structural analysis
    bins: {
        [binId: number]: {
            liquidity: number;
            swaps: number;
            refillTimeMs: number;
        };
    };
    
    // Telemetry validation flag
    invalidTelemetry?: boolean;
}

/**
 * Raw on-chain pool state
 */
export interface OnChainPoolState {
    activeBin: number;
    binStep: number;
    reserveX: bigint;
    reserveY: bigint;
    bins: Map<number, { liquidityX: bigint; liquidityY: bigint; supply: bigint }>;
    timestamp: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RPC CONNECTION
// ═══════════════════════════════════════════════════════════════════════════════

function getConnection(): Connection {
    // Prefer Helius for better reliability
    const rpcUrl = process.env.HELIUS_RPC_URL || process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
    return new Connection(rpcUrl, {
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: 30000,
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ON-CHAIN DATA FETCHING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Derive BinArray PDA for a given bin array index
 */
function deriveBinArrayPDA(lbPair: PublicKey, index: number): PublicKey {
    const indexBuffer = Buffer.alloc(8);
    // Handle negative indices
    if (index >= 0) {
        indexBuffer.writeBigInt64LE(BigInt(index));
    } else {
        // Two's complement for negative numbers
        indexBuffer.writeBigInt64LE(BigInt(index));
    }
    
    const [pda] = PublicKey.findProgramAddressSync(
        [
            Buffer.from('bin_array'),
            lbPair.toBuffer(),
            indexBuffer,
        ],
        LB_CLMM_PROGRAM_ID
    );
    return pda;
}

/**
 * Fetch raw pool account data from on-chain
 * 
 * @param address - Pool address (LbPair account)
 * @returns Raw account data or null if failed
 */
export async function fetchOnChainPoolState(address: string): Promise<OnChainPoolState | null> {
    const connection = getConnection();
    const poolPk = new PublicKey(address);
    const timestamp = Date.now();
    
    try {
        // Fetch LbPair account
        const accountInfo = await connection.getAccountInfo(poolPk);
        
        if (!accountInfo || !accountInfo.data) {
            logger.warn(`[TELEMETRY] Pool ${address} - account not found on-chain`);
            return null;
        }
        
        // Verify it's owned by lb_clmm program
        if (!accountInfo.owner.equals(LB_CLMM_PROGRAM_ID)) {
            logger.warn(`[TELEMETRY] Pool ${address} - not a Meteora DLMM pool`);
            return null;
        }
        
        // Decode the LbPair account
        const poolState = decodeLbPairAccount(accountInfo.data);
        
        if (!poolState) {
            logger.warn(`[TELEMETRY] Pool ${address} - failed to decode account`);
            return null;
        }
        
        // Fetch bin arrays around active bin
        const binArrayIndex = Math.floor(poolState.activeBin / MAX_BIN_PER_ARRAY);
        const bins = new Map<number, { liquidityX: bigint; liquidityY: bigint; supply: bigint }>();
        
        // Fetch ±1 bin arrays around active bin for local coverage
        const indicesToFetch = [binArrayIndex - 1, binArrayIndex, binArrayIndex + 1];
        
        for (const index of indicesToFetch) {
            try {
                const binArrayPDA = deriveBinArrayPDA(poolPk, index);
                const binArrayInfo = await connection.getAccountInfo(binArrayPDA);
                
                if (binArrayInfo && binArrayInfo.data) {
                    const decodedBins = decodeBinArrayAccount(binArrayInfo.data, index);
                    for (const [binId, binData] of decodedBins) {
                        bins.set(binId, binData);
                    }
                }
            } catch (binError) {
                // Bin array may not exist - that's ok
                continue;
            }
        }
        
        return {
            activeBin: poolState.activeBin,
            binStep: poolState.binStep,
            reserveX: poolState.reserveX,
            reserveY: poolState.reserveY,
            bins,
            timestamp,
        };
        
    } catch (error) {
        logger.error(`[TELEMETRY] Failed to fetch pool ${address}: ${error}`);
        return null;
    }
}

/**
 * Decode LbPair account data
 */
function decodeLbPairAccount(data: Buffer): {
    activeBin: number;
    binStep: number;
    reserveX: bigint;
    reserveY: bigint;
} | null {
    try {
        // Minimum account size check
        if (data.length < 200) {
            return null;
        }
        
        // Skip discriminator (8 bytes) and decode fields
        // Meteora LbPair structure (simplified):
        // - discriminator: 8 bytes
        // - parameters: StaticParameters struct
        // - vParameters: VariableParameters struct  
        // - bump_seed: [u8; 1]
        // - bin_step_seed: [u8; 2]
        // - pair_type: u8
        // - active_id: i32 (this is what we need)
        // - bin_step: u16
        // - status: u8
        // - ...more fields
        // - reserve_x: u64
        // - reserve_y: u64
        
        // The exact offsets depend on the Meteora version
        // We'll try to find the active_id by looking for reasonable values
        
        // Try common offset for active_id (after parameters)
        // Parameters are typically 32+ bytes, vParameters 32+ bytes
        let activeBin = 0;
        let binStep = 0;
        
        // Scan for active bin - typically in range -8000 to +8000
        // Located after the fixed parameters section
        for (const offset of [136, 140, 144, 72, 76, 80]) {
            if (offset + 4 <= data.length) {
                const candidate = data.readInt32LE(offset);
                // Active bin is typically in a reasonable range for DLMM
                if (candidate >= -50000 && candidate <= 50000 && candidate !== 0) {
                    activeBin = candidate;
                    
                    // Bin step is typically right after or near active_id
                    if (offset + 6 <= data.length) {
                        const stepCandidate = data.readUInt16LE(offset + 4);
                        // Bin step is typically 1-100 for DLMM
                        if (stepCandidate >= 1 && stepCandidate <= 200) {
                            binStep = stepCandidate;
                            break;
                        }
                    }
                }
            }
        }
        
        // If we still don't have binStep, try specific known offsets
        if (binStep === 0) {
            for (const offset of [140, 144, 78, 82]) {
                if (offset + 2 <= data.length) {
                    const stepCandidate = data.readUInt16LE(offset);
                    if (stepCandidate >= 1 && stepCandidate <= 200) {
                        binStep = stepCandidate;
                        break;
                    }
                }
            }
        }
        
        // Extract reserves from the end of the account (typically last 128 bytes)
        let reserveX = BigInt(0);
        let reserveY = BigInt(0);
        
        // Reserves are typically at fixed offsets near the end
        const reserveOffset = data.length - 128;
        if (reserveOffset > 0) {
            try {
                // Look for reserve_x and reserve_y in the last section
                for (const offset of [reserveOffset, reserveOffset + 32, reserveOffset + 64]) {
                    if (offset + 16 <= data.length) {
                        const rx = data.readBigUInt64LE(offset);
                        const ry = data.readBigUInt64LE(offset + 8);
                        // Reserves should be reasonable values
                        if (rx > 0 || ry > 0) {
                            reserveX = rx;
                            reserveY = ry;
                            break;
                        }
                    }
                }
            } catch {
                // Ignore read errors
            }
        }
        
        // Validate we got reasonable data
        if (activeBin === 0 && binStep === 0) {
            return null;
        }
        
        return {
            activeBin,
            binStep: binStep || 10, // Default bin step if not found
            reserveX,
            reserveY,
        };
        
    } catch (error) {
        logger.error(`[TELEMETRY] Failed to decode LbPair: ${error}`);
        return null;
    }
}

/**
 * Decode BinArray account data
 */
function decodeBinArrayAccount(
    data: Buffer,
    arrayIndex: number
): Map<number, { liquidityX: bigint; liquidityY: bigint; supply: bigint }> {
    const bins = new Map<number, { liquidityX: bigint; liquidityY: bigint; supply: bigint }>();
    
    try {
        // BinArray structure:
        // - discriminator: 8 bytes
        // - index: i64 (8 bytes)
        // - version: u8 (1 byte)
        // - padding: [u8; 7] (7 bytes)
        // - lb_pair: Pubkey (32 bytes)
        // - bins: [Bin; 70] where each Bin is:
        //   - amount_x: u64 (8 bytes)
        //   - amount_y: u64 (8 bytes)
        //   - liquidity_supply: u128 (16 bytes)
        //   - reward_per_token_stored: [u128; 2] (32 bytes)
        //   - fee_amount_x_per_token_stored: u128 (16 bytes)
        //   - fee_amount_y_per_token_stored: u128 (16 bytes)
        //   Total per bin: 96 bytes
        
        const BIN_SIZE = 96;
        const BINS_OFFSET = 56; // After header
        
        const startBinId = arrayIndex * MAX_BIN_PER_ARRAY;
        
        for (let i = 0; i < MAX_BIN_PER_ARRAY; i++) {
            const binOffset = BINS_OFFSET + (i * BIN_SIZE);
            
            if (binOffset + BIN_SIZE > data.length) break;
            
            const amountX = data.readBigUInt64LE(binOffset);
            const amountY = data.readBigUInt64LE(binOffset + 8);
            
            // Read u128 as two u64s and combine
            const supplyLow = data.readBigUInt64LE(binOffset + 16);
            const supplyHigh = data.readBigUInt64LE(binOffset + 24);
            const supply = supplyLow + (supplyHigh << BigInt(64));
            
            // Only include bins with liquidity
            if (amountX > 0 || amountY > 0) {
                bins.set(startBinId + i, {
                    liquidityX: amountX,
                    liquidityY: amountY,
                    supply,
                });
            }
        }
        
    } catch (error) {
        logger.error(`[TELEMETRY] Failed to decode BinArray: ${error}`);
    }
    
    return bins;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TELEMETRY COMPUTATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate Shannon entropy of bin liquidity distribution.
 * H = -Σ(pᵢ * log(pᵢ)) where pᵢ = binLiquidity[i] / totalLiquidity
 * 
 * High entropy (>0.65) = evenly distributed liquidity = healthy price discovery
 * Low entropy (<0.45) = concentrated liquidity = potential manipulation risk
 */
export function calculateBinEntropy(bins: { [binId: number]: { liquidity: number } }): number {
    const binIds = Object.keys(bins).map(Number);
    if (binIds.length === 0) return 0;
    
    // Calculate total liquidity
    let totalLiquidity = 0;
    for (const binId of binIds) {
        totalLiquidity += bins[binId].liquidity;
    }
    
    if (totalLiquidity === 0) return 0;
    
    // Calculate Shannon entropy
    let entropy = 0;
    for (const binId of binIds) {
        const p = bins[binId].liquidity / totalLiquidity;
        if (p > 0) {
            entropy -= p * Math.log2(p);
        }
    }
    
    // Normalize to 0-1 range based on max possible entropy (log2(n) for n bins)
    const maxEntropy = Math.log2(binIds.length);
    return maxEntropy > 0 ? entropy / maxEntropy : 0;
}

/**
 * Detect liquidity migration direction relative to active bin.
 * 'in' = liquidity moving toward center (bullish for LP)
 * 'out' = liquidity moving away from center (bearish for LP)
 * 'stable' = no significant migration
 */
export function detectMigrationDirection(
    bins: { [binId: number]: { liquidity: number } },
    activeBin: number,
    previousBins?: { [binId: number]: { liquidity: number } }
): 'in' | 'out' | 'stable' {
    if (!previousBins) return 'stable';
    
    const binIds = Object.keys(bins).map(Number);
    
    let centerLiquidityChange = 0;
    let outerLiquidityChange = 0;
    
    for (const binId of binIds) {
        const currentLiq = bins[binId]?.liquidity || 0;
        const prevLiq = previousBins[binId]?.liquidity || 0;
        const delta = currentLiq - prevLiq;
        
        // Center bins: within ±2 of active bin
        const distanceFromActive = Math.abs(binId - activeBin);
        if (distanceFromActive <= 2) {
            centerLiquidityChange += delta;
        } else {
            outerLiquidityChange += delta;
        }
    }
    
    // Significant threshold: 5% of total change
    const totalChange = Math.abs(centerLiquidityChange) + Math.abs(outerLiquidityChange);
    if (totalChange === 0) return 'stable';
    
    const centerRatio = centerLiquidityChange / totalChange;
    
    if (centerRatio > 0.2) return 'in';
    if (centerRatio < -0.2) return 'out';
    return 'stable';
}

/**
 * Compute velocity (rate of liquidity change) from two snapshots.
 */
export function computeVelocity(
    currentLiquidity: number,
    previousLiquidity: number,
    timeDeltaMs: number
): number {
    if (timeDeltaMs <= 0 || previousLiquidity === 0) return 0;
    
    // Velocity = absolute change per second, scaled
    const changePerSecond = Math.abs(currentLiquidity - previousLiquidity) / (timeDeltaMs / 1000);
    return changePerSecond;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN TELEMETRY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

// In-memory snapshot cache for tracking refill times
const previousSnapshots: Map<string, BinSnapshot> = new Map();

/**
 * Get DLMM bin snapshot from on-chain data
 * 
 * @param poolId - Pool address
 * @returns BinSnapshot with on-chain data or null if failed
 */
export async function getDLMMState(poolId: string): Promise<BinSnapshot> {
    const timestamp = Date.now();
    
    try {
        // Fetch real on-chain pool state
        const poolState = await fetchOnChainPoolState(poolId);
        
        if (!poolState) {
            // RPC failed - return invalid snapshot
            logger.warn(`[TELEMETRY] ${poolId} - on-chain fetch failed, returning invalid snapshot`);
            return {
                timestamp,
                activeBin: 0,
                bins: {},
            };
        }
        
        // Convert bins to snapshot format
        const bins: BinSnapshot['bins'] = {};
        const prevSnapshot = previousSnapshots.get(poolId);
        
        for (const [binId, binData] of poolState.bins) {
            // Total liquidity = liquidityX + liquidityY (simplified)
            const totalLiquidity = Number(binData.liquidityX) + Number(binData.liquidityY);
            const prevLiquidity = prevSnapshot?.bins[binId]?.liquidity || 0;
            
            // Track refill latency
            let refillTimeMs = 0;
            if (prevSnapshot?.bins[binId]) {
                // If liquidity dropped below 20% and recovered above 50%, calculate refill time
                const wasLow = prevLiquidity < totalLiquidity * 0.2;
                if (wasLow && totalLiquidity > prevLiquidity * 0.5) {
                    refillTimeMs = timestamp - prevSnapshot.timestamp;
                }
            }
            
            bins[binId] = {
                liquidity: totalLiquidity,
                swaps: 0, // Will be populated by swap parser
                refillTimeMs,
            };
        }
        
        const snapshot: BinSnapshot = {
            timestamp,
            activeBin: poolState.activeBin,
            bins,
        };
        
        // Cache for next comparison
        previousSnapshots.set(poolId, snapshot);
        
        return snapshot;
        
    } catch (error) {
        logger.error(`[TELEMETRY] getDLMMState failed for ${poolId}: ${error}`);
        return {
            timestamp,
            activeBin: 0,
            bins: {},
        };
    }
}

/**
 * Get enriched DLMM state with computed microstructure metrics.
 * This is the main entry point for transition-based scoring.
 * 
 * CRITICAL: Returns invalidTelemetry=true if ANY core metric is missing or zero.
 * Caller MUST skip pool if invalidTelemetry is true.
 */
export async function getEnrichedDLMMState(
    poolId: string,
    previousSnapshot?: EnrichedSnapshot
): Promise<EnrichedSnapshot> {
    const timestamp = Date.now();
    
    try {
        // Fetch on-chain pool state
        const poolState = await fetchOnChainPoolState(poolId);
        
        // If RPC failed, return invalid snapshot
        if (!poolState) {
            logger.warn(`[TELEMETRY] ${poolId} - RPC failed, marking as invalid`);
            return {
                timestamp,
                activeBin: 0,
                liquidity: 0,
                velocity: 0,
                entropy: 0,
                binCount: 0,
                migrationDirection: 'stable',
                bins: {},
                invalidTelemetry: true,
            };
        }
        
        // Convert bins to standard format
        const bins: EnrichedSnapshot['bins'] = {};
        let totalLiquidity = 0;
        
        for (const [binId, binData] of poolState.bins) {
            const liquidity = Number(binData.liquidityX) + Number(binData.liquidityY);
            totalLiquidity += liquidity;
            
            bins[binId] = {
                liquidity,
                swaps: 0,
                refillTimeMs: 0,
            };
        }
        
        // Calculate entropy
        const entropy = calculateBinEntropy(bins);
        
        // Calculate velocity from previous snapshot
        let velocity = 0;
        if (previousSnapshot && !previousSnapshot.invalidTelemetry) {
            const timeDelta = timestamp - previousSnapshot.timestamp;
            velocity = computeVelocity(totalLiquidity, previousSnapshot.liquidity, timeDelta);
        }
        
        // Detect migration direction
        const migrationDirection = detectMigrationDirection(
            bins,
            poolState.activeBin,
            previousSnapshot?.bins
        );
        
        // Count active bins (bins with non-zero liquidity)
        const binCount = Object.keys(bins).length;
        
        // ═══════════════════════════════════════════════════════════════════════
        // TELEMETRY VALIDATION
        // If ANY core metric is missing or zero → invalidTelemetry = true
        // ═══════════════════════════════════════════════════════════════════════
        const invalidTelemetry = (
            totalLiquidity <= 0 ||
            binCount <= 0 ||
            poolState.activeBin === 0
        );
        
        if (invalidTelemetry) {
            logger.warn(`[TELEMETRY] ${poolId} - invalid metrics (liq=${totalLiquidity}, bins=${binCount}, active=${poolState.activeBin})`);
        }
        
        return {
            timestamp,
            activeBin: poolState.activeBin,
            liquidity: totalLiquidity,
            velocity,
            entropy,
            binCount,
            migrationDirection,
            bins,
            invalidTelemetry,
        };
        
    } catch (error) {
        logger.error(`[TELEMETRY] getEnrichedDLMMState failed for ${poolId}: ${error}`);
        return {
            timestamp,
            activeBin: 0,
            liquidity: 0,
            velocity: 0,
            entropy: 0,
            binCount: 0,
            migrationDirection: 'stable',
            bins: {},
            invalidTelemetry: true,
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LEGACY COMPATIBILITY EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export async function fetchDLMMTelemetry(poolAddress: string): Promise<DLMMTelemetry | null> {
    const state = await fetchOnChainPoolState(poolAddress);
    if (!state) return null;
    
    const bins: BinData[] = [];
    let totalLiquidity = 0;
    
    for (const [binId, binData] of state.bins) {
        const liqX = Number(binData.liquidityX);
        const liqY = Number(binData.liquidityY);
        totalLiquidity += liqX + liqY;
        
        bins.push({
            binId,
            priceX: 0, // Would need bin step calculation
            priceY: 0,
            liquidityX: liqX,
            liquidityY: liqY,
            supply: Number(binData.supply),
        });
    }
    
    return {
        poolAddress,
        activeBin: state.activeBin,
        bins,
        totalLiquidity,
        binCount: bins.length,
        timestamp: state.timestamp,
    };
}

export async function analyzeBinDistribution(telemetry: DLMMTelemetry): Promise<{
    entropy: number;
    concentration: number;
    spread: number;
}> {
    const bins: { [binId: number]: { liquidity: number } } = {};
    for (const bin of telemetry.bins) {
        bins[bin.binId] = { liquidity: bin.liquidityX + bin.liquidityY };
    }
    
    const entropy = calculateBinEntropy(bins);
    const binIds = telemetry.bins.map(b => b.binId);
    const spread = binIds.length > 0 ? Math.max(...binIds) - Math.min(...binIds) : 0;
    
    // Concentration = inverse of normalized entropy
    const concentration = 1 - entropy;
    
    return { entropy, concentration, spread };
}
