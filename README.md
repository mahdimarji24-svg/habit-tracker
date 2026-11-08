# Habits

A small, private habit tracker that runs as an iPhone home-screen web app.
Plain HTML/CSS/JS — no frameworks, no build step. Hosted on GitHub Pages.

## Using it

- **Today**: tap a habit to mark it done, tap again to undo.
- **Press and hold** a habit for: rest day (skip today), progress & history, edit.
- **Habits** tab: tap a habit to see its heatmap. Tap any past day to cycle
  done → rest day → not done.
- **Settings**: "Day ends at" (default 3 am), export/import a JSON backup.

### Streaks
"Never miss twice": one missed day is forgiven; a streak only resets after two
missed scheduled days in a row. Rest days and unscheduled days never count
against you. "N times a week" habits count their streak in weeks.

### Your data
Everything is stored in `localStorage` on your phone only. Export a backup
(Settings → Export) every week or so and save it to Files / iCloud Drive.
The app reminds you if it has been more than 7 days.

## Files

| File | What it is |
| --- | --- |
| `index.html` | Page shell |
| `styles.css` | All styling, including dark mode |
| `app.js` | All app logic |
| `sw.js` | Service worker (offline support) |
| `manifest.webmanifest` | App name, icon, full-screen mode |
| `icons/` | App icons |

## Updating the app

After you push a change, open the app once and close it — the new version loads
the next time you open it (the service worker refreshes its cache in the
background). If you rename or add files, add them to the `ASSETS` list in
`sw.js` and bump `CACHE` (e.g. `habits-v2`).
