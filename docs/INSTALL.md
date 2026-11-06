# Installation

This guide installs VibeSync for local development. For production, see [DEPLOYMENT.md](DEPLOYMENT.md).

## 1. Toolchain

| Tool | Required | Notes |
| --- | --- | --- |
| Node.js | 20.19+ | Verified with Node 24.18.1 |
| npm | 10+ | Ships with Node |
| MongoDB | 7 or 8 | Verified with MongoDB Memory Server 8.0.14 in tests |
| Redis | 7 (optional) | Required only for multiple API instances |
| Docker | Optional | The repository includes a Compose stack |
| Android Studio | Latest | Android SDK 36, build tools 36.0.0, NDK 27.1.12297006 |
| JDK | 17 recommended | React Native 0.81's Android build is tested with JDK 17. Newer JDKs may work but were not validated here. |
| Xcode | Current | macOS only, with CocoaPods |
| Ruby | 2.6.10+ | Used by the mobile `Gemfile` for CocoaPods |

The current development machine used for this repository has JDK 27 and no `ANDROID_HOME`, so no Android build could be produced here. Configure a JDK 17 installation and the Android SDK before building.

## 2. Install dependencies

From the repository root:

```bash
npm run install:all
```

This runs `npm install` in `services/api` and `npm install --legacy-peer-deps` in `apps/mobile`. The legacy peer flag is needed because several React Native libraries declare peer ranges that do not all match the React Native 0.81 template.

If you install mobile dependencies manually, use:

```bash
cd apps/mobile
npm install --legacy-peer-deps
```

## 3. API configuration

```bash
cp services/api/.env.example services/api/.env
# PowerShell
Copy-Item services/api/.env.example services/api/.env
```

At minimum, edit:

```dotenv
MONGODB_URI=mongodb://127.0.0.1:27017/vibesync
JWT_ACCESS_SECRET=<long random value>
JWT_REFRESH_SECRET=<long random value>
```

Generate secrets with `openssl rand -hex 32` or an equivalent password manager. The API validates the environment with Zod at startup and exits on invalid values.

Optional but recommended for real calls:

```dotenv
TURN_URL=turn:turn.example.com:3478
TURN_SECRET=<same secret as coturn static-auth-secret>
```

For multiple API instances, set `REDIS_URL=redis://127.0.0.1:6379`. A single instance works without Redis; presence falls back to in-memory state.

## 4. Start MongoDB

Local install:

```bash
mkdir -p data/mongo
mongod --dbpath ./data/mongo
```

Or Docker:

```bash
docker compose up -d mongo redis
```

The Compose API service is not started by that command, but the `.env` created above is still required because Compose validates the full file.

## 5. Start the API

```bash
npm run api
```

The development script uses `node --watch`. Verify:

```bash
curl http://localhost:4000/api/health
```

Expected fields include `"service": "vibesync-api"` and `"database": "connected"`.

## 6. Mobile configuration

```bash
cp apps/mobile/.env.example apps/mobile/.env
# PowerShell
Copy-Item apps/mobile/.env.example apps/mobile/.env
```

In development, leave `VIBESYNC_DEV_HOST` empty to use:

- Android emulator: `10.0.2.2:4000`
- iOS simulator: `localhost:4000`

For a physical phone, set it to the computer's LAN IP:

```dotenv
VIBESYNC_DEV_HOST=192.168.1.20
```

The phone and computer must be on the same network, and the firewall must allow TCP 4000. For a USB-connected Android device, `adb reverse tcp:4000 tcp:4000` also works.

Apply the configuration:

```bash
npm run configure:mobile
```

This writes `apps/mobile/src/config/build.env.js`. The `start`, `android`, `ios`, and `bundle:android` npm scripts run it automatically.

Release builds must point `VIBESYNC_API_URL` at an HTTPS API. `VIBESYNC_WEB_URL` controls invite-link generation and the trusted host used by the deep-link parser.

## 7. Run the mobile app

Terminal 1:

```bash
npm run mobile:start
```

Terminal 2, Android:

```bash
npm run mobile:android
```

On macOS, iOS:

