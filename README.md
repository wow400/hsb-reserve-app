# HSB Reserve App v8

Single Cloudflare Worker application.

v8 fixes:
- Status no longer falls back to Unknown when FICO timing gives a usable state.
- Planned / Delayed / Departed terminology.
- Grey dots fixed.
- Top still-callable list excludes safe flights.
- Counts now follow operational state, not API availability alone.
- Keeps table chronological.
- Keeps dark operational v7 layout.

Required Cloudflare secret:

`AVIATIONSTACK_KEY`
