import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

// Só tenta conectar se a URL for válida (começar com http)
// Se não for válida, ele deixa a variável como 'null' e o servidor não cai.
export const supabase = (supabaseUrl && supabaseUrl.startsWith('http') && supabaseKey) 
  ? createClient(supabaseUrl, supabaseKey) 
  : null;