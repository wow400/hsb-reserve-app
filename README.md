# HSB Reserve App v6

Single Cloudflare Worker application.

v6 changes:
- Full "Scheduled" wording.
- Prevents yesterday's landed overnight flight being used for today's BA057/BA055.
- Active without departure evidence shows Awaiting departure, not safe.
- Adds coloured 3D-style status dots.
- Tightens table row spacing and slightly increases table text size.

Required Cloudflare secret:

`AVIATIONSTACK_KEY`
