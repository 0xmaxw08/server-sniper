# Server Sniper (Chaos Edition)

An arcade-style DevOps incident response game, built for **Club Battle: Techverse**.

You are the on-call SRE. A 6x6 grid of 36 Kubernetes pods is running production traffic. Pods overload and crash. Keep system health above 0% for 60 seconds and score as high as you can.

Pure vanilla HTML, CSS and JavaScript. No frameworks, no build step.

## How to play

| Pod | What it means | How to fix it | Points |
|-----|---------------|---------------|--------|
| 🟡 Yellow | High CPU / memory leak | Hover and press `S`, **or** drag the Load Balancer onto it | +200 |
| 🔴 Red | Crashed / deadlocked | Hold left click for 0.75s, **or** double-click, type `kill` or `fix`, press Enter | +500 |
| 🟢 Green | Healthy | **Don't touch it!** Clicking or pressing `S` on it | -100 |

- An unhandled yellow turns red after 3 seconds.
- Each red pod drains 5% system health per second. Health at 0% is an instant game over.
- **Combo:** fix 3 pods within 2 seconds for 2x points for 5 seconds.
- **Uptime bonus:** +50 per second while health is above 80%.
- **Downtime penalty:** -100 per second while health is below 30%.
- **Traffic Spike (T-45s):** 6 healthy pods turn yellow.
- **Chaos Monkey (T-20s):** 8 pods crash at once, with screen shake and a siren.

Every run uses the same seeded spawn schedule, so all players face an identical game and scores are comparable.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Player screen: rules, name entry, game grid |
| `style.css` | Styling and animations |
| `game.js` | Game engine, spawn schedule, scoring, audio |
| `leaderboard.html` | Audience monitor with live leaderboard and reset |
| `config.js` | Database URL and reset passcode |
| `database.rules.json` | Firebase Realtime Database security rules |

## Run locally

```bash
cd server-sniper
python3 -m http.server 8000
```

- Player laptop: `http://localhost:8000`
- Audience monitor: `http://localhost:8000/leaderboard.html` (press F11 for fullscreen)

Use Chrome or Edge with a mouse. Click the page once before the first run so the browser allows audio.

With an empty `config.js` the leaderboard uses `localStorage`, so it only syncs between windows of the same browser on the same machine.

## Online leaderboard (Firebase)

1. Create a project at [console.firebase.google.com](https://console.firebase.google.com).
2. Go to **Build → Realtime Database → Create Database** and start in **locked mode**.
3. Open the **Rules** tab, paste in the contents of `database.rules.json`, and click **Publish**.
4. Copy the database URL from the **Data** tab into `config.js`:

   ```js
   window.SNIPER_DB_URL = "https://your-project-default-rtdb.region.firebasedatabase.app";
   window.SNIPER_RESET_PASS = "yourpasscode";   // optional, default is "reset"
   ```

5. Play a round and check that the score appears under `scores` in the Data tab.

The Firebase URL is not a secret. The security rules protect the data: anyone can read scores and add a validated score, and nobody can edit an existing one.

### Resetting scores

Click **RESET SCORES** at the bottom right of the leaderboard page, enter the passcode, and confirm. This needs the `".write": "newData.val() == null"` rule under `scores`.

The passcode is client-side only, so it prevents accidental clicks but not a determined person. After the event, remove that rule line and publish, so nobody can delete scores except you from the Firebase console.

## Deploy on Vercel

1. Push the folder to a GitHub repo.
2. On [vercel.com](https://vercel.com), choose **Add New → Project** and import the repo.
3. Set Framework Preset to **Other**, leave the build command empty, and deploy.

Or from the folder: `npx vercel`, then `npx vercel --prod`.

Use `yoursite.vercel.app` for the player and `yoursite.vercel.app/leaderboard.html` for the audience screen. They can be on different machines once Firebase is set up.

## Tuning difficulty

All in `game.js`:

| Setting | What it changes |
|---------|-----------------|
| `WAVE_EARLY`, `WAVE_LATE` | The spawn pattern. Each entry is `[ms offset, "Y" or "R"]`. Add or remove entries to change difficulty |
| `SEED` | Gives a different layout, still identical for every player |
| `HOLD_MS` | Red hold time in ms (default 750) |
| `GREEN_PENALTY` | Points lost for hitting a green pod (default 100) |
| `WARN_TO_RED_MS` | How long a yellow lasts before turning red (default 3000) |
| `REGEN_PER_TICK` | Slow health recovery when no pods are red. Set to `0` to disable |

## Before the event

- Play a test run, then clear the test scores from the leaderboard.
- Check the live site saves a score to Firebase.
- Put the leaderboard in fullscreen on the second monitor.
