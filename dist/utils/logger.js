"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const winston_1 = __importDefault(require("winston"));
const winston_transport_1 = __importDefault(require("winston-transport"));
const supabase_js_1 = require("@supabase/supabase-js");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    supabase = (0, supabase_js_1.createClient)(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    console.log('[LOGGING] Critical logging to Supabase enabled');
}
else {
    console.log('[LOGGING] Supabase logging disabled – missing service role key');
}
class SupabaseCriticalTransport extends winston_transport_1.default {
    constructor(opts) {
        super(opts);
        this.client = opts.supabaseClient;
    }
    log(info, callback) {
        setImmediate(() => {
            this.emit('logged', info);
        });
        const level = info.level;
        const message = info.message;
        const isCritical = level === 'error' ||
            level === 'warn' ||
            message.includes('ENTRY') ||
            message.includes('EXIT') ||
            message.includes('KILL') ||
            message.includes('REGIME');
        if (isCritical) {
            Promise.resolve(this.client.from('bot_logs').insert({
                action: level,
                details: { message },
                timestamp: new Date().toISOString()
            })).catch(() => { });
        }
        callback();
    }
}
const transports = [
    new winston_1.default.transports.Console({
        format: winston_1.default.format.combine(winston_1.default.format.colorize(), winston_1.default.format.simple()),
    }),
    new winston_1.default.transports.File({ filename: 'error.log', level: 'error' }),
    new winston_1.default.transports.File({ filename: 'combined.log' }),
];
if (supabase) {
    transports.push(new SupabaseCriticalTransport({ supabaseClient: supabase }));
}
const logger = winston_1.default.createLogger({
    level: 'info',
    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json()),
    transports,
});
exports.default = logger;
//# sourceMappingURL=logger.js.map