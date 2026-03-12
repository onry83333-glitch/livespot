-- Add 'cooldown_wait' to dm_send_log status CHECK constraint
-- Used by dm-service to temporarily park tasks on per-user 24h cooldown
-- so they don't block the queue for other users.

-- Also add 'blocked_test_mode', 'blocked_no_campaign', 'blocked_identity_mismatch'
-- which are already used in code but missing from the constraint.

ALTER TABLE public.dm_send_log
  DROP CONSTRAINT IF EXISTS dm_send_log_status_check;

ALTER TABLE public.dm_send_log
  ADD CONSTRAINT dm_send_log_status_check
  CHECK (status IN (
    'success', 'error', 'pending', 'queued', 'sending', 'cancelled',
    'cooldown_wait',
    'blocked_test_mode', 'blocked_no_campaign', 'blocked_identity_mismatch'
  ));
