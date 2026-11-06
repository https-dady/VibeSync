# VibeSync mobile

React Native 0.81 application for Android and iOS. All 21 screens live in `src/screens`; navigation is in `src/navigation`; room, socket, and auth state live in `src/context`.

## Quick start

From the repository root:

```bash
npm run install:all
cp apps/mobile/.env.example apps/mobile/.env
npm run configure:mobile
npm run mobile:start
```

Then in another terminal:

```bash
npm run mobile:android
# or on macOS
npm run mobile:ios
```

For iOS, run `bundle install && bundle exec pod install` in `ios/` first. For a physical phone, set `VIBESYNC_DEV_HOST` in `apps/mobile/.env` to your computer's LAN IP and reload Metro.

## Native nearby module

Offline rooms use:

- `android/app/src/main/java/com/vibesync/nearby/` — Kotlin BLE advertiser/scanner, GATT read fallback, NanoHTTPD local server, media Range streaming.
- `ios/VibeSync/VibeSyncNearby.swift` and `VibeSyncNearby.m` — CoreBluetooth + Network.framework equivalent.

The modules are already registered in the native projects and require a real Android/iOS build. Bluetooth discovery and local-network access cannot be tested in a browser or Metro alone. See `docs/NEARBY.md` and `docs/LIMITATIONS.md` in the repository root.

## Configuration

`scripts/apply-env.js` reads `.env` and generates `src/config/build.env.js`. Supported variables:

```dotenv
VIBESYNC_API_URL=https://api.vibesync.app
VIBESYNC_DEV_HOST=
VIBESYNC_WEB_URL=https://vibesync.app
VIBESYNC_APP_SCHEME=vibesync
```

`npm start`, `npm run android`, `npm run ios`, and `npm run bundle:android` invoke the generator automatically. The signed-in Settings screen can also override the API server at runtime.

## Tests and lint

```bash
npx jest --runInBand
npx eslint src App.js index.js scripts --ext .js --quiet
```

Clock/playback synchronization tests are in `__tests__/sync.test.js`. Native builds and physical-device testing are not automated.

## Signing

Android release signing is intentionally unset by default. See the root `docs/INSTALL.md` and `docs/DEPLOYMENT.md`, or set `VIBESYNC_UPLOAD_STORE_FILE`, `VIBESYNC_UPLOAD_STORE_PASSWORD`, `VIBESYNC_UPLOAD_KEY_ALIAS`, and `VIBESYNC_UPLOAD_KEY_PASSWORD` in your Gradle properties.

iOS signing must be configured in Xcode with your Apple developer team.
