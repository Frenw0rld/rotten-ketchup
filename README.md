# Rotten Ketchup

A browser extension that adds an **Independent Audience** ("Pull") score next to the Popcornmeter on Rotten Tomatoes movie pages, so the verified-ticket "push" bias behind the displayed score becomes visible.

## Install

- **Chrome Web Store**: [link TBD]
- **Firefox Add-ons (AMO)**: [link TBD]
- **Manual (Chrome / Chromium / Edge / Brave)**:
  1. Download or clone this repository.
  2. Open `chrome://extensions` (or the equivalent for your browser).
  3. Toggle **Developer mode** on (top right).
  4. Click **Load unpacked** and select the extension folder.
  5. Open a Rotten Tomatoes movie page (e.g. <https://www.rottentomatoes.com/m/the_odyssey_2026>).
- **Manual (Firefox)**:
  1. Open `about:debugging#/runtime/this-firefox`.
  2. Click **Load Temporary Add-on…** and select `manifest.json` from the extension folder.
  3. The extension is active until Firefox restarts; load it again after a restart.

## Privacy

Rotten Ketchup only reads the public scorecard data already present in the page (the inline JSON at `#media-scorecard-json`) and renders an extra score column next to the existing Popcornmeter. It does not make any network requests, does not collect or transmit any data, and does not run on any site other than `rottentomatoes.com/m/*`.
