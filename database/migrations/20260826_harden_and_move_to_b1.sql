-- Idempotent migration for installations created with the first version.
-- It removes obsolete session-cookie columns, renames ambiguous preferences,
-- defaults the active profile to B1, and installs the distributed sweep lock.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'student_config' AND column_name = 'level_group_name'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'student_config' AND column_name = 'target_level'
  ) THEN
    ALTER TABLE public.student_config RENAME COLUMN level_group_name TO target_level;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'student_config' AND column_name = 'min_start_hour_minutes'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'student_config' AND column_name = 'min_start_minutes'
  ) THEN
    ALTER TABLE public.student_config RENAME COLUMN min_start_hour_minutes TO min_start_minutes;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'student_config' AND column_name = 'max_start_hour_minutes'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'student_config' AND column_name = 'max_start_minutes'
  ) THEN
    ALTER TABLE public.student_config RENAME COLUMN max_start_hour_minutes TO max_start_minutes;
  END IF;
END
$$;

ALTER TABLE public.student_config
  ADD COLUMN IF NOT EXISTS target_level TEXT,
  ADD COLUMN IF NOT EXISTS class_type_id BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS min_start_minutes INTEGER NOT NULL DEFAULT 540,
  ADD COLUMN IF NOT EXISTS max_start_minutes INTEGER NOT NULL DEFAULT 810,
  ADD COLUMN IF NOT EXISTS booking_hours_range INTEGER NOT NULL DEFAULT 48,
  ADD COLUMN IF NOT EXISTS minimum_lead_time_hours NUMERIC(5, 2) NOT NULL DEFAULT 4.00,
  ADD COLUMN IF NOT EXISTS blocked_slots JSONB NOT NULL DEFAULT '[]'::JSONB;

UPDATE public.student_config
SET target_level = 'B1', updated_at = now()
WHERE target_level IS NULL OR upper(trim(target_level)) IN ('', 'A2', 'A1-A2');

ALTER TABLE public.student_config
  ALTER COLUMN target_level SET DEFAULT 'B1',
  ALTER COLUMN target_level SET NOT NULL;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS student_config_set_updated_at ON public.student_config;
CREATE TRIGGER student_config_set_updated_at
BEFORE UPDATE ON public.student_config
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- These were never read by the Edge Function. They are stale session secrets,
-- so remove them from the database as part of the security cleanup.
ALTER TABLE public.student_config DROP COLUMN IF EXISTS cookie_xsrf_token;
ALTER TABLE public.student_config DROP COLUMN IF EXISTS cookie_session;

CREATE TABLE IF NOT EXISTS public.booking_locks (
  lock_name TEXT PRIMARY KEY,
  owner_id UUID NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE OR REPLACE FUNCTION public.try_acquire_booking_lock(
  p_lock_name TEXT,
  p_owner_id UUID,
  p_ttl_seconds INTEGER DEFAULT 180
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  did_acquire BOOLEAN := FALSE;
BEGIN
  IF p_ttl_seconds < 1 OR p_ttl_seconds > 900 THEN
    RAISE EXCEPTION 'Invalid lock TTL';
  END IF;

  INSERT INTO public.booking_locks (lock_name, owner_id, acquired_at, expires_at)
  VALUES (p_lock_name, p_owner_id, now(), now() + make_interval(secs => p_ttl_seconds))
  ON CONFLICT (lock_name) DO UPDATE
    SET owner_id = EXCLUDED.owner_id,
        acquired_at = EXCLUDED.acquired_at,
        expires_at = EXCLUDED.expires_at
    WHERE public.booking_locks.expires_at <= now()
  RETURNING TRUE INTO did_acquire;

  RETURN COALESCE(did_acquire, FALSE);
END;
$$;

CREATE OR REPLACE FUNCTION public.release_booking_lock(
  p_lock_name TEXT,
  p_owner_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM public.booking_locks
  WHERE lock_name = p_lock_name AND owner_id = p_owner_id;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count = 1;
END;
$$;

CREATE INDEX IF NOT EXISTS booking_logs_status_schedule_idx
  ON public.booking_logs (status, schedule_id);
CREATE INDEX IF NOT EXISTS booking_logs_created_at_idx
  ON public.booking_logs (created_at DESC);

ALTER TABLE public.student_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_locks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.student_config, public.booking_logs, public.booking_locks FROM anon, authenticated;
GRANT ALL ON public.student_config, public.booking_logs, public.booking_locks TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.booking_logs_id_seq TO service_role;
REVOKE ALL ON FUNCTION public.try_acquire_booking_lock(TEXT, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_booking_lock(TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.try_acquire_booking_lock(TEXT, UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_booking_lock(TEXT, UUID) TO service_role;
