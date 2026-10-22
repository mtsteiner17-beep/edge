// EDGE settings. This file is public (it ships to every phone), and that's fine:
// the Supabase key below is designed to be public. The database is locked down by supabase/schema.sql.
window.EDGE_CONFIG = {
  // Leave both blank for solo mode (no crew leaderboard, nothing leaves the phone).
  // To race friends, create a free Supabase project, run supabase/schema.sql, then paste:
  SUPABASE_URL: "",   // e.g. "https://abcdxyz.supabase.co"
  SUPABASE_KEY: "",   // the "anon" key or the newer "publishable" key (sb_publishable_...)

  // Text printed at the bottom of the story card. Leave blank to print the site's own address.
  WATERMARK: "",
};
