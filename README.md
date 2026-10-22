# EDGE // Voltage Gambler

A web app that rewards you for living at 1%.

The lower your battery, the more points you make. The longer your phone stays dead, the more points you make. You race your friends on a crew leaderboard. The point: a phone that's dying in your pocket is a phone you're not scrolling. It's a sneaky way to cut screen time.

It's a plain static site (no build step to run it, no server of your own), so you can host it free on GitHub Pages and anyone can add it to their home screen like an app.

---

## What works where

| Phone | Battery reading | Notes |
|---|---|---|
| **Android + Chrome** | Automatic | The browser exposes the battery, so EDGE reads it for you. |
| **iPhone / Safari** | Manual check-in | Apple doesn't let websites read the battery. EDGE shows a slider you set to your real battery %. It's an honor system, and it's labeled that way in the app. |
| **Desktop Chrome / Edge** | Automatic (laptops) | Handy for testing. |

Crews and scoring are identical on both. The leaderboard shows who's lowest right now, who's been dead longest, and who has the most points.

## How scoring works

Web apps can't run while a phone is locked or dead, so EDGE never tries to watch in the background. Every time you open it (or the battery level changes, or every 15 seconds while it's on screen) it compares against the *previous* look. If both looks were low, nothing was charging, and the battery only went down, the whole gap is credited. That means you earn while the phone sits locked in your pocket. Screen time earns you nothing extra.

- Only battery at **15% or less** counts, and **charging counts for nothing**.
- 1 point per minute, times a multiplier: **15% or less = 2x**, **5% or less = 5x**, **1% or less = 10x**.
- One gap between looks is credited for at most 6 hours.
- **Blackouts**: at 10% or less (not charging) you can tap **MARK SHUTDOWN TIME** before the phone dies. When you open EDGE again after it's been off for at least 5 minutes, it asks you to confirm. A blackout pays 15 points per minute, plus 200 bonus points if you armed at 5% or less (50 otherwise). One blackout counts for at most 24 hours.
- **Streak**: consecutive days with a look at 10% or less, not charging. Miss a day and it resets.
- **Badges**: 1% SURVIVOR, FLATLINER (dead 2h+), BLACKOUT KING (dead 8h+), VOLTAGE GAMBLER (1 hour straight at 5% or less), ZERO HERO (your first blackout).

All the numbers live in one place: the `RULES` block at the top of `engine.js`.

**Honest limit:** dead time and the iPhone slider are honor-system. A friend can lie about it. The game is for friends who are in on it, not strangers.

---

## Put it online (GitHub Pages)

You'll need a free GitHub account. You can do it from Terminal or entirely in the browser.

### Option A: Terminal (fastest)

Open the Terminal app, then run these one at a time. Replace the path in the first line with wherever you unzipped the folder.

```bash
cd ~/Downloads/edge
```

