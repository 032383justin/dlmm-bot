import winston from 'winston';
import Transport from 'winston-transport';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseLoggingEnabled = !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);

let supabase: SupabaseClient | null = null;

if (supabaseLoggingEnabled) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
} else {
  console.warn('WARNING: Supabase logging disabled – missing env keys');
}

class SupabaseTransport extends Transport {
  private client: SupabaseClient;

  constructor(opts: Transport.TransportStreamOptions & { supabaseClient: SupabaseClient }) {
    super(opts);
    this.client = opts.supabaseClient;
  }

  async log(info: { level: string; message: string; timestamp?: string }, callback: () => void) {
    setImmediate(() => {
      this.emit('logged', info);
    });

    const timestamp = new Date().toISOString();
    const message = `[${info.level.toUpperCase()}] ${info.message}`;

    try {
      const { error } = await this.client.from('bot_logs').insert({
        action: 'log',
        details: { message },
        timestamp: timestamp
      });

      if (error) {
        console.error('Supabase logging error:', error.message);
      }
    } catch (err) {
      console.error('Supabase logging failed:', err instanceof Error ? err.message : err);
    }

    callback();
  }
}

const transports: winston.transport[] = [
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    ),
  }),
  new winston.transports.File({ filename: 'error.log', level: 'error' }),
  new winston.transports.File({ filename: 'combined.log' }),
];

if (supabaseLoggingEnabled && supabase) {
  transports.push(new SupabaseTransport({ supabaseClient: supabase }));
  console.log('[LOGGING] Supabase logging enabled: true');
}

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports,
});

export default logger;
