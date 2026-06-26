# HSB Reserve App v7.1

Single Cloudflare Worker application.

v7.1 fixes:
- Fixed JavaScript startup issue from v7.
- Restored UTC clock, still-callable card, stats, and table rendering.
- Removed empty gold box.
- Kept dark operational layout.
- Kept table chronological.
- Merged Call/Safe into Call by.
- Removed Reserve column; coloured dots show reserve state.
- BA-style statuses: Planned, Delayed, Departed, Cancelled, Diverted, Unknown.

Required Cloudflare secret:

`AVIATIONSTACK_KEY`
