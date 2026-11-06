# Known limitations

This document lists what has not been verified, what is intentionally out of scope, and where platform behavior limits the product. It is part of the deliverable: do not describe an item below as tested or guaranteed.

## Validation status

- **No native build was produced in this environment.** The development host is Windows with JDK 27 and no Android SDK/`ANDROID_HOME`; React Native 0.81's Android build expects JDK 17, and an iOS build requires macOS/Xcode.
- **No physical-device testing was performed.** BLE advertising/scanning, GATT fallback, local HTTP streaming, local-network permission prompts, WebRTC audio, TURN traversal, background behavior, and native document import are implemented but unverified on hardware.
- Automated coverage consists of 10 backend integration tests and 8 mobile clock/playback-sync tests. There are no native unit tests, Detox/Maestro E2E tests, or screenshots tests.
- The Kotlin and Swift nearby modules were reviewed for syntax and API use but not compiled. Treat them as requiring a first native build and device validation.

## Nearby / offline mode

- **No Wi-Fi Direct implementation.** Android's `WifiP2pManager` is not used, despite the device capability field supporting a `wifiDirect` flag. Nearby transport is BLE discovery + HTTP over shared Wi-Fi, an existing hotspot, Ethernet, or USB tethering.
- **No Apple MultipeerConnectivity.** It is Apple-only and was not used; the common BLE + HTTP path works on both platforms.
- **iOS cannot create a hotspot programmatically.** One device must join an existing Wi-Fi network, or join an Android-created hotspot. The app does not turn on a hotspot through system settings.
- **Android hotspot creation is manual.** The app can use an existing hotspot interface but does not enable the hotspot through system UI.
- **iOS BLE peripheral advertising is constrained.** It may stop when the app is backgrounded or the screen locks. The host screen should remain open. iOS cannot advertise arbitrary service data, so discovery falls back to a GATT read.
- **Android BLE advertising/scanning is subject to OS background limits and vendor battery policies.** Doze, background restrictions, and some OEM skins can stop discovery.
- **Nearby rooms are ephemeral.** There is no database, account session, cloud backup, or resume after the host stops the server. The host's local file is deleted when the session is cleaned up.
- **Nearby lacks online-only features.** There is no microphone/voice room, private host DM, join approval queue, participant ban, media queue, or host dashboard in nearby mode. It supports local media, synchronized playback, room chat, a member list, and leave.
- **Plain HTTP on the LAN.** Session/media requests use an `X-VibeSync-Token`, but traffic is not TLS-protected. Do not treat nearby mode as safe on hostile public Wi-Fi.
- **4-character nearby codes.** The BLE payload reserves four bytes for the code. Online room codes may be longer; only nearby sessions use canonical 4-character codes.
- **Same-network requirement.** A guest on cellular data cannot reach a nearby host. VPNs, client isolation, and guest Wi-Fi isolation can block local HTTP even when both devices appear to share a network.

## Voice

- **Mesh only.** The mobile `VoiceEngine` is a full-mesh audio implementation. The API exposes an optional LiveKit token endpoint, but the mobile client has no LiveKit SDK integration. Selecting LiveKit on the client is not implemented.
- **Small rooms.** The API reports `meshRecommendedMax: 6`. Larger rooms need an SFU; mesh bandwidth and CPU grow with each speaker.
- **TURN is required in many mobile networks.** STUN-only calls fail behind symmetric NAT/carrier-grade NAT. Configure `TURN_URL` and `TURN_SECRET` (or static credentials) for reliable calls.
- **Approved speakers only.** Listeners cannot publish audio by design. The host can mute all and revoke a speaker.
- **No video calling, screen sharing, recording, transcription, or noise suppression beyond WebRTC's browser-level audio processing.**
- **No live device validation** of microphone permission prompts, audio routing (speaker/Bluetooth/headset), or echo behavior.

## Media and playback

