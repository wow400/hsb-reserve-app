# HSB Reserve App v34

Clean build from v33.

## v34 changes
- Keeps the existing original-crew **Crew limit** calculation.
- FDP detail now calculates the actual augmentation benefit of an HSB pilot.
- Applies the augmented A380 Class 1 Scheme/OM A FDP limit, including the HSB 8-hour reduction threshold and the 2300–0700 start exception.
- Applies the BLR HSB duty limit as the existing practical 19-hour HSB-start-to-arrival/chocks envelope (the BLR text states 19½ hours to 30 minutes after arrival).
- Shows **Usable FDP extension** and the resulting latest departure, with the limiting rule identified.
- SIN remains a 4-pilot trip, so an additional pilot gives no crew-complement FDP extension.
- Both `src/index.js` and `src/index.mjs` are identical.

Deploy as before with `npx wrangler deploy`.
