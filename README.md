# HSB Reserve App v38

Cloudflare Worker app. Upload both `src/index.js` and `src/index.mjs` to the repository `src` folder.

## v38 changes
- Adds industrial BLR FDP limits for the six A380 trips.
- Original operating limit now uses the earlier of BLR and Scheme.
- Uses Box A for 2 crew, Box C (+3h) for 3 crew, and Box D to Scheme for 4 crew.
- BLR calculations include the 30-minute post-arrival clear.
- HSB augmentation and Call by now use the augmented BLR crew limit as well as the HSB pilot Scheme and 19h limits.
- FDP detail panel shows original Scheme and BLR limits and highlights the actual limiting rule.
