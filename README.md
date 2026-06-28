# HSB Reserve App v19

Built cleanly from v18.

Changes:
- Adds a 19-hour rule from HSB start to scheduled arrival.
- Flights landing 19h or more after HSB start are marked green/safe as `Cannot cover`.
- FICO-cancelled and cannot-cover flights are not sent to AeroAPI.
- Grey remains reserved for not-live-refreshed/unknown rows.
- Keeps stable local storage keys, FICO reminder, BA/LHR/FA checks and $8 AeroAPI guard.
