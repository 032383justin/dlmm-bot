"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const supabase_1 = require("../db/supabase");
const runReport = async () => {
    console.log('--- Fetching Latest Scoring Report ---');
    // Fetch last 50 snapshots
    const { data, error } = await supabase_1.supabase
        .from('pool_snapshots')
        .select('*')
        .order('timestamp', { ascending: false })
        .limit(50);
    if (error) {
        console.error('Error fetching data:', error.message);
        return;
    }
    if (!data || data.length === 0) {
        console.log('No scoring data found in Supabase.');
        return;
    }
    console.log(`Found ${data.length} records. Showing top scored pools from latest scan:\n`);
    // Deduplicate by pool address (keep latest)
    const latestPools = new Map();
    data.forEach((row) => {
        const pool = row.data;
        if (!latestPools.has(pool.address)) {
            latestPools.set(pool.address, pool);
        }
    });
    const sorted = Array.from(latestPools.values()).sort((a, b) => b.score - a.score);
    // Print Table
    console.table(sorted.map(p => ({
        Name: p.name,
        Score: p.score.toFixed(2),
        'Vel (24h)': p.volume24h.toFixed(0),
        'TVL': p.liquidity.toFixed(0),
        'Risk': p.riskScore,
        'Dilution': p.dilutionScore,
        'Daily Yield %': p.liquidity > 0 ? ((p.fees24h / p.liquidity) * 100).toFixed(2) + '%' : '0.00%',
        'Age (h)': ((Date.now() - p.createdAt) / (1000 * 60 * 60)).toFixed(1)
    })));
};
runReport();
//# sourceMappingURL=report.js.map