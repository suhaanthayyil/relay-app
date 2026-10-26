# Relay

Relay is an accessibility app for desktop and mobile.

It gives live captions, sound alerts, voice commands, and optional gesture camera input on the desktop,
plus a companion phone app for iOS and Android.

Website: https://relay.suhaanthayyil.com

## For Judges

Use the **Releases** page for the fastest demo setup:

- macOS Apple Silicon: `Relay-mac-arm64.dmg`
- macOS Intel: `Relay-mac-x64.dmg`
- Windows x64: `Relay-windows-x64-setup.exe`
- Linux x64 AppImage: `Relay-linux-x64.AppImage`
- Linux x64 deb: `Relay-linux-x64.deb`

Direct links always point to the newest release:

- `https://github.com/suhaanthayyil/relay-app/releases/latest/download/Relay-mac-arm64.dmg`
- `https://github.com/suhaanthayyil/relay-app/releases/latest/download/Relay-mac-x64.dmg`
- `https://github.com/suhaanthayyil/relay-app/releases/latest/download/Relay-windows-x64-setup.exe`
- `https://github.com/suhaanthayyil/relay-app/releases/latest/download/Relay-linux-x64.AppImage`
- `https://github.com/suhaanthayyil/relay-app/releases/latest/download/Relay-linux-x64.deb`

## Unsigned Build Note

macOS signing is planned for a later release.

Right now, macOS builds are unsigned. You may need to open the app from **Privacy & Security** and click **Open Anyway**.

Windows may show SmartScreen. Click **More info** then **Run anyway**.

## What Relay Does

- Live speech captions with speaker labels
- Deaf mode with gesture camera panel
- Blind mode with voice-first controls
- Sound event alerts (alarm, knock, dog bark, and more)
- AI Guide with step-by-step help
- Meeting transcripts and summaries
- Text to speech output
- Phone pairing by QR code: sound alerts on your phone, caption mirror, and Remote Mic

## Mobile App

The phone app lives in `mobile/` (Expo). See `mobile/README.md`.

- Standalone: Blind Mode, Read Aloud, Live Captions with translation, Braille, Quick Phrases, Loud Sound Alert
- With the desktop app: Sound Alerts, Caption Mirror, Remote Mic

## Build From Source

### Requirements

- Node.js 18+
- npm

### Setup

```bash
git clone https://github.com/suhaanthayyil/relay-app.git
cd relay-app
npm install
cp .env.example .env
```

Installed builds need no keys. They reach OpenAI and Deepgram through the Relay API proxy
(`website/api/`). For local development you can optionally add your own keys to `.env`:

```env
DEEPGRAM_API_KEY=your_deepgram_api_key_here
OPENAI_API_KEY=your_openai_api_key_here
```

Keys in `.env` are only used by `npm start` and are never packaged into installers.

### Run

```bash
npm start
```

### Build Installers

```bash
npm run build
```

## AI Services

- Without local keys (and in every installer), AI features use the Relay API at `https://relay.suhaanthayyil.com/api`.
- Set `RELAY_API_BASE` to use a different deployment, or `RELAY_FORCE_PROXY=1` to test the proxy while local keys are present.
- If the service is unreachable, captions fall back to the offline Whisper engine.

The proxy needs `OPENAI_API_KEY` and `DEEPGRAM_API_KEY` set as Vercel environment variables.
The Deepgram key must have the Member role (required to issue temporary tokens).

## Project Layout

- `electron/` main process and IPC
- `renderer/` overlay UI and feature modules
- `assets/` icons, sounds, models
- `website/` public site (Vite + React) and the Relay API proxy (`website/api/`)
- `mobile/` iOS and Android app (Expo)
- `scripts/` verification scripts

## Verify

```bash
npm run verify:strict
```

## License

ISC
