import { Pool } from './normalizePools';
export declare const applySafetyFilters: (pool: Pool) => {
    passed: boolean;
    reason?: string;
};
export declare const calculateRiskScore: (pool: Pool) => number;
//# sourceMappingURL=safetyFilters.d.ts.map