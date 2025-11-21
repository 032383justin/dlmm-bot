import { Pool } from './normalizePools';
import { supabase } from '../db/supabase';
import { calculateMovingAverage } from '../utils/math';
import logger from '../utils/logger';

export const checkVolumeEntryTrigger = async (pool: Pool): Promise<boolean> => {
    // Rule: volume1h > movingAverage1h AND velocity is increasing
    try {
        const { data, error } = await supabase
            .from('pool_snapshots')
            .select('data')
            .eq('pool_address', pool.address)
            .order('timestamp', { ascending: false })
            .limit(12); // Last 12 snapshots (assuming 5 min interval -> 1 hour)

        if (error || !data || data.length === 0) {
            // Not enough data, maybe new pool. Default to true if velocity is high? 
            // Or strict: false. User said "Only enter... when...". Strict.
            // But for a new bot, we have no history.
            // We will allow if volume is very high as a bootstrap, but strictly following rules:
            return false;
        }

        const history = data.map((d: any) => d.data.volume1h);
        const ma1h = calculateMovingAverage(history);

        // Check velocity trend
        const currentVelocity = pool.velocity;
        const lastVelocity = data[0].data.velocity || 0;

        const isVolumeHigh = pool.volume1h > ma1h;
        const isVelocityIncreasing = currentVelocity > lastVelocity;

        return isVolumeHigh && isVelocityIncreasing;
    } catch (err) {
        logger.error(`Error checking volume trigger for ${pool.address}`, err);
        return false;
    }
};

export const checkVolumeExitTrigger = async (pool: Pool): Promise<boolean> => {
    // Rule: velocity drops > 25% OR volume1h drops below 4h average
    try {
        const { data, error } = await supabase
            .from('pool_snapshots')
            .select('data')
            .eq('pool_address', pool.address)
            .order('timestamp', { ascending: false })
            .limit(48); // 4 hours history

        if (error || !data || data.length === 0) return false;

        const lastSnapshot = data[0].data;
        const lastVelocity = lastSnapshot.velocity || pool.velocity; // Avoid div by zero if missing
        const lastTVL = lastSnapshot.liquidity || pool.liquidity;

        const velocityDrop = (lastVelocity - pool.velocity) / lastVelocity;
        const tvlDrop = (lastTVL - pool.liquidity) / lastTVL;

        const volumeHistory = data.map((d: any) => d.data.volume1h);
        const ma4h = calculateMovingAverage(volumeHistory);

        // Guardrails:
        // 1. Velocity Drop > 20% (Momentum dying)
        // 2. Volume < 4h MA (Trend reversal)
        // 3. TVL Drop > 10% (Panic/Rug/Dump)

        const velocityTrigger = velocityDrop > 0.20;
        const volumeTrigger = pool.volume1h < ma4h;
        const tvlTrigger = tvlDrop > 0.10;

        if (tvlTrigger) {
            logger.warn(`GUARDRAIL TRIGGERED: TVL dropped by ${(tvlDrop * 100).toFixed(2)}% for ${pool.name}`);
        }

        return velocityTrigger || volumeTrigger || tvlTrigger;
    } catch (err) {
        logger.error(`Error checking exit trigger for ${pool.address}`, err);
        return false;
    }
};
