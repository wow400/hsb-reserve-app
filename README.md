# HSB Reserve App v42

Cloudflare Worker app. Upload both `src/index.js` and `src/index.mjs` to the repository `src` folder.

## v42 changes
- Adds a small radio-style **Select all** control to the right of **Paste BA/FICO flight list**.
- Tapping it focuses the FICO text box and selects its entire contents for quick copy/paste replacement, including on iPhone/iPad Safari.
- The selector briefly highlights to confirm the action.
- All v41 live-refresh feedback and v40/v39 parsing, BLR/Scheme and HSB logic are otherwise unchanged.
