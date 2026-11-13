CREATE TABLE public.agent_lessons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  problem text NOT NULL DEFAULT '',
  guidance text NOT NULL,
  subject text NOT NULL DEFAULT '',
  example text NOT NULL DEFAULT '',
  fingerprint text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','retired')),
  seen_count integer NOT NULL DEFAULT 1,
  shown_ok integer NOT NULL DEFAULT 0,
  shown_stuck integer NOT NULL DEFAULT 0,
  held_ok integer NOT NULL DEFAULT 0,
  held_stuck integer NOT NULL DEFAULT 0,
  last_matched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_lessons TO authenticated;
GRANT ALL ON public.agent_lessons TO service_role;
ALTER TABLE public.agent_lessons ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_lessons_admin_all ON public.agent_lessons FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE TRIGGER agent_lessons_updated BEFORE UPDATE ON public.agent_lessons FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.agent_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL,
  tool text NOT NULL DEFAULT '',
  message text NOT NULL,
  fingerprint text NOT NULL UNIQUE,
  count integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_feedback TO authenticated;
GRANT ALL ON public.agent_feedback TO service_role;
ALTER TABLE public.agent_feedback ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_feedback_admin_all ON public.agent_feedback FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE TABLE public.agent_daily_stats (
  day date PRIMARY KEY,
  turns integer NOT NULL DEFAULT 0,
  stuck integer NOT NULL DEFAULT 0,
  recovered integer NOT NULL DEFAULT 0
);
GRANT SELECT ON public.agent_daily_stats TO authenticated;
GRANT ALL ON public.agent_daily_stats TO service_role;
ALTER TABLE public.agent_daily_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_daily_stats_admin_read ON public.agent_daily_stats FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- One call per tutor turn: daily counters, lesson relevance and outcome of the previous turn's lessons.
CREATE OR REPLACE FUNCTION public.agent_lesson_turn(_matched uuid[], _prev uuid[], _held boolean, _stuck boolean, _recovered boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO agent_daily_stats(day, turns, stuck, recovered)
  VALUES ((now() AT TIME ZONE 'Asia/Kolkata')::date, 1, CASE WHEN _stuck THEN 1 ELSE 0 END, CASE WHEN _recovered THEN 1 ELSE 0 END)
  ON CONFLICT (day) DO UPDATE SET turns = agent_daily_stats.turns + 1,
    stuck = agent_daily_stats.stuck + EXCLUDED.stuck, recovered = agent_daily_stats.recovered + EXCLUDED.recovered;
  IF coalesce(array_length(_matched, 1), 0) > 0 THEN
    UPDATE agent_lessons SET last_matched_at = now() WHERE id = ANY(_matched) AND status = 'active';
  END IF;
  IF coalesce(array_length(_prev, 1), 0) > 0 THEN
    UPDATE agent_lessons SET
      shown_ok = shown_ok + CASE WHEN NOT _held AND NOT _stuck THEN 1 ELSE 0 END,
      shown_stuck = shown_stuck + CASE WHEN NOT _held AND _stuck THEN 1 ELSE 0 END,
      held_ok = held_ok + CASE WHEN _held AND NOT _stuck THEN 1 ELSE 0 END,
      held_stuck = held_stuck + CASE WHEN _held AND _stuck THEN 1 ELSE 0 END
    WHERE id = ANY(_prev) AND status = 'active';
  END IF;
END $$;

-- Similar problems share a fingerprint; repeats raise seen_count instead of adding rows.
CREATE OR REPLACE FUNCTION public.agent_note_lesson(_problem text, _guidance text, _subject text, _example text, _fingerprint text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO agent_lessons(problem, guidance, subject, example, fingerprint)
  VALUES (left(_problem, 400), left(_guidance, 600), left(_subject, 40), left(_example, 1500), _fingerprint)
  ON CONFLICT (fingerprint) DO UPDATE SET seen_count = agent_lessons.seen_count + 1;
END $$;

CREATE OR REPLACE FUNCTION public.agent_note_feedback(_category text, _tool text, _message text, _fingerprint text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO agent_feedback(category, tool, message, fingerprint)
  VALUES (left(_category, 40), left(_tool, 60), left(_message, 800), _fingerprint)
  ON CONFLICT (fingerprint) DO UPDATE SET count = agent_feedback.count + 1, last_seen = now(), status = 'open', message = EXCLUDED.message;
END $$;

REVOKE ALL ON FUNCTION public.agent_lesson_turn(uuid[], uuid[], boolean, boolean, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agent_note_lesson(text, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agent_note_feedback(text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agent_lesson_turn(uuid[], uuid[], boolean, boolean, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_note_lesson(text, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_note_feedback(text, text, text, text) TO service_role;