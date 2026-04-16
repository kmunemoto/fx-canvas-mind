import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://endcqzewujdvimdlazhj.supabase.co';
const supabaseAnonKey = 'sb_publishable_O6jJsLFQ9zArYsenDxIHGQ_bJdkOm2I';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
