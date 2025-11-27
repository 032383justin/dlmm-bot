/**
 * DLMM Pool Fetcher Service
 * 
 * Production-grade DLMM pool discovery via Meteora REST API.
 * Direct connection to official Meteora DLMM endpoint.
 * 
 * GUARANTEES:
 * - NEVER throws
 * - NEVER crashes
 * - NEVER calls process.exit
 * - Always returns [] on failure
 */

import axios from 'axios';
import logger from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Normalized DLMM pool
 */
export interface DLMM_Pool {
    id: string;           // pool address
    mintA: string;        // baseMint
    mintB: string;        // quoteMint
    tvl: number;          // total value locked USD
    volume24h: number;    // 24h volume USD
    activeBin: number;
    binStep: number;
    feeTier: number;
    price: number;
}

/**
 * Raw Meteora API response item
 */
interface MeteoraPoolRaw {
    address?: string;
    name?: string;
    mint_x?: string;
    mint_y?: string;
    reserve_x?: string;
    reserve_y?: string;
    reserve_x_amount?: number;
    reserve_y_amount?: number;
    bin_step?: number;
    base_fee_percentage?: string;
    max_fee_percentage?: string;
    protocol_fee_percentage?: string;
    liquidity?: string;
    reward_mint_x?: string;
    reward_mint_y?: string;
    fees_24h?: number;
    today_fees?: number;
    trade_volume_24h?: number;
    cumulative_trade_volume?: string;
    cumulative_fee_volume?: string;
    current_price?: number;
    apr?: number;
    apy?: number;
    farm_apr?: number;
    farm_apy?: number;
    hide?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const METEORA_API_ENDPOINT = 'https://dlmm-api.meteora.ag/pair/all';

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN FETCH FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch DLMM pools from Meteora REST API
 * 
 * Direct GET to official Meteora endpoint:
 * https://dlmm-api.meteora.ag/pair/all
 * 
 * GUARANTEES:
 * - NEVER throws
 * - NEVER crashes
 * - NEVER calls process.exit
 * - Always returns DLMM_Pool[] (possibly empty)
 */
export async function fetchDLMMPools(): Promise<DLMM_Pool[]> {
    logger.info('[DISCOVERY] 🔍 Fetching pools from Meteora DLMM API...');

    try {
        const response = await axios.get(METEORA_API_ENDPOINT, {
            timeout: 30000,
        });

        // Check for valid response
        if (!response?.data) {
            logger.warn('[DISCOVERY] Meteora returned 0 pools');
            return [];
        }

        const rawPools: MeteoraPoolRaw[] = Array.isArray(response.data) 
            ? response.data 
            : [];

        if (rawPools.length === 0) {
            logger.warn('[DISCOVERY] Meteora returned 0 pools');
            return [];
        }

        // Normalize pools
        const normalized: DLMM_Pool[] = [];

        for (const p of rawPools) {
            try {
                // Skip pools without required fields
                if (!p.address || !p.mint_x || !p.mint_y) {
                    continue;
                }

                // Skip hidden pools
                if (p.hide === true) {
                    continue;
                }

                normalized.push({
                    id: p.address,
                    mintA: p.mint_x,
                    mintB: p.mint_y,
                    tvl: Number(p.liquidity ?? 0),
                    volume24h: Number(p.trade_volume_24h ?? 0),
                    activeBin: 0,  // Not directly available, will be fetched on-chain
                    binStep: Number(p.bin_step ?? 0),
                    feeTier: Number(p.base_fee_percentage ?? 0),
                    price: Number(p.current_price ?? 0),
                });
            } catch (err) {
                // Skip malformed pool
                continue;
            }
        }

        logger.info(`[DISCOVERY] Meteora DLMM pools: ${normalized.length}`);

        return normalized;

    } catch (err: any) {
        logger.error('[DISCOVERY] Meteora DLMM fetch FAILED', {
            error: err?.message || 'Unknown error',
            status: err?.response?.status || 'N/A',
        });
        return [];
    }
}

/**
 * Legacy compatibility wrapper
 * Maps to the old fetchRaydiumDLMMPools signature
 */
export async function fetchRaydiumDLMMPools(): Promise<DLMM_Pool[]> {
    logger.warn('[DISCOVERY] ⚠️ fetchRaydiumDLMMPools called - redirecting to Meteora');
    return fetchDLMMPools();
}
