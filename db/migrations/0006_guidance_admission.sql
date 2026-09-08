-- 0006 — DISTRIBUTED GUIDANCE ADMISSION
--
-- Cost protection for the paid guidance provider, shared across server
-- instances. The AI-1 guard was process-local: two replicas each admitted their
-- own quota, so "one call in flight per subject" was true per instance and
-- false for the deployment.
--
-- This stores ONLY what admission needs. No prompts, no conversations, no model
-- responses, no food data, no nutrition. If this table leaked it would reveal
-- that a user asked for guidance and when — nothing about what was said.

CREATE TABLE IF NOT EXISTS guidance_admission (
  subject_id            uuid        PRIMARY KEY,

  -- The in-flight lease. NULL means no call is outstanding.
  -- `lease_expires_at` is what makes a crashed instance recoverable: the lease
  -- ages out rather than locking the subject forever.
  lease_id              uuid,
  lease_expires_at      timestamptz,

  -- Rolling request window.
  window_started_at     timestamptz NOT NULL,
  window_request_count  integer     NOT NULL DEFAULT 0,

  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT guidance_admission_count_nonneg CHECK (window_request_count >= 0),
  -- A lease is either fully present or fully absent; a half-set lease would be
  -- ambiguous to every reader.
  CONSTRAINT guidance_admission_lease_coherent CHECK (
    (lease_id IS NULL AND lease_expires_at IS NULL)
    OR (lease_id IS NOT NULL AND lease_expires_at IS NOT NULL)
  )
);

-- Expired-lease sweeps scan by expiry, never by subject.
CREATE INDEX IF NOT EXISTS guidance_admission_lease_expiry_idx
  ON guidance_admission (lease_expires_at)
  WHERE lease_expires_at IS NOT NULL;

-- Server-authority table, consistent with the existing convention: admission is
-- infrastructure, not user-readable data. RLS is enabled and no policy grants
-- access, so the authenticated role cannot read or write it at all.
ALTER TABLE guidance_admission ENABLE ROW LEVEL SECURITY;
ALTER TABLE guidance_admission FORCE  ROW LEVEL SECURITY;

COMMENT ON TABLE guidance_admission IS
  'Distributed cost admission for paid guidance. Contains no conversation, '
  'prompt, model response or nutrition data.';
