# HSB Reserve App v10

Uses FlightAware AeroAPI with manual refresh only and an $8/month app-side cap.

Required Cloudflare configuration:

- Secret: `FLIGHTAWARE_API_KEY`
- KV namespace binding: `USAGE_KV`

The app blocks AeroAPI calls if `USAGE_KV` is missing.
