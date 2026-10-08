import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// The same public Supabase project as the CLI and mobile app.
const SUPABASE_URL = "https://mkbeusztkzffnzjdwmqk.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1rYmV1c3p0a3pmZm56amR3bXFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU5Nzc0NzgsImV4cCI6MjA4MTU1MzQ3OH0.2wlT6q6687Z5rpEYsdp01IQpNNl_XWv0IAfBgwPyDP0";

let client: SupabaseClient | undefined;
export function accountClient() {
  return (client ??= createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: "pkce",
      storageKey: "linkshell.web.account.v2",
    },
  }));
}
export async function accountToken() {
  const auth = accountClient().auth;
  const { data, error } = await auth.getSession();
  if (error) throw error;
  if (!data.session) return undefined;
  if ((data.session.expires_at ?? 0) * 1000 > Date.now() + 120_000)
    return data.session.access_token;
  const next = await auth.refreshSession();
  if (next.error) throw next.error;
  if (!next.data.session) throw new Error("登录已失效，请重新登录");
  return next.data.session.access_token;
}
