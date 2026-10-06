-- Configure the minute scheduler after deploying the Edge Function.
-- Replace the three placeholders locally before executing this file.
-- Never commit the resulting SQL or the keys.

-- 1) Apply database/schema.sql on a new project, or the migration on an old one.
-- 2) Set the same secret in the Edge Function:
--    AUTO_BOOK_TRIGGER_SECRET=<AUTO_BOOK_TRIGGER_SECRET>
-- 3) Replace the placeholders below, then run this file in Supabase SQL Editor.

DO $$
BEGIN
  PERFORM cron.unschedule('lcn-auto-book-sweep');
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$$;

SELECT cron.schedule(
  'lcn-auto-book-sweep',
  '* * * * 1-6',
  $$
  SELECT net.http_post(
    url := 'https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/auto-book',
    headers := jsonb_build_object(
      'Authorization', 'Bearer <SUPABASE_ANON_KEY>',
      'Content-Type', 'application/json',
      'X-Auto-Book-Trigger', '<AUTO_BOOK_TRIGGER_SECRET>'
    ),
    body := '{}'::jsonb
  );
  $$
);
