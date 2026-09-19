# HSB Reserve App v25

Built from the working v24 source.

Changes in v25:
- Adds server-side current-session persistence using the existing Cloudflare `USAGE_KV` binding.
- The latest same-day HSB session is shared between the Home Screen web app, Safari, and other browsers/devices opening the same Worker URL.
- Persists FICO text, parsed flights, HSB start/finish, FlightAware statuses, delay/New ETD information, confirmed-airborne state via saved statuses, and last live-refresh time.
- On startup, today's Cloudflare session is preferred over browser-local storage, so stale Safari/Home Screen local state does not override the latest saved server state.
- If there is no server snapshot yet, the app falls back to the existing local storage and then seeds Cloudflare with that state.
- Session data is keyed to the UTC date; yesterday's flight/live state is not restored on a new UTC day.
- Session snapshots expire automatically after 3 days.
- A final page-close save is attempted so closing the Home Screen app immediately after a change does not normally lose the latest state.

Changes retained from v24/v23/v22/v21:
- Correct FICO parsing when the ETD field contains a revised departure such as `R1430`.
- A380-only FICO reminder: `DP LHR a8`.
- HSB start/finish in 15-minute increments.
- FICO blank-line compaction.
- Re-parsing unchanged flights preserves their live state.
- `>19h from HSB` status wording.
- Reliable live delays show `Delayed Xm` and `New ETD xxxxZ`.
- Past scheduled ETD is not treated as a delay without live evidence.
- Once FlightAware confirms a flight has taken off, later refreshes skip it and spend no further AeroAPI credits on it for that UTC day/schedule.
- FICO X rows are cancelled without AeroAPI lookup.
- $8 monthly AeroAPI guard and 10-minute cache.
- BA/LHR/FA external checks.

Crew-duty/FDP calculations are intentionally not included.
