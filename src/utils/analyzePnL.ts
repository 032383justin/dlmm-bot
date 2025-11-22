import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(
    process.env.SUPABASE_URL || '',
    process.env.SUPABASE_KEY || ''
);

const analyzeDailyPnL = async () => {
    console.log('\n📊 24-Hour P&L Analysis\n');
    console.log('='.repeat(80));

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data: logs, error } = await supabase
        .from('bot_logs')
        .select('*')
        .eq('action', 'EXIT')
        .gte('timestamp', oneDayAgo)
        .order('timestamp', { ascending: false });

    if (error) {
        console.error('Error fetching logs:', error);
        return;
    }

    if (!logs || logs.length === 0) {
        console.log('No exits found in the last 24 hours.');
        return;
    }

    let totalRealizedPnL = 0;
    let wins = 0;
    let losses = 0;

    // Fetch the last log *before* the 24h window to get the starting P&L.
    const { data: prevLog } = await supabase
        .from('bot_logs')
        .select('details')
        .lt('timestamp', oneDayAgo)
        .order('timestamp', { ascending: false })
        .limit(1)
        .single();

    let startingPnL = 0;
    if (prevLog && prevLog.details) {
        startingPnL = (prevLog.details as any).paperPnL || 0;
    }

    // Sort logs ascending for calculation
    const sortedLogs = [...logs].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    let currentPnL = startingPnL;

    console.log(`Starting Cumulative P&L (24h ago): $${startingPnL.toFixed(2)}\n`);

    const lossAnalysis: Record<string, { count: number, totalLoss: number }> = {};
    let legacyExits = 0;

    for (const log of sortedLogs) {
        const details = log.details as any;
        const newTotalPnL = details.paperPnL;

        if (newTotalPnL === undefined) {
            legacyExits++;
            continue;
        }

        const tradePnL = newTotalPnL - currentPnL;
        currentPnL = newTotalPnL;

        totalRealizedPnL += tradePnL;
        if (tradePnL > 0) wins++;
        else {
            losses++;
            const reason = details.reason || 'Unknown';
            if (!lossAnalysis[reason]) {
                lossAnalysis[reason] = { count: 0, totalLoss: 0 };
            }
            lossAnalysis[reason].count++;
            lossAnalysis[reason].totalLoss += tradePnL;
        }

        const time = new Date(log.timestamp).toLocaleString('en-US', {
            timeZone: 'America/New_York',
            hour: '2-digit',
            minute: '2-digit'
        });

        const color = tradePnL >= 0 ? '🟢' : '🔴';
        console.log(`${color} [${time}] ${details.pool || 'Unknown'}`);
        console.log(`   Reason: ${details.reason}`);
        console.log(`   Trade P&L: $${tradePnL.toFixed(2)}`);
        if (tradePnL < 0) {
            if (details.holdTimeMinutes) {
                console.log(`   Hold Time: ${Math.round(details.holdTimeMinutes)} mins`);
            }
        }
        console.log(`   Cumulative: $${newTotalPnL.toFixed(2)}\n`);
    }

    console.log('='.repeat(80));
    console.log(`Legacy Exits (Pre-Update): ${legacyExits}`);
    console.log(`Tracked Exits (New Logic): ${wins + losses}`);
    console.log(`Wins: ${wins} | Losses: ${losses} | Win Rate: ${((wins / (wins + losses)) * 100).toFixed(1)}%`);
    console.log(`\nTotal P&L (Tracked Only): $${(currentPnL - startingPnL).toFixed(2)}`);

    console.log('\n📉 LOSS ANALYSIS (Tracked Trades Only):');
    Object.entries(lossAnalysis).sort((a, b) => a[1].totalLoss - b[1].totalLoss).forEach(([reason, stats]) => {
        console.log(`   ${reason}: ${stats.count} trades, Total Loss: $${stats.totalLoss.toFixed(2)}`);
    });
    console.log('='.repeat(80));
};

analyzeDailyPnL().then(() => process.exit(0));