- **Synchronization is best-effort, not frame-accurate.** It converges to a server-timestamped position using clock estimates, seeks over 850 ms drift, and rate nudges over 120 ms. Network jitter, decoder buffering, Bluetooth output latency, and device performance can still cause audible/visible offset.
- **No manual video quality selector.** Adaptive HLS/DASH quality is delegated to `react-native-video` and the platform player. Only server-reported clock quality is shown.
- **No transcoding.** Playback depends on platform codec support and the original file/stream. Unsupported codecs/containers fail in the native player.
- **Uploaded media is local disk storage.** Multi-instance deployments need a shared volume or object storage; no S3/GCS driver is included.
- **No automatic media metadata extraction.** The app sends title and optional duration; duration may be zero for external streams until the player reports it.
- **Background playback is disabled** for the synchronized player (`playInBackground={false}`). There are no lock-screen controls or background audio session configuration.
- **No DRM bypass.** Widevine/PlayReady/ClearKey/FairPlay metadata is passed through only when the provider supplies a license server. DRM-protected content must use a legitimate service and platform support. FairPlay typically also needs a certificate and content ID, which the current media model does not store; only `licenseServer` is passed.
- **No guarantee of HDCP or output protection.** That is determined by the platform DRM stack and content license, not VibeSync.
- **Fullscreen** uses the native player's `presentFullscreenPlayer()`; custom in-app fullscreen layouts, PiP, and manual subtitle/quality controls are not implemented.
- **You are responsible for media rights and third-party terms.**

## Accounts, security, and notifications

- **No email verification, password reset, MFA, or social/OAuth login.** Password change is available from Settings; account recovery is out of scope.
- **No push notifications.** Notifications are in-app and database-backed. There is no APNs/FCM integration.
- **No end-to-end encryption.** HTTPS protects transport in production, but the server can read message content and media metadata. Nearby traffic is plain HTTP on the LAN.
- **No content moderation service or admin console.** Hosts can moderate their own rooms; there is no platform-wide moderation/reporting workflow.
- **Rate limiting is in-process unless Redis is configured.** Multiple API instances without Redis will not share limits or presence correctly.
- **Secure storage depends on the OS keychain/keystore.** Tokens are not stored in AsyncStorage, but rooted/jailbroken devices and compromised OS credentials remain outside the app's control.
- **The `GET /api/auth/sessions` endpoint returns only the current user summary.** It is not a full session-management list.

## Deployment and clients

- **No iOS/Android release signing is configured.** Android release builds are unsigned unless the documented Gradle properties are supplied. Xcode signing must be configured on macOS.
- **Android App Links / iOS Universal Links are incomplete.** The Android manifest declares `autoVerify` for `vibesync.app`, but no `assetlinks.json` is served, and no iOS associated-domains entitlement/apple-app-site-association file is included. The custom `vibesync://` scheme and the landing-page deep link work; verified HTTPS app links require deployment-specific files and an Apple Team ID.
- **No app icons, splash artwork, store listings, privacy manifests beyond the template, or store submission automation** are included as final branded assets. The React Native template assets are still in place.
- **No web client.** The API serves a branded invite landing page only; it is not a full browser player.
- **No S3/CDN integration, backup automation, metrics, tracing, or alerting.** Logging is Pino JSON and health is `/api/health`. Production monitoring must be added by the operator.
- **No database migration framework.** Mongoose models are used directly. Schema changes need a planned migration path before production upgrades.
- **No CI/CD pipeline is committed.** Run the documented tests/lint and native builds in your own CI.
- **Single locale.** The UI is English only; date/number formatting depends on the device locale in a few places.
- **Accessibility was implemented with labels/roles but not audited** against VoiceOver/TalkBack or WCAG.

## Third-party services

- Mongo, Redis, coturn, LiveKit, and any DRM/license provider are external dependencies with their own licenses, pricing, and terms. See [THIRD_PARTY.md](THIRD_PARTY.md). The repository does not include credentials or service accounts for them.
- The optional LiveKit endpoint is backend-only in this version. Do not advertise an SFU voice mode in the app until a LiveKit client SDK is integrated and tested.
