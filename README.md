# HSB Reserve App v13

Built from the last working v11 base.

Changes:
- Replaces Google/Check with BA / LHR / FA external links.
- BA opens the BA flight-status page using today's date.
- LHR opens Heathrow flight details.
- FA opens FlightAware using BAW flight number.
- Cancelled remains green/safe, but still displays as Cancelled.
- Keeps manual-only FlightAware API refresh.
- Keeps USAGE_KV cost guard.
- Keeps $8 monthly app cap and 10-minute cache.
- wrangler.toml includes the USAGE_KV binding.
