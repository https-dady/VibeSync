# VibeSync API

Express 5, MongoDB, Socket.IO, optional Redis. This service is independent of every other project in the workspace.

## Run

```bash
cp .env.example .env
# set JWT secrets and MongoDB URL
npm install
npm run dev
```

Health: `GET http://localhost:4000/api/health`.

## Test

```bash
npx jest --runInBand --detectOpenHandles tests/integration.test.js
```

The integration suite starts a real HTTP/Socket.IO server against MongoDB Memory Server 8.0.14 and covers auth, rooms, approvals, media upload/Range streaming, chat, playback, and voice signaling/permissions.

`Mongoose` is pinned to 8.x. Do not upgrade to 9 without resolving the Jest driver handshake failure documented in the root development guide.

## Documentation

- Root [README](../README.md)
- [API and realtime reference](../docs/API.md)
- [Development guide](../docs/DEVELOPMENT.md)
- [Deployment](../docs/DEPLOYMENT.md)
- [Limitations](../docs/LIMITATIONS.md)
