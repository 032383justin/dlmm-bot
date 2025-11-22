export interface GlobalRiskState {
    totalCapital: number;
    deployedCapital: number;
    activePositions: number;
    lastExitTimestamp?: number;
}
export interface RiskCheckResult {
    safe: boolean;
    reason?: string;
}
export declare function checkGlobalRisk(state: GlobalRiskState): RiskCheckResult;
export declare function checkPoolRisk(score: number, supplyConcentration: number): RiskCheckResult;
//# sourceMappingURL=riskEngine.d.ts.map