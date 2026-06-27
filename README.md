# HSB Reserve App v14

Built from the working v11 base with minimal changes only.

Changes:
- Replaces Google/Check with BA / LHR / FA.
- BA opens British Airways flight status for today's date.
- LHR opens Heathrow flight details.
- FA opens FlightAware public tracking page.
- Cancelled remains green/safe, but still displays as Cancelled.
- Keeps FlightAware manual refresh, $8 cap, 10-minute cache and USAGE_KV.
- wrangler.toml includes the USAGE_KV binding.
