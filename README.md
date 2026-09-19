# HSB Reserve App v24

Built from the working v23 source.

Changes in v24:
- Fixes FICO parsing when the ETD field contains a revised departure such as `R1430`.
- Revised ETD tokens are no longer mistaken for PTA/arrival.
- Example: `269 LHR-LAX 1405 R1430 0120 ...` now remains scheduled T/O `1405`, arrival `0120 +1`, block `11:15`.

Changes retained from v23/v22/v21:
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
