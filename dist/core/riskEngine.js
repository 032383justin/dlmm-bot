"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkGlobalRisk = checkGlobalRisk;
exports.checkPoolRisk = checkPoolRisk;
const MAX_DEPLOY_RATIO = 0.85;
const MAX_POSITIONS = 7;
const EXIT_COOLDOWN_MIN = 15;
const SCORE_STOP_LOSS = 0.4;
const SUPPLY_CONCENTRATION_LIMIT = 0.4;
const minutesSince = (timestamp) => {
    if (!timestamp) {
        return Infinity;
    }
    return (Date.now() - timestamp) / 60000;
};
function checkGlobalRisk(state) {
    try {
        if (state.deployedCapital > state.totalCapital * MAX_DEPLOY_RATIO) {
            return { safe: false, reason: 'Too much capital deployed' };
        }
        if (state.activePositions > MAX_POSITIONS) {
            return { safe: false, reason: 'Too many active positions' };
        }
        if (minutesSince(state.lastExitTimestamp) < EXIT_COOLDOWN_MIN) {
            return { safe: false, reason: 'Exit cooldown active' };
        }
        return { safe: true };
    }
    catch (error) {
        console.error('Global risk check failed', error);
        return { safe: false, reason: 'Global risk evaluation error' };
    }
}
function checkPoolRisk(score, supplyConcentration) {
    try {
        if (score < SCORE_STOP_LOSS) {
            return { safe: false, reason: 'Score stop-loss triggered' };
        }
        if (supplyConcentration > SUPPLY_CONCENTRATION_LIMIT) {
            return { safe: false, reason: 'Supply concentration too high' };
        }
        // TODO: integrate on-chain concentration lookups for whale detection.
        // TODO: integrate with token metadata for richer safety checks.
        return { safe: true };
    }
    catch (error) {
        console.error('Pool risk check failed', error);
        return { safe: false, reason: 'Pool risk evaluation error' };
    }
}
//# sourceMappingURL=riskEngine.js.map