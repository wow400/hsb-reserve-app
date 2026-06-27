# HSB Reserve App v12

Changes from v11:
- Replaces the single Google/Check button with three external check buttons:
  - BA
  - LHR
  - FA
- BA opens British Airways flight status using today's date.
- LHR opens Heathrow flight details.
- FA opens FlightAware using BAW flight number.
- Keeps FlightAware AeroAPI manual refresh only.
- Keeps USAGE_KV cost guard.
- Keeps $8 monthly app cap and 10-minute cache.
- `wrangler.toml` includes the USAGE_KV binding.
