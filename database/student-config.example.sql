-- Example only. Replace the numeric placeholders with values from your own
-- LCN account before running. Do not commit the edited copy.

INSERT INTO public.student_config (
  enrollment_id,
  third_party_id,
  headquarter_id,
  language_id,
  class_type_id,
  min_start_minutes,
  max_start_minutes,
  allowed_days,
  target_level,
  booking_hours_range,
  minimum_lead_time_hours,
  blocked_slots
)
VALUES (
  NULL, -- replace with your enrollment ID (required)
  NULL, -- replace with your third-party/student ID (required)
  2,
  70,
  1,
  540, -- 09:00
  720, -- 12:00
  ARRAY[1, 2, 3, 4, 5]::SMALLINT[],
  'B1',
  48,
  4.00,
  '[]'::JSONB
);
