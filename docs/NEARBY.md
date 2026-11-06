# Nearby offline transport

Nearby mode lets one device host an offline room and other devices on the same local network join it. The local session does not use the VibeSync API, MongoDB, or JWT account tokens, and it works without internet once the app has been signed in. The current app shell is auth-gated: a user must sign in online once before the Nearby tab is available.

## How it works

```text
Host device                                Guest device
───────────                                ────────────
choose a local media file
start local HTTP server (random port) ──┐
advertise BLE payload                  │
                                       │   BLE scan
                                       └──► discover code, IP, port
                                           POST /vibesync/join
                                           GET  /vibesync/session  ──► sync state
                                           GET  /vibesync/media    ──► Range stream
                                           POST /vibesync/messages ──► chat
                                           POST /vibesync/leave
```

- The host's app owns the media file; guests never upload or download a copy to disk.
- Playback is still host-authoritative. The host updates local playback state; guests poll it and correct their player.
- Once the app has a stored signed-in session, nearby hosting/joining, chat, and playback work without internet. Signing out removes access to the Nearby tab; there is no guest/anonymous app mode.
- Room discovery is best-effort BLE. If Bluetooth is unavailable, guests can type the host's LAN address (`192.168.x.x:port`) shown on the host screen.
- The local session uses a canonical 4-character code because the BLE advertisement payload reserves four bytes for it.

## BLE discovery

| Item | Value |
| --- | --- |
| Service UUID | `5bc3b1f0-8b4d-4c47-9a1e-3d8f2c7a6e10` |
| Read characteristic | `5bc3b1f0-8b4d-4c47-9a1e-3d8f2c7a6e11` |
| Payload version | `1` |
| Payload size | 11 bytes |

Payload layout:

```text
byte 0      version (1)
bytes 1-4   room code, ASCII, uppercase, 4 characters
bytes 5-8   host IPv4 address
bytes 9-10  HTTP port, big-endian
```

Android advertises the payload as BLE service data and includes the service UUID. iOS cannot advertise arbitrary service data, so the host advertises the service UUID and exposes the same 11-byte payload through the read characteristic. Scanners on both platforms first read service data and fall back to a GATT read; discovered peripherals are retained until the GATT attempt finishes.

## Local HTTP contract

All JSON responses use:

```json
{ "ok": true, "session": { "...": "..." }, "serverNow": 1760000000000 }
```

Errors use:

```json
{ "ok": false, "error": "Human-readable message", "code": "MACHINE_CODE" }
```

Authenticated requests send `X-VibeSync-Token`. Guest tokens are created by `/vibesync/join`.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/vibesync/join` | none | `{name}`; returns guest token, member ID, session. |
| GET | `/vibesync/session` | guest token | Session, members, playback, messages, media metadata, `serverNow`. |
| POST | `/vibesync/playback` | host token | Update `{status, positionMs, rate}`. |
| POST | `/vibesync/messages` | guest/host token | Append `{body}` to room chat. |
| POST | `/vibesync/leave` | guest token | Remove the guest from the session. |
| GET / HEAD | `/vibesync/media` | guest/host token | Stream the host's file with HTTP Range support. |
| OPTIONS | any | none | CORS/preflight response. |

The app polls the session every 1.1 s as a guest and every 1.5 s as a host. Polls are guarded so a slow request cannot overlap the next one. Guests estimate host clock offset from the request midpoint and seek on drift over 1 s; late joiners are seeked to the host position when the media loads.

## Media

- The host imports a file through the document picker. Android copies it into app storage; iOS uses a security-scoped resource and copies it into the app's local storage.
- The host's own player uses the local file URI; guests use the local HTTP endpoint.
- Range requests support seeking and resuming. The server returns `206 Partial Content`, `Content-Range`, and `Accept-Ranges`.
- Media never leaves the LAN. There is no relay or cloud fallback.

## Chat and members

- Nearby chat is a single room channel. Private host DMs and microphone/voice rooms are online-only features.
- Members disappear when they leave or the host stops the server.
- The local session cap is enforced by the native session state; the UI shows the member count.

## Platform behavior and permissions

### Android

- Manifest permissions: Bluetooth scan/advertise/connect, legacy Bluetooth/location for Android 11 and below, Wi-Fi state, internet, and network state.
- Android 12+ asks for `BLUETOOTH_SCAN`, `BLUETOOTH_ADVERTISE`, and `BLUETOOTH_CONNECT` at runtime. Android 11 and below use location permission for BLE scanning.
- Hosting requires a LAN interface. The module selects Wi-Fi, hotspot (`ap`/`swlan`), Ethernet, or USB tethering addresses and ignores cellular interfaces.
- `usesCleartextTraffic` is enabled because the local server is HTTP. The network security config nevertheless forces TLS for the public VibeSync hosts.

### iOS

- `NSBluetoothAlwaysUsageDescription`, `NSBluetoothPeripheralUsageDescription`, and `NSLocalNetworkUsageDescription` are set in `Info.plist`.
- iOS cannot create a Wi-Fi hotspot programmatically. Both devices must join an existing network, or an Android host's hotspot.
- CoreBluetooth peripheral advertising is limited and may stop when the app is backgrounded or the screen locks. Keep the host screen open.
- The first local HTTP connection triggers the Local Network permission prompt. If denied, nearby mode cannot reach the host.
- The iOS simulator does not support Bluetooth LE scanning/advertising. Use two physical devices.

## Security boundaries

- Nearby traffic is plain HTTP on the local network. The guest token prevents unrelated devices from reading the session or media, but it is not a substitute for TLS against a hostile local network.
- Do not use nearby mode on untrusted public Wi-Fi for sensitive content.
- The host file is readable only while the room is active. Stopping the host server closes the listener and removes guest tokens.
- There is no internet dependency, account authentication, analytics, or cloud persistence in this path.

## Code map

| Platform | File |
| --- | --- |
| JS bridge | `apps/mobile/src/services/nearby.js` |
| Nearby UI | `apps/mobile/src/screens/NearbyScreen.js` |
| Android native | `apps/mobile/android/app/src/main/java/com/vibesync/nearby/VibeSyncNearbyModule.kt` |
| Android registration | `apps/mobile/android/app/src/main/java/com/vibesync/nearby/VibeSyncNearbyPackage.kt` |
| iOS native | `apps/mobile/ios/VibeSync/VibeSyncNearby.swift` |
| iOS bridge | `apps/mobile/ios/VibeSync/VibeSyncNearby.m` |
| Permissions | `AndroidManifest.xml`, `Info.plist` |
