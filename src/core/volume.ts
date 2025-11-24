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
        // 1. Velocity Drop > 30% (Momentum dying) - Relaxed from 20% to reduce false exits
        // 2. Volume < 4h MA (Trend reversal)
        // 3. TVL Drop > 10% (Panic/Rug/Dump)

        const velocityTrigger = velocityDrop > 0.30;
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
