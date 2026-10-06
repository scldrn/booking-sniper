-- Emergency/maintenance pause. This never creates a scheduler.
-- Run it in Supabase SQL Editor to stop the previous cron job while testing.

DO $$
BEGIN
  PERFORM cron.unschedule('lcn-auto-book-sweep');
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$$;
