# HSB Reserve App v11

Clean rebuild.

Cloudflare requirements:
- Secret: FLIGHTAWARE_API_KEY
- KV binding: USAGE_KV
- KV namespace ID included in wrangler.toml

Safety:
- Manual FlightAware refresh only
- No automatic paid polling
- $8.00 monthly app cap
- 10-minute cached FlightAware responses
- Blocks paid calls if usage tracking fails
