# Lib
- Interpreter English words follow the shared hindi-english-words rule; only blocks with leftover English letters get one guarded swap-only pass, so clean output costs nothing extra.
- Dub playback treats video still inside a just-spoken part as a silent wait; only a >1 s backward jump returns to a finished part, so no part is spoken twice.
- Media audio falls back from refused WebCodecs codecs to AAC-LC-labelled/LC-core decoding, then a size-capped whole-file Web Audio decode, because phone browsers often refuse HE-AAC reels while still playing AAC-LC.
