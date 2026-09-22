# HSB Reserve App v30

Built from the working v26 source.

Changes in v30:
- Adds one-line table columns in this order: Flight / Route / 2hrs b4 Report / Report / T/O / Arr / Block / Call by / Status / Countdown / Checks.
- Report uses the original scheduled A380 T5 report time for each flight and does not move when FICO/FlightAware shows a delay or revised ETD.
- `2hrs b4 Report` is calculated from that fixed original report time and displayed in Heathrow local time with a lower-case `l`; BST/GMT is handled dynamically with the `Europe/London` timezone.
- Tightens table spacing and mobile layout so more information is visible on iPhone/iPad while keeping each flight on one row.
- Delay details are one-line: `Delayed Xm · New ETD xxxxZ`.
- Red urgency is reserved for a call deadline within 30 minutes; amber means still callable with more than 30 minutes remaining; green means safe/no longer callable. Past-ETD refresh-needed status remains grey/unknown until live status is checked.
- Legend/footer wording now matches the actual status logic.

Retained from v26/v25:
- Cloudflare KV shared current-session persistence across Home Screen app, Safari and other devices.
- UTC-day rollover protection for session data.
- A380-only FICO reminder: `DP LHR a8`.
- 15-minute HSB start/finish choices.
- FICO blank-line compaction and corrected revised-ETD parsing.
- Re-parsing unchanged flights preserves live status.
- `>19h from HSB` handling.
- FlightAware delay/New ETD display, no false delay inference, and confirmed-airborne flights are excluded from later paid refreshes.
- $8 monthly AeroAPI guard, 10-minute cache and BA/LHR/FA external links.

Crew-duty/FDP calculations are intentionally not included.
