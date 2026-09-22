# HSB Reserve App v40

Cloudflare Worker app. Upload both `src/index.js` and `src/index.mjs` to the repository `src` folder.

## v40 changes
- Parses FICO flight numbers with a service-day suffix such as `207/23` instead of discarding every row containing `/`.
- Uses the suffix as the service date for the whole HSB table, so tomorrow's flights remain in the pre-HSB state rather than being treated as today's departures.
- Passes the service date to FlightAware record selection so a refresh targets the correct day's flight.
- Includes the service date in flight identity/session state to avoid carrying today's live state into tomorrow's flight.
- BA external-check links use the parsed service date.
- All v39 BLR/Scheme/HSB calculations are otherwise unchanged.
