# Hooks rules

- LiveVoicePage stays continuous on its relay. Gemini mutes live audio, substitutes a silent mic while speaking and uses one speaker. Serialize mic recovery by latest intent; cancellation restores the sender. Silent RTP proves neither heartbeat health nor closure cause. Merge waiting thoughts into one eager look-ahead; bounded pre-audio busy/network retries, cut runaway audio without ending calls, stop only on terminal errors; a connected call treats media "failed" as a blip within the media grace (phones switch networks); no paid auto-reconnect.
- Preview voice relay (live-vite-plugin) checks Origin against the page protocol from a same-host Origin or x-forwarded-proto, because the preview proxy ends HTTPS before the dev server; cross-site origins stay rejected.
