# UsageView

A tiny Windows tray app that serves a clean liquid-glass LAN dashboard for old tablets and small screens. It shows CPU, memory, GPU, Codex usage/limits, Spotify now playing, and time.

## Download / Run

Use the Windows installer EXE from Releases when available. Install UsageView, then open it from Start. It starts in the tray and opens onboarding in an app window.

The tray menu has:

- Open Dashboard
- Open Setup
- Copy Display URL
- Restart
- Quit

If you close the window, UsageView keeps running in the tray. If you do not see the tray icon, check Windows hidden icons near the clock.

For tablet/LAN viewing, Windows may ask whether to allow network access. Allow it on private networks.

The tablet URL shown in onboarding and copied from the tray is generated from the PC running UsageView. It is not a preset IP. If the PC changes networks, reopen setup or copy the display URL again so it uses the current LAN address.

## Build The EXE

```powershell
npm install
npm run dist
```

The Windows installer EXE is created in `release/`.

For development:

```powershell
npm install
npm run app
```

To verify onboarding before a release:

```powershell
npm test
```

The test uses a temporary data folder, launches the setup flow in Edge/Chrome, walks through every onboarding step, saves settings, and checks the dashboard.

## Onboarding

Setup is a short step-by-step flow:

- Display key and tablet URL
- Drag/drop widget order
- Custom widget names
- Hide/show widgets
- Widget size: Normal, Wide, Tall
- Dashboard width, glass strength, text size, density, and updated-time display
- Optional Spotify setup
- Refresh speed and density

Setup only works from localhost on the PC running the app. Network devices can read dashboard data only after using the viewer key.

The dashboard scales the whole widget surface down to fit the current screen, including small tablets and rotated displays. If a user enables many tall widgets, everything stays visible, but very tiny screens may make text small.

## Spotify

Spotify is optional.

1. Open the Spotify Developer Dashboard.
2. Create or open an app.
3. Add this redirect URI:

```text
http://127.0.0.1:8787/api/setup/spotify/callback
```

4. Paste the Client ID and Client Secret into onboarding.
5. Save, then click Connect Spotify.

The refresh token is created by Spotify during Connect Spotify and saved locally. Users should not need to find one manually.

## Security

- Setup routes are blocked from non-local clients.
- The dashboard is read-only from the network.
- Viewer access uses a generated display key.
- Secrets/config are stored locally in the app data folder, not in the repo.
- The UI does not expose hostname, username, raw paths, Spotify credentials, or Codex account labels.
- Security headers block framing, broad browser permissions, and external scripts.

## Accuracy

- CPU and memory use OS counters from Node.js.
- NVIDIA GPU stats use `nvidia-smi` when available.
- Non-NVIDIA GPUs show unavailable until a dedicated read-only collector is added.
- Codex today usage comes from local response logs.
- Codex all-time tokens use cumulative per-session `token_count` telemetry when available.
- Codex rate limits use the newest local `token_count` telemetry or a fresh status snapshot.

Codex tracking depends on local Codex telemetry files existing on that machine. UsageView looks for:

- `%USERPROFILE%\.codex\logs_2.sqlite`
- `%USERPROFILE%\.codex\sessions`
- `%USERPROFILE%\.codex\codex-status.json`, when present

If the user has a different Codex install path, no local telemetry, or a future Codex version changes the file format, the widget shows unavailable or partial data instead of guessing. Custom paths can be set with `CODEX_LOG_PATH`, `CODEX_SESSIONS_PATH`, and `CODEX_STATUS_PATH` in development.

Codex stats are always machine-local: the app reads the `.codex` folder for the Windows user running UsageView. Another PC will show that PC's Codex data, not yours.

## Publish Checklist

Before pushing:

- Keep `.env` untracked.
- Keep `data/` untracked.
- Keep `release/` untracked unless you intentionally publish binaries elsewhere.
- Do not commit screenshots that reveal local IPs or display keys.
- Run:

```powershell
npm run publish:check
```

See `PUBLISH.md` for the first GitHub push commands.
