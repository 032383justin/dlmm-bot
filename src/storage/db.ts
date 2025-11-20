import dotenv from "dotenv";
dotenv.config();


import { createClient } from '@supabase/supabase-js';
import { DEFAULT_CONFIG } from '../config';

const { SUPABASE_URL, SUPABASE_KEY } = DEFAULT_CONFIG;

export const db = createClient(SUPABASE_URL, SUPABASE_KEY);
