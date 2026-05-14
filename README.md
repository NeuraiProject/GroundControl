# Ground Control (Neurai)

Push notifications server for **NeuraiWallet**. Watches the Neurai blockchain (blocks & mempool) for transactions paying any subscribed on-chain address and dispatches FCM (Android) / APNs (iOS) push notifications.

Forked from [BlueWallet/GroundControl](https://github.com/BlueWallet/GroundControl). Lightning support, Bitcoin RPC integration and BlueWallet-specific defaults have been removed; the chain-watcher is now wired to a Neurai full node.

Built with TypeScript, Express, MariaDB and an OpenAPI spec (`openapi.yaml`).

> In memory of David Bowie.

## Architecture

Four processes that share a MariaDB instance:

- `web` — HTTP API (`/majorTomToGroundControl`, `/unsubscribe`, `/setTokenConfiguration`, …).
- `worker-blockprocessor` — polls the Neurai node for new blocks, scans tx outputs, enqueues pushes for subscribed addresses/txids.
- `worker-processmempool` — same logic against unconfirmed transactions.
- `worker-sender` — pulls from the queue and dispatches via FCM/APNs.

## Installation

```shell
npm i
npm start                              # HTTP API
npm run worker-blockprocessor          # block scanner
npm run worker-processmempool          # mempool scanner
npm run worker-sender                  # FCM/APNs dispatcher
```

Or via Docker Compose (recommended for local + production):

```shell
cp .env.example .env                   # fill in the credentials
docker compose up --build
```

## Environment variables

Copy `.env.example` and fill in the real values.

- `JAWSDB_MARIA_URL` — MariaDB connection URL, e.g. `mysql://user:pass@host:3306/groundcontrol`.
- `NEURAI_RPC` — Neurai full-node RPC URL, e.g. `http://user:pass@127.0.0.1:9817`.
- `APNS_P8` — hex-encoded contents of the APNs `.p8` key file from Apple Developer.
- `APNS_P8_KID` — "Key ID" of that `.p8`.
- `APPLE_TEAM_ID` — Team ID of the Apple developer account.
- `APNS_TOPIC` — iOS bundle ID, currently `io.bluewallet.bluewallet` (the Xcode target is still named BlueWallet inside the wallet repo; update when that gets renamed).
- `GOOGLE_KEY_FILE` — hex-encoded Firebase service-account JSON key.
- `GOOGLE_PROJECT_ID` — Firebase project id paired with the key file.
- `VERBOSE` — non-empty for verbose logging.

## Getting certificates

- APNs `.p8` (Apple Developer → Keys → "Push Notifications"). Encode to hex: `xxd -p file.p8 | tr -d '\n'`.
- Firebase service-account JSON (Firebase console → Project Settings → Service Accounts). Encode to hex the same way.
- See [Firebase: migrate to HTTP v1](https://firebase.google.com/docs/cloud-messaging/migrate-v1) for context.

## OpenAPI

Swagger UI: [editor.swagger.io with this spec](https://editor.swagger.io/) — paste `openapi.yaml`.

Regenerate the TypeScript types after editing the spec:

```shell
npm run openapi
```

## License

MIT
