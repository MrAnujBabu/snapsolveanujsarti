# Roadmap

## Current checks (Nov 8)
- [x] Diagnose the workspace-owner credits error: real tutor UI/request returns 402 "Not enough credits" despite aggregate balance showing 4.37; not a cached pause. Funding/access discrepancy remains unresolved; owner must review Plans & credit usage before another attempt.
- [x] Verify latest commit via nb's GitHub API: upstream is still 3136758 (Nov 6); latest app work is locally committed as 5b799cb, not synced to that repo.

## Crawl4AI + Lovable AI (Nov 7)
- [x] Findings and integration plan (docs/crawl4ai-integration.md)
- [x] Crawl4AI engine port: safe fetch, scraping, markdown + citations, Pruning/BM25 filters, chunking, PDF, robots, cache
- [x] Lovable AI steps: web search, AI content filter, AI extraction (blocks/fields), CSS schema generation + CSS extraction, cited answers
- [x] Deep crawl (BFS / Best-First, filters, keyword scorer)
- [x] Tutor tools use Crawl4AI (web_search, read_link, ncert_search, ncert_read, neet_pyq_search) with connector fallback
- [x] NCERT Deep Scan uses Lovable AI search + Crawl4AI read (connectors as backup)
- [x] /api/crawl streaming endpoint + Web Research page (/research) + sidebar link
- [x] Tests for engine rules (filters, citations, URL safety, chunking, tools)
- [x] End-to-end check in the preview (search, read, deep crawl, extract, tutor search, web teacher in chat)
- [x] Answer: what is Hermes Agent, and can it run inside this app on Lovable AI credits (answered: not hostable here; Hermes-style features can be built in-app)
- [x] Web teacher in Chat mode and Voice mode (chat verified live; voice wired + unit-tested, real spoken call not tested)
- [x] Rename the "Search" switch to "Web search" (chat composer and voice mode)
- [ ] On hold (user, Nov 7): Hermes Agent / Hermes-style "skills" — do not start until the user asks
- [x] Keep work resumable after project moves (roadmap, docs/crawl4ai-integration.md and AGENTS.md updated)

## Done
- [x] Import the app from GitHub repo MrAnujBabu/Anuj-sarthi-deeplearning-ai into this project
- [x] Link GitHub, Firecrawl, Parallel, Perplexity in the current workspace (last re-linked Nov 6, 11:21 UTC)
- [x] End-to-end deep test of the whole app (all pages, quiz, voice, YouTube transcript, admin, practice)
- [x] Deep Scan fixed (wider search, per-page check)
- [x] Fix quiz option selection and voice quiz synchronization
- [x] Fix Hindi voice-over repeating the last line twice (backup voice)
- [x] Skip Sarvam when it is not connected (no failing 503 speech requests)
- [x] Daily study progress on home: doubts today, streak, last 7 days, due cards
- [x] Home polish: dead "Cowork" button removed, subject starters, quick tools, recent doubts
- [x] Sidebar: Mera Batch link
- [x] Saved practice upgrade: stats, box progress, keyboard shortcuts, empty/complete states, review logging
- [x] Fix broken SnapSolve logo/icon on the phone (small logo, real favicon, home-screen icons)
- [x] AI Studio: ByteDance diagram/poster (Seedream 5 Pro), ByteDance concept animation (Seedance 2.5), Topaz video clean-up (Starlight) — each with its own on/off toggle in the tool and in Settings, gallery on the device, "Diagram/Animation banao" shortcuts on tutor answers
- [x] End-to-end test (Nov 6): doubt answer, quiz, home progress, practice, real ByteDance diagram + animation, Topaz 1080p clip
- [x] Commit changes to the GitHub repo (MrAnujBabu/snapsolveanujsarti)

## Ready next
- [x] Voice + Web search (Nov 7): found and fixed a loop where the voice tutor kept re-opening pages and never answered; real answer step now searches, opens NTA page and answers in ~23 s. Live call audio cannot connect from the test computer (its network blocks the call's audio link), so a fully spoken call is still to be tried on a phone
- [ ] Voice: try one spoken call on a phone with Web search on (blocked here: test computer network)
- [x] Web Research: Save as doubt / Add to practice (free, same question never duplicates) — verified end to end
- [x] Voice page crashed on hosts without the database; now opens and calls without sign-in
- [ ] Deep Scan: try NCERT direct reads on the published site (certificate chain may be accepted there)
- [x] Screenshot showed signed-out Telegram save without a sign-in action. Added Admin sign in link beside Save and AI Studio return link; mobile navigation verified. Real authenticated save remains unverified (external unmanaged auth).
- [ ] Commit Telegram storage and animation-length changes to GitHub after verification
- [x] Concept Animation: 30 sec enabled and mobile selection/server validation tested; 60 sec shown disabled because one Seedance generation supports at most 30 sec. No paid generation tested: ByteDance disabled in current workspace.
- [x] AI Studio: Save to Telegram button, session-only media, persisted metadata/signed references; My Snapsolve Database bot/channel posting verified. Small real image uploaded and read back via gateway; mobile button/401 guard verified. Signed-in end-to-end save unavailable with external unmanaged auth.
- [ ] 60 sec composed animation — requires separate multi-clip composition flow; not implemented or tested
- [x] Commit latest Studio recovery fixes to GitHub main: 43c84836 (Nov 6)
- [x] Fix Studio busy recovery: provider wait-time, countdown, duplicate request guard and polling backoff; verified with simulated 429, no paid generation
- [x] Preserve accepted Studio jobs if device saving fails; retain Topaz source when a submission outcome is unknown
- [ ] Studio: "Add to practice" for generated diagrams (image flashcards in the practice deck)

## Waiting on the user
- [ ] Admin account — admin email must sign up via "Pehli baar? Account banao" (signed-in checks not possible from here)
- [ ] Link Sarvam voice (credits finished) and Google Sheets (declined)
- [ ] Vedantu login for "Sync now" (declined)
- [ ] Workspace credits are low — tutor answers, voice calls, Deep Scan and AI Studio stop when they run out
- [ ] Existing data (admin memory, user accounts) — waiting on export from the old project

- [x] Auto-clear stale AI credits pause when project/key moves or credits return
- [x] Explain ByteDance + Topaz Labs and how they run through the AI Gateway
- [x] Make AI Studio picture-making (Seedream) faster with good output
- [x] Fix "Output abhi available nahi hai" error
- [x] AI Studio work survives page refresh (keeps running in background)
- [x] Reconnect Perplexity, Firecrawl, Parallel in new workspace and test
- [x] Fix label check blocked by "Ek AI request shuru ho rahi hai"
- [ ] Git commit request (Lovable saves automatically; GitHub push needs reconnect)
