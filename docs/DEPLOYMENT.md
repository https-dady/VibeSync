# Production deployment

This guide deploys the API and MongoDB/Redis with Docker Compose, terminates TLS at a reverse proxy, and configures TURN and the mobile release builds. It assumes a Linux host (or any Docker host) with a DNS record such as `api.vibesync.app`.

The mobile app and the API are independent services: the app needs an HTTPS API origin, and the API needs persistent MongoDB and upload storage. Mongo, Redis, and TURN are not installed by the app.

## 1. Production checklist

- [ ] DNS points `api.vibesync.app` at the server.
- [ ] `services/api/.env` has new JWT secrets, explicit CORS origins, and HTTPS public URLs.
- [ ] MongoDB is not exposed publicly.
- [ ] The uploads volume is persistent and backed up.
- [ ] Redis is configured for multi-instance or restart durability.
- [ ] TURN is configured, reachable, and tested.
- [ ] Reverse proxy forwards WebSockets and supports large uploads.
- [ ] The mobile release has an HTTPS API URL and a real signing key.
- [ ] The invite landing origin serves app-link verification files.

## 2. Configure the API

```bash
cp services/api/.env.example services/api/.env
chmod 600 services/api/.env
```

Minimum production values:

```dotenv
NODE_ENV=production
PORT=4000
API_PUBLIC_URL=https://api.vibesync.app
PUBLIC_WEB_URL=https://vibesync.app
MONGODB_URI=mongodb://mongo:27017/vibesync
REDIS_URL=redis://redis:6379
JWT_ACCESS_SECRET=<openssl rand -hex 32>
JWT_REFRESH_SECRET=<openssl rand -hex 32>
CORS_ORIGINS=https://vibesync.app
TRUST_PROXY=true
MEDIA_STORAGE_DIR=/app/storage/uploads
MAX_UPLOAD_MB=500
STUN_URLS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
TURN_URL=turn:turn.vibesync.app:3478?transport=udp,turn:turn.vibesync.app:3478?transport=tcp
TURN_SECRET=<same secret as coturn static-auth-secret>
TURN_TTL_SECONDS=3600
```

Do not use `CORS_ORIGINS=*` in production. Native clients send no Origin header and continue to work with an explicit list.

`NODE_ENV=production` makes the API refuse the example JWT secrets. It also makes Redis connection failure fatal, unlike development.

## 3. Start the stack

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f api
```

The Compose file:

- Builds `services/api/Dockerfile` with production dependencies.
- Runs the API as the non-root `node` user.
- Waits for MongoDB and Redis health checks.
- Mounts MongoDB data, Redis data, and `/app/storage/uploads` as named volumes.
- Exposes port 4000 only; put a TLS proxy in front.

Health check:

```bash
curl -fsS https://api.vibesync.app/api/health
```

Expected: `database: connected`, `redis: connected`, and `status: ok`.

## 4. TLS reverse proxy

### Caddy on the host

Copy `deploy/Caddyfile.example` to `/etc/caddy/Caddyfile`, set:

```bash
export VIBESYNC_DOMAIN=api.vibesync.app
export VIBESYNC_UPSTREAM=127.0.0.1:4000
```

Then reload Caddy. Caddy obtains and renews certificates automatically.

### Caddy in Docker

Add a Caddy service to the same Compose network:

```yaml
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - '80:80'
      - '443:443'
    volumes:
      - ./deploy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    environment:
      VIBESYNC_DOMAIN: api.vibesync.app
      VIBESYNC_UPSTREAM: api:4000
    depends_on:
      - api

volumes:
  caddy-data:
  caddy-config:
