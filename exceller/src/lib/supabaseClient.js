// src/lib/supabaseClient.js
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing Supabase env vars. Check that VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set in your .env file, and that you restarted the dev server after adding them.'
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);