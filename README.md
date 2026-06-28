# HSB Reserve App v18

Built cleanly from v17.

Changes:
- Live refresh line now shows time as `0659Z`, without the extra word "Zulu".
- Adds FICO reminder:
  - `DP LHR b8 l8 u8 v8 w8 = 787`
  - `DP LHR a8 = A380`
- Uses stable local storage keys for:
  - pasted FICO list
  - HSB start time
  - HSB finish time

Keeps:
- FICO X rows shown as Cancelled without AeroAPI lookup.
- Continuation-sector filtering.
- Route-aware AeroAPI matching.
- LIVE/cache age.
- Colour-coded Calls figure.
- BA/LHR/FA external checks.
