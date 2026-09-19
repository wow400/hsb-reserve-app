# HSB Reserve App v22

Built cleanly from the known-good v21 source.

Changes in v22:
- Once FlightAware confirms a flight has actually taken off (wheels-off / airborne-or-beyond evidence), later **Refresh live status** actions skip that flight, so no further AeroAPI credits are spent on it.
- Confirmed taken-off state is retained for the same flight/schedule for the rest of the UTC day, including across FICO re-parses and page reloads.
- The refresh confirmation and cost estimate exclude confirmed taken-off flights.

Changes retained from v21:
- A380-only FICO reminder: `DP LHR a8`.
- HSB start/finish in 15-minute increments.
- FICO blank-line compaction.
- Re-parsing unchanged flights preserves their live state.
- `>19h from HSB` status wording.
- Reliable live delays show `Delayed Xm` and `New ETD xxxxZ`.
- Past scheduled ETD is not treated as a delay without live evidence.
- FICO X rows are cancelled without AeroAPI lookup.
- $8 monthly AeroAPI guard and 10-minute cache.
- BA/LHR/FA external checks.

Crew-duty/FDP calculations are intentionally not included.
