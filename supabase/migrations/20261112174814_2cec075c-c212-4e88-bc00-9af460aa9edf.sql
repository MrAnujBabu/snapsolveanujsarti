CREATE TABLE IF NOT EXISTS public.ai_provider_keys (
  provider text PRIMARY KEY CHECK (provider ~ '^[a-z0-9_-]{2,32}$'),
  ciphertext text NOT NULL,
  iv text NOT NULL,
  key_version smallint NOT NULL DEFAULT 1,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_check_at timestamptz,
  last_check_ok boolean,
  last_check_note text
);
REVOKE ALL ON public.ai_provider_keys FROM anon, authenticated;
GRANT ALL ON public.ai_provider_keys TO service_role;
ALTER TABLE public.ai_provider_keys ENABLE ROW LEVEL SECURITY;