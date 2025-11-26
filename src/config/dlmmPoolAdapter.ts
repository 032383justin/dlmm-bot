/**
 * dlmmPoolAdapter.ts - Backwards compatibility re-export layer.
 * 
 * This module re-exports from the canonical poolAdapter.ts.
 * Existing imports from this file will continue to work unchanged.
 * 
 * The actual adapter implementation lives in ./poolAdapter.ts
 */

export { 
    adaptDLMMPools, 
    DLMMPoolConfig,
    NormalizedPool,
    Pool 
} from './poolAdapter';
