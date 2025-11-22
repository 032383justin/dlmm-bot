"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeMomentum = computeMomentum;
const calculateScore = (ratio) => {
    if (ratio >= 2) {
        return 1;
    }
    if (ratio >= 1.5) {
        return 0.8;
    }
    if (ratio >= 1.2) {
        return 0.6;
    }
    if (ratio >= 1) {
        return 0.4;
    }
    if (ratio >= 0.7) {
        return 0.2;
    }
    return 0;
};
function computeMomentum(input) {
    try {
        const { volume1h, volume4h } = input;
        const baseline = Math.max(volume4h / 4, 1);
        const ratio = volume1h / baseline;
        const score = calculateScore(ratio);
        const trendingUp = ratio >= 1;
        return {
            ratio,
            score,
            trendingUp,
        };
    }
    catch (error) {
        console.error('Failed to compute momentum metrics', error);
        return {
            ratio: 0,
            score: 0,
            trendingUp: false,
        };
    }
}
//# sourceMappingURL=momentum.js.map