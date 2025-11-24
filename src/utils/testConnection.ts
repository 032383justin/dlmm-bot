
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

console.log('Testing Supabase connection...');
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_KEY;
console.log('URL:', url ? 'Found' : 'Missing');
console.log('Key:', key ? 'Found' : 'Missing');

if (url && key) {
    const supabase = createClient(url, key);
    (async () => {
        try {
            const { count, error } = await supabase.from('bot_logs').select('count', { count: 'exact', head: true });
            if (error) console.error('Error:', error);
            else console.log('Connection successful. Log count:', count);
        } catch (err) {
            console.error('Exception:', err);
        }
    })();
}
