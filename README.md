# HSB Reserve App v15

Clean rebuild after frontend startup issue.

- Avoids embedded regex in browser JavaScript.
- Keeps FlightAware AeroAPI manual refresh only.
- Keeps USAGE_KV usage/cost guard.
- Keeps $8 monthly app cap.
- Keeps 10-minute FlightAware cache.
- Adds BA / LHR / FA external check links.
- Cancelled remains green/safe but displays as Cancelled.
- wrangler.toml includes the USAGE_KV binding.
