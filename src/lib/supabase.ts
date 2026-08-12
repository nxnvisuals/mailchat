import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config";

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // The Outlook OAuth redirect brings its own ?code= — keep Supabase from
    // trying to interpret it as one of its own auth callbacks.
    detectSessionInUrl: false,
  },
});
