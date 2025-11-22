import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(
    process.env.SUPABASE_URL || '',
    process.env.SUPABASE_KEY || ''
);

const viewTradingLogs = async () => {
    console.log('\n📊 Recent Trading Activity\n');
    console.log('='.repeat(80));

    const { data: logs, error } = await supabase
        .from('bot_logs')
        .select('*')
        .in('action', ['ENTRY', 'EXIT'])
        .order('timestamp', { ascending: false })
        .limit(20);

    if (error) {
        console.error('Error fetching logs:', error);
        return;
    }

    if (!logs || logs.length === 0) {
        console.log('No trading activity found.');
        return;
    }

    for (const log of logs) {
        const time = new Date(log.timestamp).toLocaleString('en-US', {
            timeZone: 'America/New_York',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });

        const details = log.details as any;
        const action = log.action === 'ENTRY' ? '🟢 ENTRY' : '🔴 EXIT';

        console.log(`\n${action} | ${time}`);

        if (log.action === 'ENTRY') {
            console.log(`  Pool: ${details.pool || 'Unknown'}`);
            console.log(`  Score: ${details.score?.toFixed(2) || 'N/A'}`);
            console.log(`  Amount: $${details.amount?.toFixed(0) || 'N/A'}`);
            console.log(`  Type: ${details.type || 'N/A'}`);
            if (details.paperBalance) {
                console.log(`  Balance: $${details.paperBalance.toFixed(2)}`);
            }
        } else {
            console.log(`  Pool: ${details.pool || 'Unknown'}`);
            console.log(`  Reason: ${details.reason || 'N/A'}`);
            if (details.peakScore) {
                console.log(`  Peak Score: ${details.peakScore.toFixed(2)}`);
            }
            if (details.currentScore) {
                console.log(`  Current Score: ${details.currentScore.toFixed(2)}`);
            }
            if (details.paperPnL !== undefined) {
                console.log(`  Total P&L: $${details.paperPnL.toFixed(2)}`);
            }
        }
    }

    console.log('\n' + '='.repeat(80));
    console.log(`\nTotal logs shown: ${logs.length}`);
};

viewTradingLogs().then(() => process.exit(0));
