# HSB Reserve App v9

Single Cloudflare Worker application.

v9 changes:
- Removed the top still-callable panel.
- Removed summary/stat cards.
- Kept the chronological operational table as the main display.
- Active flight handling adjusted:
  - active + departure/live evidence = Departed
  - active + more than 90 minutes past STD = Departed
  - active + less than 90 minutes past STD = Delayed
  - no API data still uses conservative Planned/Delayed timing.

Required Cloudflare secret:

`AVIATIONSTACK_KEY`
