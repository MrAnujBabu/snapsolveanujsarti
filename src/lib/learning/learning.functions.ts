import { createServerFn } from '@tanstack/react-start';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { z } from 'zod';
import { lessonFingerprint } from './lessons';

type Ctx = { supabase: any; userId: string };
async function assertAdmin({ supabase, userId }: Ctx) {
  const { data, error } = await supabase.rpc('has_role', { _user_id: userId, _role: 'admin' });
  if (error || !data) throw new Error('Access denied');
}

export const listLearning = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const ctx = context as unknown as Ctx;
    await assertAdmin(ctx);
    const since = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
    const [lessons, feedback, stats] = await Promise.all([
      ctx.supabase.from('agent_lessons').select('*').order('updated_at', { ascending: false }).limit(500),
      ctx.supabase.from('agent_feedback').select('*').order('last_seen', { ascending: false }).limit(300),
      ctx.supabase.from('agent_daily_stats').select('*').gte('day', since).order('day', { ascending: true }),
    ]);
    for (const r of [lessons, feedback, stats]) if (r.error) throw new Error(r.error.message);
    return {
      lessons: (lessons.data ?? []) as Array<{ id: string; problem: string; guidance: string; subject: string; example: string; status: 'pending' | 'active' | 'retired'; seen_count: number; shown_ok: number; shown_stuck: number; held_ok: number; held_stuck: number; last_matched_at: string | null; created_at: string; updated_at: string }>,
      feedback: (feedback.data ?? []) as Array<{ id: string; category: string; tool: string; message: string; count: number; status: 'open' | 'resolved'; first_seen: string; last_seen: string }>,
      stats: (stats.data ?? []) as Array<{ day: string; turns: number; stuck: number; recovered: number }>,
    };
  });

const lessonInput = z.object({
  id: z.string().uuid().optional(),
  problem: z.string().max(300).default(''),
  guidance: z.string().trim().min(10, 'Sabak thoda detail mein likhiye').max(500),
  subject: z.enum(['physics', 'chemistry', 'biology', 'general']).default('general'),
  status: z.enum(['pending', 'active', 'retired']),
});

export const saveLesson = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: z.input<typeof lessonInput>) => lessonInput.parse(d))
  .handler(async ({ data, context }) => {
    const ctx = context as unknown as Ctx;
    await assertAdmin(ctx);
    const { id, ...row } = data;
    const q = id
      ? ctx.supabase.from('agent_lessons').update(row).eq('id', id)
      : ctx.supabase.from('agent_lessons').insert({ ...row, fingerprint: `manual ${crypto.randomUUID()} ${lessonFingerprint(row.problem, row.guidance)}` });
    const { error } = await q;
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteLesson = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const ctx = context as unknown as Ctx;
    await assertAdmin(ctx);
    const { error } = await ctx.supabase.from('agent_lessons').delete().eq('id', data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const updateFeedback = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string; action: 'resolve' | 'reopen' | 'delete' }) => z.object({ id: z.string().uuid(), action: z.enum(['resolve', 'reopen', 'delete']) }).parse(d))
  .handler(async ({ data, context }) => {
    const ctx = context as unknown as Ctx;
    await assertAdmin(ctx);
    const table = ctx.supabase.from('agent_feedback');
    const { error } = data.action === 'delete'
      ? await table.delete().eq('id', data.id)
      : await table.update({ status: data.action === 'resolve' ? 'resolved' : 'open' }).eq('id', data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
