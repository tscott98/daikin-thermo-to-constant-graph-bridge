-- Setpoint configuration reported alongside each reading.
-- Celsius, matching the other temperature columns.
--   setpoint_delta_c : minimum gap enforced between heat and cool setpoints
--   setpoint_min_c   : lowest temperature the system supports
--   setpoint_max_c   : highest temperature the system supports

ALTER TABLE readings ADD COLUMN setpoint_delta_c REAL;
ALTER TABLE readings ADD COLUMN setpoint_min_c   REAL;
ALTER TABLE readings ADD COLUMN setpoint_max_c   REAL;

-- Backfill from retained raw JSON. Only rows still inside RAW_RETENTION_DAYS
-- have raw kept, so older rows stay null.
UPDATE readings
SET setpoint_delta_c = json_extract(raw, '$.setpointDelta'),
    setpoint_min_c   = json_extract(raw, '$.setpointMinimum'),
    setpoint_max_c   = json_extract(raw, '$.setpointMaximum')
WHERE raw IS NOT NULL AND setpoint_delta_c IS NULL;
