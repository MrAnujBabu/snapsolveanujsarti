REVOKE ALL ON public.agent_settings, public.ai_pause_state, public.memory_items, public.ncert_snippets, public.profiles, public.user_roles, public.vedantu_class_notes, public.vedantu_classes, public.vedantu_courses, public.vedantu_sync_state, public.vedantu_tests, public.voice_calls FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT SELECT ON public.user_roles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.memory_items TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.agent_settings TO authenticated;
GRANT SELECT ON public.voice_calls, public.vedantu_courses, public.vedantu_classes, public.vedantu_class_notes, public.vedantu_tests, public.vedantu_sync_state TO authenticated;
GRANT SELECT ON public.ncert_snippets TO anon, authenticated;

GRANT ALL ON public.agent_settings, public.ai_pause_state, public.memory_items, public.ncert_snippets, public.profiles, public.user_roles, public.vedantu_class_notes, public.vedantu_classes, public.vedantu_courses, public.vedantu_sync_state, public.vedantu_tests, public.voice_calls TO service_role;

REVOKE EXECUTE ON FUNCTION public.touch_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.touch_voice_call() FROM PUBLIC, anon, authenticated;