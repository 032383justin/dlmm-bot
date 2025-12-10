import winston from 'winston';
import Transport from 'winston-transport';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase: SupabaseClient | null = null;

if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  console.log('[LOGGING] Critical logging to Supabase enabled');
} else {
  console.log('[LOGGING] Supabase logging disabled – missing service role key');
}

class SupabaseCriticalTransport extends Transport {
  private client: SupabaseClient;

  constructor(opts: Transport.TransportStreamOptions & { supabaseClient: SupabaseClient }) {
    super(opts);
    this.client = opts.supabaseClient;
  }

  log(info: { level: string; message: string }, callback: () => void) {
    setImmediate(() => {
      this.emit('logged', info);
    });

    const level = info.level;
    const message = info.message;

    const isCritical =
      level === 'error' ||
      level === 'warn' ||
      message.includes('ENTRY') ||
      message.includes('EXIT') ||
      message.includes('KILL') ||
      message.includes('REGIME');

    if (isCritical) {
      Promise.resolve(
        this.client.from('bot_logs').insert({
          action: level,
          details: { message },
          timestamp: new Date().toISOString()
        })
      ).catch(() => {});
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

if (supabase) {
  transports.push(new SupabaseCriticalTransport({ supabaseClient: supabase }));
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
