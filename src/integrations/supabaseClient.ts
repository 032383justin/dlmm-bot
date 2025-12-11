/**
 * Supabase Client - Centralized database client for DLMM Bot
 * 
 * Uses SUPABASE_SERVICE_ROLE_KEY for full database access.
 * This is the SINGLE source of truth for database connections.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import logger from '../utils/logger';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Validate URL format
const isValidUrl = (url: string): boolean => {
    try {
        new URL(url);
        return true;
    } catch {
        return false;
    }
};

// Check if Supabase is properly configured
const supabaseConfigured = !!(
    SUPABASE_URL && 
    isValidUrl(SUPABASE_URL) && 
    SUPABASE_SERVICE_ROLE_KEY
);

if (!supabaseConfigured) {
    logger.error('[SUPABASE] Missing or invalid SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

/**
 * Supabase client instance
 * Uses service role key for full database access
 */
export const supabaseClient: SupabaseClient = supabaseConfigured
    ? createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!)
    : createClient('https://placeholder.supabase.co', 'placeholder-key');

/**
 * Check if Supabase is available for operations
 */
export function isSupabaseAvailable(): boolean {
    return supabaseConfigured;
}

export default supabaseClient;