```

Add the volumes to the top-level `volumes` block and use the `Caddyfile.example` contents.

### Nginx

Use `deploy/nginx.conf.example`. It includes WebSocket upgrade headers, a 500 MB body limit, and streaming request uploads. Set `TRUST_PROXY=true` so rate limits and logs see the real client IP. Reload Nginx after validating with `nginx -t`.

## 5. MongoDB and Redis

- Use MongoDB 8 (the integration tests use 8.0.14). Atlas or a managed MongoDB is fine; set `MONGODB_URI` accordingly.
- Keep MongoDB on a private network. Add authentication for anything beyond a single trusted host.
- Redis is optional for one instance but required for multiple API replicas: Socket.IO uses the Redis adapter, and presence/rate-limit state becomes shared.
- Enable Redis persistence (`appendonly yes` is in the included Compose command) and monitor memory.
- With multiple API instances, all replicas need the same `JWT_*` secrets and `REDIS_URL`.

## 6. Uploads and media storage

Uploaded files live under `MEDIA_STORAGE_DIR`. The Compose stack mounts the `uploads` volume. Back it up together with MongoDB, otherwise media records will point to missing files.

For multiple API instances, either:

- Mount the same shared filesystem on every replica, or
- Replace local disk storage with an object-storage driver. No S3 driver is implemented in this version; this would be a code change.

Range streaming is served by the API and requires authentication. Do not put uploaded media behind a public static directory; that would bypass membership checks.

## 7. TURN (required for reliable voice)

Install coturn on a public host:

```bash
sudo apt install coturn
sudo cp deploy/turnserver.conf.example /etc/coturn/turnserver.conf
sudo editor /etc/coturn/turnserver.conf
```

Set `static-auth-secret` to the same value as `services/api/.env`'s `TURN_SECRET`, set `external-ip` to the public address, and open:

- TCP/UDP 3478
- TCP/UDP 5349 if TURN over TLS is configured
- UDP relay range 49160–49200 (or whatever range you choose)

The API computes HMAC-SHA1 ephemeral credentials from `TURN_SECRET`; no static TURN password is stored in the app. Set `TURN_URL` to the addresses clients should use:

```dotenv
TURN_URL=turn:turn.vibesync.app:3478?transport=udp,turn:turn.vibesync.app:3478?transport=tcp
```

Verify with a WebRTC test page or `turnutils_uclient` from a mobile network before launch.

## 8. Optional LiveKit

Set `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` to enable `GET /api/rtc/config` LiveKit metadata and `POST /api/rtc/livekit-token`.

Important: the current mobile client uses the WebRTC mesh. The token endpoint is backend integration only until a LiveKit client SDK is added to the app. Do not describe the mobile voice path as SFU/LiveKit in production notes.

## 9. Android release

```bash
cd apps/mobile
cp .env.example .env
# edit VIBESYNC_API_URL=https://api.vibesync.app and VIBESYNC_WEB_URL=https://vibesync.app
npm run configure
```

Create an upload keystore (once):

```bash
keytool -genkeypair -v \
  -storetype PKCS12 \
  -keystore vibesync-upload.keystore \
  -alias vibesync \
  -keyalg RSA -keysize 2048 -validity 10000
```

Add the signing properties to `~/.gradle/gradle.properties`:

```properties
VIBESYNC_UPLOAD_STORE_FILE=/absolute/path/to/vibesync-upload.keystore
VIBESYNC_UPLOAD_STORE_PASSWORD=...
VIBESYNC_UPLOAD_KEY_ALIAS=vibesync
VIBESYNC_UPLOAD_KEY_PASSWORD=...
```

Build:

```bash
cd android
./gradlew assembleRelease
# or ./gradlew bundleRelease for Play Store AAB
```

Outputs are under `apps/mobile/android/app/build/outputs/`. Without the signing properties, the release artifact is unsigned by design.

App Links: host `deploy/assetlinks.json.example` at `https://vibesync.app/.well-known/assetlinks.json`, replacing the SHA-256 fingerprint with the upload certificate's fingerprint. The manifest already declares `https://vibesync.app/r/`. The custom `vibesync://` scheme works without this file.

## 10. iOS release

On macOS:

```bash
cd apps/mobile
cp .env.example .env
# edit the API/web URLs
npm run configure
cd ios
bundle install
bundle exec pod install
```

Open `VibeSync.xcworkspace` in Xcode, select the VibeSync target, set the signing team and bundle identifier, then Product → Archive.

- `Info.plist` already contains the Bluetooth, local-network, microphone, and custom URL-scheme entries.
- For Universal Links, add the Associated Domains capability (`applinks:vibesync.app`) and host `deploy/apple-app-site-association.example` at `https://vibesync.app/.well-known/apple-app-site-association` without the `.json` extension. Replace the Team ID. This requires an Apple Developer account.
- Confirm the deployment target is iOS 15.1 or the current project setting, and test Bluetooth/local-network prompts on a physical device.

## 11. Operations

### Backups

```bash
docker compose exec -T mongo mongodump --archive=/tmp/vibesync.gz --gzip
docker compose cp mongo:/tmp/vibesync.gz ./backups/vibesync-$(date +%F).gz
docker run --rm -v vibesync_uploads:/data -v "$PWD/backups:/backup" alpine \
  tar czf /backup/uploads-$(date +%F).tar.gz -C /data .
```

Back up MongoDB and uploads on the same schedule. Test restores, not just backups.

### Rolling updates

```bash
docker compose pull
docker compose up -d --build
docker compose logs --tail=100 api
curl -fsS https://api.vibesync.app/api/health
```

The API handles SIGTERM with a 15-second graceful shutdown. Compose's `init: true` forwards signals correctly.

### Scaling

- Run multiple API replicas behind the proxy with a shared `REDIS_URL`.
- Use a shared upload volume or add object storage before scaling media beyond one host.
- Socket.IO's Redis adapter handles room fan-out; no sticky sessions are required for WebSocket transport, but keeping proxy timeouts generous is still recommended.
- MongoDB should be a replica set for production durability.

### Monitoring

The API exposes `/api/health` and structured Pino logs with request IDs. Add log shipping, uptime checks, disk-space alerts, MongoDB metrics, and Redis metrics at the platform level. No Prometheus/OpenTelemetry exporter is included.

## 12. Rollback

Keep the previous image tag and database backup before deploying. To roll back:

```bash
docker compose down
docker compose up -d <previous-image-or-compose-revision>
```

If a release changed the database schema, restore the matching backup or run the reverse migration. This repository does not include a migration framework, so schema changes must be planned explicitly.
