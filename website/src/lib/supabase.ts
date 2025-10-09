import { createClient } from '@supabase/supabase-js';


if (!import.meta.env.VITE_SUPABASE_URL || !import.meta.env.VITE_SUPABASE_ANON) {
  console.error('❌ Supabase env missing:', {
    url: !!import.meta.env.VITE_SUPABASE_URL,
    anon: !!import.meta.env.VITE_SUPABASE_ANON,
  });
}

console.log('Supabase env:', {
  url: import.meta.env.VITE_SUPABASE_URL,
  anon: import.meta.env.VITE_SUPABASE_ANON,
});

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL!,
  import.meta.env.VITE_SUPABASE_ANON!
);