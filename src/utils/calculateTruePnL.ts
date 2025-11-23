
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

// Load env vars
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('Missing Supabase credentials');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function calculateTruePnL() {
    console.log('Fetching all EXIT logs...');

    try {
        const { data: logs, error } = await supabase
            .from('bot_logs')
            .select('*')
            .eq('action', 'EXIT')
            .order('timestamp', { ascending: true });

        if (error) {
            console.error('Error fetching logs:', error);
            return;
        }

        console.log(`Found ${logs.length} total EXIT logs.`);
        console.log('---------------------------------------------------');
        console.log('Timestamp           | Pool     | PnL    | Reason');
        console.log('---------------------------------------------------');

        let uniqueTrades = 0;
        // Map to track recent exits to detect duplicates
        // Key: pool_address, Value: timestamp
        const recentExits = new Map<string, number>();
        const DUPLICATE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes window

        for (const log of logs) {
            const details = typeof log.details === 'string' ? JSON.parse(log.details) : log.details;

            // Skip if no P&L data
            if (details.paperPnL === undefined || details.paperPnL === null) continue;

            const pool = details.pool;
            const timestamp = new Date(log.timestamp).getTime();

            // Check for duplicate
            if (recentExits.has(pool)) {
                const lastExitTime = recentExits.get(pool)!;
                if (timestamp - lastExitTime < DUPLICATE_WINDOW_MS) {
                    // Duplicate found
                    continue;
                }
            }

            // Mark as unique
            recentExits.set(pool, timestamp);
            uniqueTrades++;

            console.log(`${log.timestamp} | ${pool.slice(0, 8)} | $${details.paperPnL.toFixed(2)} | ${details.reason}`);
        }

        console.log('---------------------------------------------------');
        console.log(`Total Unique Trades: ${uniqueTrades}`);
        console.log(`(Note: P&L shown is cumulative. The final row shows the current True P&L)`);

    } catch (err) {
        console.error('Exception:', err);
    }
}

calculateTruePnL();
