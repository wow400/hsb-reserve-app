# HSB Reserve App v39

Cloudflare Worker app. Upload both `src/index.js` and `src/index.mjs` to the repository `src` folder.

## v39 changes
- Fixes the FDP detail panel so the flight's crew-category Scheme limit is not confused with the HSB pilot's separate standby-adjusted Scheme ceiling.
- Explicitly shows the augmented 3/4 crew Scheme maximum FDP and Scheme latest departure.
- The HSB pilot personal Scheme ceiling is shown only when it is actually the limiting constraint.
- For BA207 MIA, the 4 crew Scheme latest departure now displays correctly as 1550Z; the irrelevant 0625Z +1 personal ceiling is no longer shown.
- No call-by or FDP calculation logic changed from v38.
