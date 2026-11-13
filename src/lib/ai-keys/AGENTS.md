# AI keys
- Admin API keys (src/lib/ai-keys) are a dormant vault: AES-GCM sealed with AI_KEY_VAULT_SECRET in service-role-only ai_provider_keys, status-only to admins, free read-only tests; no feature reads them until an explicit switch, so the gateway path never changes silently.