If you have never used GitHub from Terminal, install and sign in to the GitHub command line tool first (skip this if `gh auth status` already says you're logged in):

```bash
brew install gh
gh auth login
```

(No Homebrew? Use Option B below instead.)

Then:

```bash
git init -b main
git add .
git commit -m "EDGE"
gh repo create edge --public --source=. --push
gh api -X POST repos/{owner}/{repo}/pages -f "source[branch]=main" -f "source[path]=/"
```

Your app will be live in a minute or two at `https://YOUR-GITHUB-USERNAME.github.io/edge/`.

### Option B: no Terminal

1. Go to https://github.com/new, name it `edge`, keep it Public, click **Create repository**.
2. On the next page click **uploading an existing file**, then drag in **everything inside the unzipped `edge` folder** (not the folder itself, and skip `node_modules` if you have one). Click **Commit changes**.
3. Go to the repo's **Settings > Pages**. Under **Build and deployment**, set Source to **Deploy from a branch**, Branch to **main**, folder to **/ (root)**, and Save.
4. Wait a minute or two. The page shows your live link.

### Optional: your own address (like garage.masen.site)

1. Add a file named `CNAME` to the repo containing one line: `edge.masen.site`. From Terminal, inside the folder:

   ```bash
   echo "edge.masen.site" > CNAME
   git add CNAME
   git commit -m "Custom domain"
   git push
   ```

2. At wherever masen.site's DNS lives, add a **CNAME** record: name `edge`, value `YOUR-GITHUB-USERNAME.github.io`.
3. In the repo's **Settings > Pages**, set the custom domain to `edge.masen.site` and tick **Enforce HTTPS** once it's available.

All paths in the app are relative, so it works at either address.

---

## Add it to your home screen

- **iPhone (Safari)**: open the link, tap **Share**, then **Add to Home Screen**.
- **Android (Chrome)**: open the link and tap the **INSTALL** button in the header (or Chrome's menu > **Install app**).

It works offline once it's been opened one time.

---

## Turn on the crew leaderboard (optional, free)

Without this, EDGE runs in solo mode: everything stays on your phone and there's no CREW tab. With it, you and your friends share a live board. It uses [Supabase](https://supabase.com) as a tiny shared database.

1. Sign up at https://supabase.com and click **New project** (free plan is fine). Pick any name and a password you won't need again.
2. When the project is ready, open **SQL Editor** in the left menu, click **New query**, paste in everything from `supabase/schema.sql`, and click **Run**. You should see "Success". (It's safe to run twice.)
3. Open **Project Settings > API Keys** (older projects: **Settings > API**). Copy the **Project URL** and the **publishable** key (older projects call it the **anon** key).
4. Open `config.js` and paste them in:

   ```js
   SUPABASE_URL: "https://abcdxyz.supabase.co",
   SUPABASE_KEY: "sb_publishable_...",
   ```

5. Commit and push so the live site updates. In Terminal, inside the folder:

   ```bash
   git add config.js
   git commit -m "Turn on crews"
   git push
   ```

6. Open the app, go to **CREW**, pick a name, and hit **NEW CREW**. Tap **COPY INVITE** to send friends a link that drops them straight into your crew (or they can type your 6-character code and hit **JOIN CREW**).

Good to know:

- That key being in a public file is normal and intended. The database has no readable tables. Everything goes through four locked-down functions in `schema.sql`, and each player has a secret key that only lives on their phone, so nobody can post as someone else or read other crews.
- Crew codes are 6 characters. A crew holds up to 30 people. Names are unique per crew.
- **Supabase free projects pause after a week or so of no activity.** If the board stops loading after a quiet stretch, open your project on supabase.com and click **Restore**.
- Crew names are shown as plain text only, so a friend can't inject anything into your screen.

---

## For developers

```bash
npm install          # first time only (just Tailwind)
npm run build:css    # rebuild styles.css after editing src/input.css or index.html classes
npm test             # engine unit tests (node:test, no dependencies)
```

- The story card's footer prints your site's address by default. Set `WATERMARK` in `config.js` to print something else.
- `index.html`: the UI. `app.js`: wiring. `engine.js`: all the rules, pure logic with tests. `crew.js`: the Supabase client (plain `fetch`, no SDK). `config.js`: your settings.
- `styles.css` is the committed, precompiled Tailwind build, so the site needs no build step to deploy.
- `sw.js` is the service worker (offline support). **Bump `VERSION` in `sw.js` every time you ship a change** so installed copies pick it up.
- To try it locally: `python3 -m http.server 8000`, then open http://localhost:8000. Add `?debug` to the URL for a panel with buttons to fake 1% battery or a 2.5-hour blackout.

## Credits

Concept by Masen Steiner. Fonts: Inter, Space Mono and Comic Neue (SIL Open Font License, licenses in `fonts/`). The logo is set in Comic Sans on phones that have it (iPhone, Mac, Windows). Android doesn't ship Comic Sans, so it gets Comic Neue, a close open-source lookalike.
