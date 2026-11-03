# Relay mobile

Expo (SDK 54) app for iOS and Android. It works standalone and pairs with the Relay desktop app.

On the App Store: https://apps.apple.com/us/app/relay-accessibility-assistant/id6821441069

## Features

- Standalone: Blind Mode, Read Aloud, Live Captions (with translation and type-to-speak), Braille keyboard and haptic reader, Quick Phrases, Loud Sound Alert.
- Connect to Computer: QR pairing, Sound Alerts, Caption Mirror, Remote Mic.

## How AI access works

The app never contains provider keys. All OpenAI calls go through the Relay API proxy
(`website/api/`), and Deepgram captions use a short-lived token from `/api/deepgram/token`.
The only setting is the proxy URL:

```env
EXPO_PUBLIC_RELAY_API_URL=https://relay.suhaanthayyil.com/api
```

It is set in `.env` for local development and in every `eas.json` build profile.

## Develop

The app uses a native audio module, so it needs a development build (not Expo Go).

```bash
npm install
npx expo run:ios      # or: npx expo run:android
```

Checks:

```bash
npx tsc --noEmit
npx expo lint
npx expo-doctor
```

## Desktop pairing protocol (v1)

The phone connects to `ws://<host>:<port>/?token=<pairing code>&name=<device>` using the
values in the desktop QR code (`relay://pair?host=..&port=..&token=..&name=..&v=1`).

- Desktop to phone: `WELCOME`, `ALERT {message, severity}`, `CAPTION {text, isFinal, speaker}`, `AUDIO_ACK`, `AUDIO_REJECTED {reason}`, `PONG`
- Phone to desktop: `PING`, `AUDIO_START {sampleRate: 16000, encoding: 'linear16', channels: 1}`, binary PCM16 frames, `AUDIO_STOP`

## Release

```bash
eas build -p all --profile production
eas submit -p ios --profile production       # set submit.production.ios.ascAppId first
eas submit -p android --profile production   # uploads to the internal track as a draft
```

Store copy, privacy answers, and review notes are in `store/`.