```bash
cd apps/mobile/ios
bundle install
bundle exec pod install
cd ../../..
npm run mobile:ios
```

### Android notes

- `minSdkVersion` is 24; compile/target SDK is 36.
- Nearby hosting needs Bluetooth LE advertising and a Wi-Fi/hotspot interface. The app requests the runtime permissions declared in `AndroidManifest.xml`.
- The local HTTP server is plain HTTP on the LAN. `network_security_config.xml` permits cleartext only for local addresses while keeping `vibesync.app` and `api.vibesync.app` TLS-only.
- Release signing is **not** configured by default. Set the following in `~/.gradle/gradle.properties` (or pass `-P` flags) before building a release:
  ```properties
  VIBESYNC_UPLOAD_STORE_FILE=/absolute/path/to/upload.keystore
  VIBESYNC_UPLOAD_STORE_PASSWORD=...
  VIBESYNC_UPLOAD_KEY_ALIAS=...
  VIBESYNC_UPLOAD_KEY_PASSWORD=...
  ```
  Without these properties the release build produces an unsigned artifact rather than silently using the debug key.

### iOS notes

- The nearby module is `ios/VibeSync/VibeSyncNearby.swift` plus the `VibeSyncNearby.m` bridge. Both are already referenced by `VibeSync.xcodeproj`; run `pod install` after adding native dependencies.
- `Info.plist` contains Bluetooth, local-network, microphone, and `vibesync` URL-scheme entries.
- A physical device requires a signing team in Xcode. The simulator cannot advertise or scan Bluetooth LE, and nearby room testing needs two physical devices.
- iOS cannot create a Wi-Fi hotspot programmatically. Use an existing shared Wi-Fi network, or let an Android host create a hotspot and have the iPhone join it.

### Nearby mode requirements

Nearby mode is a native feature; it does not work in a plain JS environment or a simulator without Bluetooth.

- One device hosts and imports a local media file.
- The host opens a local HTTP server and advertises over BLE.
- Guests discover the room over BLE, then stream media and poll session state over the shared LAN.
- If BLE discovery is unavailable, the host screen shows the local address so guests can enter it manually.

See [NEARBY.md](NEARBY.md) for the protocol and [LIMITATIONS.md](LIMITATIONS.md) for platform restrictions.

## 8. Verify the installation

```bash
npm run test:api
npm run test:mobile
npm run lint
```

The default mobile API configuration is compiled into the JS bundle. To change the build default, edit `apps/mobile/.env`, rerun `npm run configure:mobile`, and restart Metro with a clean cache if necessary. A signed-in user can also set a custom API server in **Settings → API server** at runtime; restart the app afterward so Socket.IO reconnects to the new origin.

```bash
cd apps/mobile
npm start -- --reset-cache
```

## Troubleshooting

**`ECONNREFUSED` on a physical phone**
Use the computer's LAN IP, not `localhost`, or run `adb reverse tcp:4000 tcp:4000` for Android USB.

**MongoDB connection error**
Check `MONGODB_URI` and that MongoDB is listening. Docker Compose maps no Mongo port by default; the API container reaches `mongo:27017` over the Compose network. For host access, add a port mapping or use a local MongoDB.

**Refresh loop or immediate logout**
The API and phone clocks should be roughly correct, and `JWT_ACCESS_SECRET` must stay stable across restarts. Changing the secret invalidates every session.

**Metro cannot resolve a native module**
Run `npm install --legacy-peer-deps`, restart Metro with `--reset-cache`, rebuild the native app, and on iOS run `pod install`.

**iOS local network prompt never appears**
The prompt appears on first nearby connection attempt. If it was denied, enable Local Network access in iOS Settings for VibeSync and restart the app.

**Bluetooth discovery finds nothing**
Confirm Bluetooth is on, permissions are granted, and both devices are within range. On iOS, a device can only advertise in the foreground; keep the host screen open. If the host reports that BLE advertising is unavailable, use the address shown on the host screen.

**Android release uses the wrong signing key**
The Gradle properties above must be visible to the build. Verify with `./gradlew signingReport` in `apps/mobile/android`.
