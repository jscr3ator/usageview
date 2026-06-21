# UsageView
<img width="4000" height="2252" alt="image" src="https://github.com/user-attachments/assets/1a8bdb89-fc78-41f2-8d1a-605240621eae" />

network accessed app that allows your codex usage + other stats of your choice to be displayed cleanly and easily fully customizable!

## Download / Run

Use the Windows installer EXE from Releases when available. Install UsageView, then open it from Start. It starts in the tray and opens onboarding in an app window.

The tray menu has:

- Open Dashboard
- Open Setup
- Copy Display URL
- Restart
- Quit

If you close the window, UsageView keeps running in the tray. If you do not see the tray icon, check Windows hidden icons near the clock.

## Build The EXE FROM SOURCE

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

## Onboarding

Setup only works from localhost on the PC running the app. Network devices can read dashboard data only after using the viewer key.

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
- you don't even have to login to codex =P
- there is no logs kept from us all done locally - although it wouldn't really matter as no one cares about how much usage u have, but just thought i'd throw it out there

## Accuracy

- CPU and memory use OS counters from Node.js.
- NVIDIA GPU stats use `nvidia-smi` when available.
- Non-NVIDIA GPUs show unavailable until a dedicated read-only collector is added. (WIP)
- Codex today usage comes from local response logs.
- Codex all-time tokens use cumulative per-session `token_count` telemetry when available.
- Codex rate limits use the newest local `token_count` telemetry or a fresh status snapshot.

Codex tracking depends on local Codex telemetry files existing on that machine. UsageView looks for - so you don't have to login, all is found locally:

- `%USERPROFILE%\.codex\logs_2.sqlite`
- `%USERPROFILE%\.codex\sessions`
- `%USERPROFILE%\.codex\codex-status.json`, when present

If you have a different Codex install path, no local telemetry, or a future Codex version changes the file format, the widget shows unavailable or partial data instead of guessing. Custom paths can be set with `CODEX_LOG_PATH`, `CODEX_SESSIONS_PATH`, and `CODEX_STATUS_PATH` in the development.
