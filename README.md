# VibeSync

VibeSync is an independent, cross-platform synchronized multimedia platform: people create rooms, add audio or video, and every listener stays on the same playback position. It works online through a Node.js API and Socket.IO, and nearby without internet through Bluetooth discovery plus a local HTTP media server.

The entire project lives in this repository. It has its own frontend, backend, database schema, authentication, environment, APIs, deployment files, and dependencies. It does not share code, data, services, or configuration with any other project.

> **Validation status:** the API integration suite (10 tests), mobile synchronization tests (8 tests), JavaScript parsing, and lint checks pass in this environment. Native Android and iOS builds and physical-device behavior have **not** been compiled or tested here. See [Known limitations](docs/LIMITATIONS.md) before treating a platform path as verified.

## What is implemented

- **Accounts:** registration, login, JWT access tokens, rotating refresh tokens with reuse detection, logout, logout-all, password change, profile and device registration.
- **Rooms:** instant room creation, public/private visibility, passwords, capacity limits, discovery/search, join approval, kick/ban, host settings updates, and room ending.
- **Server-authoritative playback:** host commands and heartbeats are persisted with timestamps. Clients estimate clock offset and correct drift by seeking or soft playback-rate adjustment.
- **Media:** authenticated resumable Range streaming for uploaded files, external HLS/DASH/MP4/audio URLs, media queue, host-only uploads, 500 MB default upload limit, and DRM license metadata passthrough (no DRM or HDCP bypass).
- **Host controls:** approval queues, participant permissions, mute-all, microphone requests, private host inbox, chat moderation, and room settings.
- **Voice:** WebRTC audio mesh for approved speakers, ephemeral coturn credentials, optional LiveKit token endpoint, and speaker-level mute enforcement.
- **Chat:** room chat, private host-to-participant messages, moderation, rate limits, and realtime delivery.
- **Nearby mode:** BLE discovery and a local HTTP server for offline media, chat, members, and playback state. The local session never contacts the API; the app currently requires an existing signed-in session to open the Nearby tab, so first-time use needs one online sign-in.
- **21 screens:** all screens are connected through React Navigation; see the [screen map](docs/SCREENS.md).
- **Visual system:** black `#000000`, orange `#FD8549`, yellow `#FFC123`, off-white `#F1F3F5`, shared typography, spacing, and accessible components.

## Architecture

```text
React Native app (Android + iOS)
  ├─ REST /api/* ──────────────► Express API ─────────► MongoDB
  ├─ Socket.IO ────────────────► Socket.IO server ────► Redis adapter (optional)
  ├─ WebRTC audio mesh ────────► STUN / TURN (coturn)
  └─ Native nearby module ─────► BLE discovery + local HTTP server (host device)
                                  └─ media Range streaming, chat, playback state
```

The API is a modular monolith. Services publish domain events on an in-process bus; the realtime bridge forwards them to Socket.IO rooms. When `REDIS_URL` is configured, Redis provides Socket.IO fan-out and presence/rate-limit state for multiple API instances.

## Repository layout

```text
VibeSync/
├─ apps/mobile/                  React Native 0.81 app (JavaScript)
│  ├─ src/screens/               21 required screens
│  ├─ src/context/               auth, socket, room state
│  ├─ src/media/                 synchronized player
│  ├─ src/voice/                 WebRTC mesh engine
│  ├─ android/                   Kotlin nearby module and app config
│  └─ ios/                       Swift nearby module and app config
├─ services/api/                 Express 5 + MongoDB + Socket.IO API
│  ├─ src/models/                Mongoose models
│  ├─ src/routes/                REST endpoints
│  ├─ src/realtime/              Socket.IO handlers and bridge
│  ├─ src/services/              room, playback, chat, media, voice, auth logic
│  └─ tests/                     API integration tests
├─ deploy/                       reverse proxy, TURN, systemd examples
├─ docs/                         install, development, deployment, API, screens, limitations
├─ docker-compose.yml            API + MongoDB + Redis
└─ package.json                  root convenience scripts
```

## Quick start

### Prerequisites

- Node.js **20.19+** (tested with Node 24.18.1) and npm
- MongoDB 7 or 8, locally or in Docker
- Redis 7 **optional** (required for multiple API instances)
- Android: Android Studio, Android SDK 36, build tools 36.0.0, NDK 27.1.12297006, and a compatible JDK (React Native 0.81 builds are tested with JDK 17)
- iOS: macOS with Xcode and CocoaPods

