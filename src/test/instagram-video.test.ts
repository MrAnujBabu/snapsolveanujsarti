import { describe, expect, it } from 'vitest';
import { extractVideoCandidates, instagramShortcode, instagramVideoUrl, isInstagramUrl } from '@/lib/web-video';

describe('Instagram links', () => {
  it('reads the reel code from every common share format', () => {
    expect(instagramShortcode('https://www.instagram.com/reel/C53nWdJsb3S/?igsh=abc123')).toBe('C53nWdJsb3S');
    expect(instagramShortcode('https://instagram.com/reels/DIOkyDDoL12')).toBe('DIOkyDDoL12');
    expect(instagramShortcode('instagram.com/p/C6JQ_DovOax/')).toBe('C6JQ_DovOax');
    expect(instagramShortcode('https://www.instagram.com/physicswallah/reel/C53nWdJsb3S/')).toBe('C53nWdJsb3S');
    expect(instagramShortcode('https://www.instagram.com/tv/CabcDEF123/')).toBe('CabcDEF123');
  });

  it('does not treat other sites or profile pages as reels', () => {
    expect(isInstagramUrl('https://notinstagram.com/reel/C53nWdJsb3S/')).toBe(false);
    expect(instagramShortcode('https://www.youtube.com/watch?v=abc')).toBeNull();
    expect(instagramShortcode('https://www.instagram.com/physicswallah/')).toBeNull();
  });

  it('finds the playable file in the reel page data', () => {
    const page = '<script>{"video_versions":[{"type":101,"url":"https:\\/\\/scontent-ams2-1.cdninstagram.com\\/o1\\/v\\/a.mp4?_nc_cat=108&_nc_sid=9ca052"}]}</script>';
    expect(instagramVideoUrl(page)).toBe('https://scontent-ams2-1.cdninstagram.com/o1/v/a.mp4?_nc_cat=108&_nc_sid=9ca052');
  });

  it('finds the playable file in the embed page backup', () => {
    const embed = 'x {\\"video_url\\":\\"https:\\\\\\/\\\\\\/scontent.cdninstagram.com\\\\\\/v\\\\\\/b.mp4?x=1\\u0026y=2\\",\\"z\\":1}';
    expect(instagramVideoUrl(embed)).toBe('https://scontent.cdninstagram.com/v/b.mp4?x=1&y=2');
  });

  it('ignores video addresses outside Instagram’s own servers', () => {
    expect(instagramVideoUrl('{"video_versions":[{"url":"https:\\/\\/evil.example.com\\/a.mp4"}]}')).toBeNull();
  });

  it('shows reel titles with real symbols instead of HTML codes', () => {
    const html = '<meta property="og:title" content="PW: &quot;Optics waiting&#x2026;&quot; &#128512;">';
    expect(extractVideoCandidates(html, 'https://www.instagram.com/reel/X/').title).toBe('PW: "Optics waiting…" 😀');
  });
});
