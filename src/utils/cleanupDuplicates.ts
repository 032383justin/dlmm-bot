import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(
    process.env.SUPABASE_URL || '',
    process.env.SUPABASE_KEY || ''
);

async function cleanupDuplicatePositions() {
    console.log('🧹 Cleaning up duplicate position entries...\n');

    // Fetch all ENTRY and EXIT logs
    const { data: allLogs } = await supabase
        .from('bot_logs')
        .select('*')
        .in('action', ['ENTRY', 'EXIT'])
        .order('timestamp', { ascending: true });

    if (!allLogs) {
        console.log('No logs found');
        return;
    }

    // Build a map of pools with their entries and exits
    const poolMap = new Map<string, { entries: any[], exits: any[] }>();

    for (const log of allLogs) {
        const pool = (log.details as any)?.pool;
        if (!pool) continue;

        if (!poolMap.has(pool)) {
            poolMap.set(pool, { entries: [], exits: [] });
        }

        const poolData = poolMap.get(pool)!;
        if (log.action === 'ENTRY') {
            poolData.entries.push(log);
        } else {
            poolData.exits.push(log);
        }
    }

    // Find duplicate entries that need to be exited
    const duplicatesToExit: any[] = [];

    for (const [pool, data] of poolMap.entries()) {
        if (data.entries.length <= 1) continue;

        // Sort entries by timestamp
        const sortedEntries = data.entries.sort((a, b) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        );

        // Keep only the most recent entry, mark others as needing exit
        const mostRecent = sortedEntries[sortedEntries.length - 1];
        const duplicates = sortedEntries.slice(0, -1);

        for (const dup of duplicates) {
            // Check if this entry already has an exit after it
            const hasExit = data.exits.some(exit =>
                new Date(exit.timestamp) > new Date(dup.timestamp)
            );

            if (!hasExit) {
                duplicatesToExit.push({
                    pool,
                    entryTimestamp: dup.timestamp,
                    amount: (dup.details as any)?.amount || 0
                });
            }
        }
    }

    console.log(`Found ${duplicatesToExit.length} duplicate entries to clean up:\n`);

    for (const dup of duplicatesToExit) {
        console.log(`  - Pool: ${dup.pool.substring(0, 8)}...`);
        console.log(`    Entry time: ${dup.entryTimestamp}`);
        console.log(`    Amount: $${dup.amount.toFixed(2)}\n`);
    }

    if (duplicatesToExit.length === 0) {
        console.log('✅ No duplicates to clean up!');
        return;
    }

    console.log('Creating EXIT logs for duplicates...\n');

    for (const dup of duplicatesToExit) {
        const exitTimestamp = new Date(new Date(dup.entryTimestamp).getTime() + 1000).toISOString();

        const { error } = await supabase.from('bot_logs').insert({
            action: 'EXIT',
            details: {
                pool: dup.pool,
                reason: 'Cleanup: Duplicate entry removed',
                paperTrading: true
            },
            timestamp: exitTimestamp
        });

        if (error) {
            console.log(`❌ Error creating exit for ${dup.pool.substring(0, 8)}...: ${error.message}`);
        } else {
            console.log(`✅ Created exit for ${dup.pool.substring(0, 8)}...`);
        }
    }

    console.log('\n✅ Cleanup complete! Refresh your dashboard.');
}

cleanupDuplicatePositions().then(() => process.exit(0));
