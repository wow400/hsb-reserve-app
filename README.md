# HSB Reserve App v35

Clean build from v34.

## v35 changes
- **Call by** now means the latest time BA can actually contact you and still use you on that flight.
- It applies, together, the crew-complement FDP limit, your Scheme/OM A HSB-adjusted limit, the BLR 19-hour-to-chocks envelope, the fixed 2-hour travel time, and HSB finish.
- If the latest useful call is before HSB starts, the row shows **Too late** and is treated as safe/not callable from that HSB.
- The FDP detail panel shows the resulting latest useful call (or explains why the flight is already too late).
- For SIN/other 4-pilot cases, an extra pilot does not extend crew FDP, but your own Scheme/BLR limits are still applied if you were replacing sickness.
- Both `src/index.js` and `src/index.mjs` are identical.

Deploy as before with `npx wrangler deploy`.
