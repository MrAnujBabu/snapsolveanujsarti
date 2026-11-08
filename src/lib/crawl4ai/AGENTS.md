# Crawl4AI port rules
- Design, module map and limits live in docs/crawl4ai-integration.md; keep it updated with engine changes.
- No paid always-on server: browser-only pages go through the free renderer, then the web archive, inside crawl(); honor renderer 429 pauses; still-blocked pages fail honestly and never count as sources. Why: the user will not pay for hosting, and blocked pages produced empty, misleading answers.
- Every page read reports one shared ReadOutcome (read-outcome.ts): Web research via PageView.outcome, Chat via transient `data-reader` stream parts, Voice via relay `app.reader` events; the browser logs them on-device for /reader-report and tracks `project.page_read`. Why: per-mode reader reliability without saving outcomes in conversations or model context.
