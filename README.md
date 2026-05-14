# Ground Control (Neurai)

Push notifications server for **NeuraiWallet**. Watches the Neurai blockchain (blocks & mempool) for transactions paying any subscribed on-chain address and dispatches FCM (Android) / APNs (iOS) push notifications.

Forked from [BlueWallet/GroundControl](https://github.com/BlueWallet/GroundControl). Lightning support, Bitcoin RPC integration and BlueWallet-specific defaults have been removed; the chain-watcher is now wired to a Neurai full node.

Built with TypeScript, Express, MariaDB and an OpenAPI spec (`openapi.yaml`).

> In memory of David Bowie.

## Architecture

A single instance watches **both mainnet and testnet** in parallel. Subscriptions are tagged by `chain` in the DB, so a mainnet address and a testnet address that happen to share the same string never cross. Processes:

- `web` — HTTP API (`/majorTomToGroundControl`, `/unsubscribe`, `/setTokenConfiguration`, …). The `chain` field is required on every subscribe/unsubscribe.
- `worker-blockprocessor-mainnet` / `worker-blockprocessor-testnet` — one per chain. Polls the Neurai RPC for new blocks and enqueues pushes for chain-matching subscriptions.
- `worker-processmempool-mainnet` / `worker-processmempool-testnet` — same for unconfirmed transactions.
- `worker-sender` — chain-agnostic. Pulls from the shared `SendQueue` and dispatches via FCM/APNs.

To run only one chain, comment out the corresponding pair of workers in `docker-compose.yml`.

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
- `NEURAI_RPC_MAINNET` and `NEURAI_RPC_TESTNET` — Neurai JSON-RPC URLs, one per chain. Either the public anonymous endpoints shipped with the wallet:

  - mainnet: `https://rpc-main.neurai.org/rpc`
  - testnet: `https://rpc-testnet.neurai.org/rpc`

  …or your own self-hosted nodes (`http://user:pass@host:port`). The block/mempool workers read `NEURAI_RPC` per container; `docker-compose.yml` wires each to its chain.

  **Note on rate limits:** the workers hit the RPC continuously (every new block + every ~9 s for the mempool, plus one `getrawtransaction` per new mempool tx). For high-traffic deployments on mainnet, coordinate with whoever runs the public endpoint or self-host the node.

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
