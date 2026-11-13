import { createFileRoute } from '@tanstack/react-router';
import { isInstagramUrl } from '@/lib/web-video';

/**
 * Fresh playable file for a saved Instagram reel. Instagram's video addresses expire after about a day,
 * so reopened library entries ask for a new one. Instagram links only; no AI, nothing stored.
 */
export const Route = createFileRoute('/api/instagram-video')({
  server: { handlers: {
    GET: async ({ request }) => {
      const target = (new URL(request.url).searchParams.get('url') ?? '').slice(0, 2000);
      if (!isInstagramUrl(target)) return Response.json({ error: 'सिर्फ़ Instagram link चाहिए।' }, { status: 400 });
      const { resolveWebVideo, WebVideoError } = await import('@/lib/web-video.server');
      try {
        const out = await resolveWebVideo(target, request.signal);
        if (out.kind !== 'media') return Response.json({ error: 'Video नहीं मिली।' }, { status: 422 });
        return Response.json({ mediaUrl: out.url, title: out.title }, { headers: { 'Cache-Control': 'private, max-age=600' } });
      } catch (error) {
        if (request.signal.aborted) return new Response(null, { status: 499 });
        if (error instanceof WebVideoError) return Response.json({ error: error.message }, { status: error.status });
        return Response.json({ error: 'Instagram video नहीं खुली।' }, { status: 502 });
      }
    },
  } },
});
