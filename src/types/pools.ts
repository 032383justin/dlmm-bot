/**
 * Raw DLMM pool configuration (minimal input from config)
 */
export interface DlmmPool {
    name: string;
    poolId: string; // actual Raydium pool address
}

/**
 * NormalizedPool - The canonical pool interface for the entire bot pipeline.
 * This is the minimum required shape for downstream scoring, volume modeling,
 * and microstructure analysis.
 * 
 * All pool data entering index.ts MUST conform to this interface.
 */
export interface NormalizedPool {
    // Core identifiers
    address: string;
    name: string;
    
    // Token pair (canonical field names)
    tokenX: string;
    tokenY: string;
    
    // Liquidity & Volume metrics
    liquidity: number;
    volume24h: number;
    
    // Yield metrics
    apr: number;
    fees24h: number;
}
