"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveSnapshot = exports.logAction = exports.supabase = void 0;
const supabase_js_1 = require("@supabase/supabase-js");
const dotenv_1 = __importDefault(require("dotenv"));
const logger_1 = __importDefault(require("../utils/logger"));
dotenv_1.default.config();
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
if (!supabaseUrl || !supabaseKey) {
    logger_1.default.error('Missing Supabase URL or Key in .env');
    // We don't throw here to allow other parts to run if DB is optional, 
    // but for this bot it is required.
    // process.exit(1); 
}
if (!supabaseUrl || !supabaseKey) {
    logger_1.default.error('Missing Supabase URL or Key in .env');
}
// Validate URL format to prevent crash
const isValidUrl = (url) => {
    try {
        new URL(url);
        return true;
    }
    catch {
        return false;
    }
};
exports.supabase = (supabaseUrl && isValidUrl(supabaseUrl) && supabaseKey)
    ? (0, supabase_js_1.createClient)(supabaseUrl, supabaseKey)
    : {
        from: () => ({
            select: () => ({ eq: () => ({ order: () => ({ limit: () => ({ data: [], error: 'Mock Client: No DB connection' }) }) }) }),
            insert: () => ({ error: 'Mock Client: No DB connection' })
        })
    }; // Mock client to prevent crash if config missing
const logAction = async (action, details) => {
    const { error } = await exports.supabase.from('bot_logs').insert({
        action,
        details,
        timestamp: new Date().toISOString(),
    });
    if (error) {
        logger_1.default.error('Failed to log action to Supabase', error);
    }
};
exports.logAction = logAction;
const saveSnapshot = async (poolData) => {
    const { error } = await exports.supabase.from('pool_snapshots').insert({
        pool_address: poolData.address,
        data: poolData,
        timestamp: new Date().toISOString()
    });
    if (error) {
        logger_1.default.error('Failed to save snapshot', error);
    }
};
exports.saveSnapshot = saveSnapshot;
//# sourceMappingURL=supabase.js.map