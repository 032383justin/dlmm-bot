import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import logger from '../utils/logger';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    logger.error('Missing Supabase URL or SUPABASE_SERVICE_ROLE_KEY in .env');
}

// Validate URL format to prevent crash
const isValidUrl = (url: string) => {
    try {
        new URL(url);
        return true;
    } catch {
        return false;
    }
};

export const supabase = (supabaseUrl && isValidUrl(supabaseUrl) && supabaseKey)
    ? createClient(supabaseUrl, supabaseKey)
    : {
        from: () => ({
            select: () => ({ eq: () => ({ order: () => ({ limit: () => ({ data: [], error: 'Mock Client: No DB connection' }) }) }) }),
            insert: () => ({ error: 'Mock Client: No DB connection' })
        })
    } as any; // Mock client to prevent crash if config missing

export const logAction = async (action: string, details: any) => {
    const { error } = await supabase.from('bot_logs').insert({
        action,
        details,
        timestamp: new Date().toISOString(),
    });

    if (error) {
        logger.error('Failed to log action to Supabase', error);
    }
};

export const saveSnapshot = async (poolData: any) => {
    const { error } = await supabase.from('pool_snapshots').insert({
        pool_address: poolData.address,
        data: poolData,
        timestamp: new Date().toISOString()
    });
    if (error) {
        logger.error('Failed to save snapshot', error);
    }
}
