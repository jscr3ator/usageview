# UsageView v1.0.0

Short description:

UsageView is a Windows tray app that serves a clean read-only LAN dashboard for PC stats, Codex usage, Codex limits, Spotify now playing, and time.

## Download

Windows installer:

`UsageView Setup 1.0.0.exe`

## What Changed

- Edit this line.
- Edit this line.
- Edit this line.

## Setup Notes

- Install the EXE.
- Open UsageView from Start.
- Use the tray icon to open setup.
- Copy the tablet display URL from setup or the tray menu.
- Spotify is optional and can be skipped.

## Security Notes

- Setup is localhost-only.
- Network clients can only read dashboard stats after entering the display key.
- Secrets are stored locally on the user's PC.
- The source release should not include `data/`, `.env`, `release/`, or `node_modules/`.

## Known Limits

- NVIDIA GPU stats use `nvidia-smi`.
- Codex stats depend on local Codex telemetry files being present on the same machine.
- Spotify requires a Spotify developer app and redirect URI setup.

## Checks

- `npm test`
- `npm run publish:check`

