# HSB Reserve App v20

Built cleanly from v19.

Changes:
- Moves the FICO reminder under the HSB Start / HSB Finish / UTC clock block.
- Planned is now amber/yellow, not green.
- If no live refresh has been done and UTC passes scheduled ETD, status becomes `Past ETD — refresh`.
- `Past ETD — refresh` is red with a red dot.
- Green remains reserved for safe states: Departed, Cancelled, Cannot cover, Safe.

Keeps:
- 19-hour cannot-cover rule.
- FICO X rows shown as Cancelled without AeroAPI lookup.
- Stable local storage keys.
- BA/LHR/FA checks.
- $8 AeroAPI guard and 10-minute cache.
