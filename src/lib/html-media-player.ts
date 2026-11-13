// Adapts an HTML <video>/<audio> element to the dub controller's player contract
// (YouTube state codes: 0 ended, 1 playing, 2 paused, 3 buffering).
import type { DubPlayer } from './youtube-dub-sync';

export const HTML_PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

/**
 * Buffering follows the element's real stall events, not `readyState`: phone browsers briefly dip
 * below HAVE_FUTURE_DATA while the picture keeps moving, which used to cut the Hindi voice in and out.
 */
const stallWatch = new WeakMap<HTMLMediaElement, { stalled: boolean }>();
function watchStalls(el: HTMLMediaElement) {
  let watch = stallWatch.get(el);
  if (watch) return watch;
  const w = { stalled: false };
  const stall = () => { w.stalled = true; };
  const resume = () => { w.stalled = false; };
  el.addEventListener('waiting', stall);
  for (const type of ['playing', 'canplay', 'canplaythrough', 'seeked', 'pause', 'emptied']) el.addEventListener(type, resume);
  let last = el.currentTime;
  el.addEventListener('timeupdate', () => { if (el.currentTime !== last) { last = el.currentTime; w.stalled = false; } });
  stallWatch.set(el, w);
  watch = w;
  return watch;
}

export function htmlMediaState(el: Pick<HTMLMediaElement, 'ended' | 'paused' | 'seeking' | 'readyState'>, stalled: boolean) {
  if (el.ended) return 0;
  if (el.paused) return 2;
  return el.seeking || stalled || el.readyState < 2 ? 3 : 1;
}

export function htmlMediaDubPlayer(el: HTMLMediaElement): DubPlayer {
  const watch = watchStalls(el);
  return {
    playVideo: () => { void el.play().catch(() => { /* paused by the browser; state stays 2 */ }); },
    pauseVideo: () => el.pause(),
    mute: () => { el.muted = true; },
    unMute: () => { el.muted = false; },
    seekTo: (time: number) => { el.currentTime = Math.max(0, time); },
    getCurrentTime: () => el.currentTime,
    getPlayerState: () => htmlMediaState(el, watch.stalled),
    getPlaybackRate: () => el.playbackRate,
    setPlaybackRate: (rate: number) => { el.playbackRate = rate; },
    getAvailablePlaybackRates: () => HTML_PLAYBACK_RATES,
  };
}
