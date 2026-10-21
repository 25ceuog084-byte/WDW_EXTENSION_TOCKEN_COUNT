# Usage Meter for Claude

Load it: chrome://extensions -> Developer mode -> Load unpacked -> pick this folder. (Needs Chrome 120+.)

## How it works
1. After every reply, inject.js reads the usage report Claude adds to it (this is what works on the FREE plan);
   every 30 seconds background.js also asks claude.ai's /usage page (paid plans only).
2. background.js saves the session % and weekly % and puts the number on the toolbar icon.
3. content.js draws the floating meter and popup.js draws the popup; both just read what background.js saved (getState).
4. When your 5-hour session ends, background.js sends a notification.

## Files
- inject.js      reads the usage report at the end of each reply (~40 lines)
- background.js  get usage -> save -> badge -> notification   (~150 lines)
- content.js     the floating meter on claude.ai               (~100 lines, mostly UI)
- popup.*        the toolbar popup (UI)

## Not included, on purpose
Multiple accounts, per-model / extra-usage numbers,
messages-left, chat size, limit-reached detection.

## Debugging
chrome://extensions -> "service worker" -> Console. Lines start with [usage-meter].
