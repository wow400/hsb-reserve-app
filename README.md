# HSB Reserve App v16

Built cleanly from the working v15 base.

Changes:
- Moves the AeroAPI guard line into the header under the main subtitle.
- Removes the large separate usage guard panel from the visible UI.
- Before live status refresh, flight dots are grey rather than amber.
- Keeps BA/LHR/FA external check links.
- Keeps FlightAware manual refresh, $8 cap, 10-minute cache and USAGE_KV.
- wrangler.toml includes the USAGE_KV binding.
