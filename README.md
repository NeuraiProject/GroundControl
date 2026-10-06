# Ground Control (Neurai)

Push notifications server for **NeuraiWallet**. Watches the Neurai blockchain (blocks & mempool) for transactions paying any subscribed on-chain address and dispatches FCM (Android) / APNs (iOS) push notifications.

Forked from [BlueWallet/GroundControl](https://github.com/BlueWallet/GroundControl). Lightning support, Bitcoin RPC integration and BlueWallet-specific defaults have been removed; the chain-watcher is now wired to a Neurai full node.

Built with TypeScript, Express, MariaDB and an OpenAPI spec (`openapi.yaml`).

> In memory of David Bowie.

## Architecture

A single instance watches **both mainnet and testnet** in parallel. Subscriptions are tagged by `chain` in the DB, so a mainnet address and a testnet address that happen to share the same string never cross. Processes:

- `web` — HTTP API (`/majorTomToGroundControl`, `/unsubscribe`, `/setTokenConfiguration`, …). The `chain` field is required on every subscribe/unsubscribe.
- `worker-blockprocessor-mainnet` / `worker-blockprocessor-testnet` — one per chain. Learns about new blocks from the node's ZMQ `hashblock` feed (or by polling the RPC every 10 s when `NEURAI_ZMQ` is unset) and enqueues pushes for chain-matching subscriptions: one per device and transaction, with the XNA and assets it received summed up.
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

## Neurai nodes (`docker/`)

`docker/docker-compose.yml` runs the full stack, including one Neurai node per chain (RPC and ZMQ stay inside the compose network):

| Chain   | Node                                                              | RPC   | ZMQ   |
| ------- | ----------------------------------------------------------------- | ----- | ----- |
| mainnet | `neuraiproject/neurai-node:v1.0.6` + `node-mainnet/neurai.conf`   | 19001 | 28332 |
| testnet | Neurai 2.0.0 built from the `DePIN-Test` branch (`node-testnet/`) | 19101 | 28332 |

The testnet image clones the branch at build time; rebuild it with `docker compose build --no-cache neurai-testnet` to pick up new consensus changes.

### Upgrading from the 1.0.5 / pre-reset testnet stack

- The 1.0.6 image keeps its datadir in `/data` (not `/data/node`) and runs `neuraid` as an unprivileged user, and the DePIN testnet was relaunched with a new genesis block. Both nodes therefore start on fresh volumes (`neurai_mainnet_data`, `neurai_testnet_data`) and resync from scratch. Once the new nodes are synced, the old `groundcontrol-neurai_mainnet_data` and `groundcontrol-neurai_testnet_data` volumes can be removed with `docker volume rm`.
- The block workers wait while their node is syncing, and record each chain's genesis hash: when it changes (testnet reset) they restart from the new tip instead of waiting for the old block height.
- `pubkeyindex` is only available on the DePIN testnet node; the 1.0.x mainnet release does not support it.

## Environment variables

Copy `.env.example` and fill in the real values.

- `JAWSDB_MARIA_URL` — MariaDB connection URL, e.g. `mysql://user:pass@host:3306/groundcontrol`.
- `NEURAI_RPC_MAINNET` and `NEURAI_RPC_TESTNET` — Neurai JSON-RPC URLs, one per chain. Either the public anonymous endpoints shipped with the wallet:

  - mainnet: `https://rpc-main.neurai.org/rpc`
  - testnet: `https://rpc-testnet.neurai.org/rpc`

  …or your own self-hosted nodes (`http://user:pass@host:port`). The block/mempool workers read `NEURAI_RPC` per container; `docker-compose.yml` wires each to its chain.

  **Note on rate limits:** without ZMQ the workers poll the RPC continuously (every 10 s for blocks, every ~9 s for the mempool, plus one `getrawtransaction` per new mempool tx). For high-traffic deployments on mainnet, coordinate with whoever runs the public endpoint or self-host the node.

- `NEURAI_ZMQ` — optional, per worker container: the node's ZMQ endpoint (`tcp://host:28332`, publishing `hashblock` and `hashtx`). When set, the workers react to ZMQ notifications and only poll every 5 min as a safety net. The public endpoints don't expose ZMQ, so leave it unset there; `docker/docker-compose.yml` sets it for its bundled nodes.

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
