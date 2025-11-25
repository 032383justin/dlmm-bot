"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkVolumeExitTrigger = exports.checkVolumeEntryTrigger = void 0;
const supabase_1 = require("../db/supabase");
const math_1 = require("../utils/math");
const logger_1 = __importDefault(require("../utils/logger"));
const checkVolumeEntryTrigger = async (pool) => {
    // Rule: volume1h > movingAverage1h AND velocity is increasing (high quality only)
    try {
        const { data, error } = await supabase_1.supabase
            .from('pool_snapshots')
            .select('data')
            .eq('pool_address', pool.address)
            .order('timestamp', { ascending: false })
            .limit(12); // Last 12 snapshots (assuming 5 min interval -> 1 hour)
        if (error || !data || data.length < 3) {
            // Not enough historical data (fresh start or new pool)
            // Bootstrap mode: Relaxed criteria for high-scoring pools
            // If score > 60, we trust the score and just need basic activity
            const isHighQuality = pool.score >= 60;
            const hasVolume = pool.volume24h > (isHighQuality ? 50000 : 100000);
            const hasVelocity = pool.velocity > (isHighQuality ? 5000 : 10000);
            const hasLiquidity = pool.liquidity > (isHighQuality ? 50000 : 100000);
            const bootstrapEntry = hasVolume && hasVelocity && hasLiquidity;
            if (bootstrapEntry) {
                logger_1.default.info(`📊 Bootstrap entry for ${pool.name} - Score ${pool.score.toFixed(1)} qualifies for entry`);
            }
            return bootstrapEntry;
        }
        const history = data.map((d) => d.data.volume1h);
        const ma1h = (0, math_1.calculateMovingAverage)(history);
        // Check velocity trend
        const currentVelocity = pool.velocity;
        const lastVelocity = data[0].data.velocity || 0;
        const isVolumeHigh = pool.volume1h > ma1h;
        const isVelocityIncreasing = currentVelocity > lastVelocity;
        // OPPORTUNISTIC: If score is very high (>70), be more aggressive
        // If score > 70: Enter if EITHER volume > MA OR velocity increasing
        // If score < 70: Require BOTH (safer)
        const isElite = pool.score >= 70;
        const shouldEnter = isElite ? (isVolumeHigh || isVelocityIncreasing) : (isVolumeHigh && isVelocityIncreasing);
        if (shouldEnter) {
            logger_1.default.info(`✅ Entry signal for ${pool.name} (Score ${pool.score.toFixed(1)}): Vol>${ma1h.toFixed(0)}? ${isVolumeHigh}, Vel↑? ${isVelocityIncreasing}`);
        }
        return shouldEnter;
    }
    catch (err) {
        logger_1.default.error(`Error checking volume trigger for ${pool.address}`, err);
        return false;
    }
};
exports.checkVolumeEntryTrigger = checkVolumeEntryTrigger;
const checkVolumeExitTrigger = async (pool) => {
    // Rule: velocity drops > 25% OR volume1h drops below 4h average
    try {
        const { data, error } = await supabase_1.supabase
            .from('pool_snapshots')
            .select('data')
            .eq('pool_address', pool.address)
            .order('timestamp', { ascending: false })
            .limit(48); // 4 hours history
        if (error || !data || data.length === 0)
            return false;
        const lastSnapshot = data[0].data;
        const lastVelocity = lastSnapshot.velocity || pool.velocity; // Avoid div by zero if missing
        const lastTVL = lastSnapshot.liquidity || pool.liquidity;
        const velocityDrop = (lastVelocity - pool.velocity) / lastVelocity;
        const tvlDrop = (lastTVL - pool.liquidity) / lastTVL;
        const volumeHistory = data.map((d) => d.data.volume1h);
        const ma4h = (0, math_1.calculateMovingAverage)(volumeHistory);
        // Guardrails:
        // 1. Velocity Drop > 30% (Momentum dying) - Relaxed from 20% to reduce false exits
        // 2. Volume < 4h MA (Trend reversal)
        // 3. TVL Drop > 10% (Panic/Rug/Dump)
        const velocityTrigger = velocityDrop > 0.30;
        const volumeTrigger = pool.volume1h < ma4h;
        const tvlTrigger = tvlDrop > 0.10;
        if (tvlTrigger) {
            logger_1.default.warn(`GUARDRAIL TRIGGERED: TVL dropped by ${(tvlDrop * 100).toFixed(2)}% for ${pool.name}`);
        }
        return velocityTrigger || volumeTrigger || tvlTrigger;
    }
    catch (err) {
        logger_1.default.error(`Error checking exit trigger for ${pool.address}`, err);
        return false;
    }
};
exports.checkVolumeExitTrigger = checkVolumeExitTrigger;
//# sourceMappingURL=volume.js.map