Full instructions, including physical-device networking, are in [docs/INSTALL.md](docs/INSTALL.md).

### 1. Install dependencies

```bash
npm run install:all
```

The mobile install uses `--legacy-peer-deps` because the React Native 0.81 template and its native libraries do not all publish matching peer ranges.

### 2. Configure the API

```bash
cp services/api/.env.example services/api/.env
# PowerShell: Copy-Item services/api/.env.example services/api/.env
```

Set `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` to long random values. `NODE_ENV=production` refuses to start with the example secrets.

### 3. Start MongoDB and the API

Either run MongoDB locally:

```bash
mongod --dbpath ./data/mongo
```

or start the provided containers (create `services/api/.env` first; Compose validates the whole file even when starting only these services):

```bash
docker compose up -d mongo redis
```

Then start the API:

```bash
npm run api
```

The API listens on `http://localhost:4000`; health is at `/api/health`.

### 4. Configure and start the mobile app

```bash
cp apps/mobile/.env.example apps/mobile/.env
# Optional: set VIBESYNC_DEV_HOST to your computer's LAN IP for a physical phone.
npm run configure:mobile
```

`npm run configure:mobile` generates `apps/mobile/src/config/build.env.js`. The `start`, `android`, `ios`, and `bundle:android` scripts run it automatically.

```bash
npm run mobile:start
# in another terminal
npm run mobile:android
# or, on macOS
npm run mobile:ios
```

For iOS, install pods first:

```bash
cd apps/mobile/ios
bundle install
bundle exec pod install
cd ../../..
```

For a physical Android phone, use `adb reverse tcp:4000 tcp:4000` or set `VIBESYNC_DEV_HOST` to the computer's LAN IP. A physical iPhone on Wi-Fi needs the LAN IP as well; `localhost` only works in the simulator.

## Tests and checks

```bash
npm run test:api       # 10 API integration tests (MongoDB Memory Server)
npm run test:mobile    # 8 clock/playback synchronization tests
npm run lint           # backend ESLint + mobile ESLint
```

Test results in this environment:

- Backend: **10/10 passed** with `npx jest --runInBand --detectOpenHandles tests/integration.test.js`
- Mobile: **8/8 passed** with `npx jest --runInBand`
- Lint: backend and mobile ESLint clean (mobile was run against `src App.js index.js scripts`)
- All JavaScript files parse with Babel; native Kotlin/Swift was reviewed but not compiled

## Configuration reference

| File | Purpose |
| --- | --- |
| `services/api/.env` | API port, MongoDB, Redis, JWT secrets, CORS, storage, STUN/TURN, LiveKit, logging |
| `apps/mobile/.env` | API URL, development host, web URL, deep-link scheme |
| `docker-compose.yml` | Production-oriented API, MongoDB, and Redis containers |
| `deploy/` | Caddy/Nginx reverse proxy, coturn, and systemd examples |

The API endpoint and Socket.IO event reference is in [docs/API.md](docs/API.md). Nearby transport details are in [docs/NEARBY.md](docs/NEARBY.md).

## Documentation

- [Installation](docs/INSTALL.md)
- [Development guide](docs/DEVELOPMENT.md)
- [API and realtime reference](docs/API.md)
- [Nearby offline transport](docs/NEARBY.md)
- [Production deployment](docs/DEPLOYMENT.md)
- [Screen map](docs/SCREENS.md)
- [Third-party services and dependencies](docs/THIRD_PARTY.md)
- [Known limitations](docs/LIMITATIONS.md)

## Security and legal notes

- Access tokens are held in the OS keychain/keystore (`react-native-keychain`), never AsyncStorage.
- Uploaded media is served only through authenticated Range endpoints. The API validates file MIME types, size limits, URLs, and DRM license URLs.
- Production deployments must use HTTPS and a real TURN deployment. Message content, media, and credentials are not end-to-end encrypted beyond the transport; this is an explicit limitation.
- DRM-protected media must be supplied with a legitimate license server. VibeSync passes license metadata to the platform player and does not decrypt, record, or bypass Widevine, FairPlay, PlayReady, ClearKey, or HDCP.
- You are responsible for the rights to any media you add and for complying with each third-party service's terms.

## License

No license has been granted yet. Add one before distributing the project.
