# HSB Reserve App v10.1

v10.1 fixes:
- Fixes frontend startup issue where page stayed on "Loading usage guard...".
- Restores UTC clock and table rendering.
- Keeps FlightAware AeroAPI manual refresh only.
- Keeps USAGE_KV cost guard and 10-minute cache.
- Keeps $8 app-side monthly cap.

Required Cloudflare configuration:
- Secret: `FLIGHTAWARE_API_KEY`
- KV namespace binding: `USAGE_KV`
