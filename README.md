# Ground Control (Neurai)

Push notifications server for **NeuraiWallet**. Watches the Neurai blockchain (blocks & mempool) for transactions paying any subscribed on-chain address and dispatches FCM (Android) / APNs (iOS) push notifications.

Forked from [BlueWallet/GroundControl](https://github.com/BlueWallet/GroundControl). Lightning support, Bitcoin RPC integration and BlueWallet-specific defaults have been removed; the chain-watcher is now wired to a Neurai full node.

Built with TypeScript, Express, MariaDB and an OpenAPI spec (`openapi.yaml`).

> In memory of David Bowie.

## Architecture

A single instance watches **both mainnet and testnet** in parallel. Subscriptions are tagged by `chain` in the DB, so a mainnet address and a testnet address that happen to share the same string never cross. Processes:

- `web` — HTTP API (`/majorTomToGroundControl`, `/unsubscribe`, `/setTokenConfiguration`, …). The `chain` field is required on every subscribe/unsubscribe. `/setTokenConfiguration` (called by the wallet on every start) and `/ping` return an `instance_id`, a random id of the database: when it changes, e.g. after the database was wiped, the wallet sends all its addresses again.
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

### Nginx on the Docker host

Both Compose files publish the HTTP API as `127.0.0.1:3111:3001`: host port `3111` forwards to container port `3001` and is bound only to the host's loopback address. Configure Nginx on that host to proxy the public HTTPS domain to it:

```nginx
location / {
    proxy_pass http://127.0.0.1:3111;
    proxy_set_header Host $host;
}
```

Set the wallet's notification server URL to the public HTTPS domain. After changing the port mapping, recreate the web service with `docker compose up -d web` (or `docker compose -f docker/docker-compose.yml up -d web` for the bundled-node stack).

If Nginx runs in another container, connect it to the same Docker network and use `http://web:3001` as the upstream instead; `127.0.0.1` inside that container refers to Nginx itself.

## Neurai nodes (`docker/`)

`docker/docker-compose.yml` runs the full stack, including one Neurai node per chain (RPC and ZMQ stay inside the compose network):

| Chain   | Node                                                                                           | RPC   | ZMQ   |
| ------- | ---------------------------------------------------------------------------------------------- | ----- | ----- |
| mainnet | `neuraiproject/neurai-node:v1.0.7` + `node-mainnet/neurai.conf`                                | 19001 | 28332 |
| testnet | Neurai 2.0.0, `DePIN-Test` commit `7f1773e538c210212441bd723eb8ea3ba99a00ef` (`node-testnet/`) | 19101 | 28332 |

Run the following commands from the repository root to update the bundled nodes. If you ran a testnet node before 2026-11-05, read the testnet reset notes below first:

```shell
docker compose -f docker/docker-compose.yml pull neurai-mainnet
docker compose -f docker/docker-compose.yml build neurai-testnet
docker compose -f docker/docker-compose.yml up -d --build
```

Testnet is pinned to a reviewed upstream commit: update `NEURAI_REF` in `docker/node-testnet/Dockerfile` when adopting new consensus changes. This also invalidates the cached source checkout. To try another revision without editing the default, use `docker compose -f docker/docker-compose.yml build --build-arg NEURAI_REF=<commit-or-tag> neurai-testnet`. A moving branch requires `--no-cache` to fetch its latest code.

### Node indexes

Both nodes keep `txindex`, `assetindex`, `addressindex`, `timestampindex` and `spentindex` enabled. Mainnet 1.0.7 does not support `pubkeyindex`, `silentpaymentindex` or `channelmessageindex`.

Testnet also enables:

- `pubkeyindex=1` — revealed public keys for `getpubkey` and DePIN clients.
- `silentpaymentindex=1` — NIP-047 tweaks and witness v3 outputs for light clients.
- `channelmessageindex=1` — NIP-048 asset channel messages, independent of the node wallet.
- `prune=0` — retain the block and undo data needed to build these indexes.

The silent-payment and channel-message indexes catch up at startup on an unpruned node. They make the corresponding RPC/REST queries available; GroundControl's workers still notify subscriptions by transaction output address and do not scan silent-payment tweaks or send channel-message notifications. See the [upstream index and upgrade notes](https://github.com/NeuraiProject/Neurai/blob/7f1773e538c210212441bd723eb8ea3ba99a00ef/doc/release-notes.md#indexes-and-rest).

### Testnet reset of 2026-11-05

The testnet restarted from a new genesis block (`000000c710413a4265a996d30c86043aedef6a563900f1bc43fea61d5b2dc77d`) and requires protocol 70031, so nodes built from earlier commits are refused by its peers. The node also refuses to start on the data directory of the previous testnet (wrong genesis block), so the compose file now mounts a new volume, `neurai_testnet_20261105_data`, and the testnet node syncs the new chain from scratch. See the [upstream testnet reset notes](https://github.com/NeuraiProject/Neurai/blob/7f1773e538c210212441bd723eb8ea3ba99a00ef/doc/release-notes.md#testnet-reset).

```shell
docker compose -f docker/docker-compose.yml build neurai-testnet
docker compose -f docker/docker-compose.yml up -d neurai-testnet worker-blockprocessor-testnet worker-processmempool-testnet
```

The testnet block worker notices the new genesis hash and starts from the new tip; it does not wait for the old block height. MariaDB keeps the subscriptions: testnet addresses keep their format, and transaction subscriptions of the previous chain simply never confirm. Once the new node is synced, the previous chain's volume can be removed with `docker volume rm groundcontrol-neurai_neurai_testnet_data`.

### Upgrading from the 1.0.5 / pre-reset testnet stack

- The 1.0.6 image keeps its datadir in `/data` (not `/data/node`) and runs `neuraid` as an unprivileged user, and the DePIN testnet was relaunched with a new genesis block. Both nodes therefore start on fresh volumes (`neurai_mainnet_data`, `neurai_testnet_data`) and resync from scratch. Once the new nodes are synced, the old `groundcontrol-neurai_mainnet_data` and `groundcontrol-neurai_testnet_data` volumes can be removed with `docker volume rm`.
- The block workers wait while their node is syncing, and record each chain's genesis hash: when it changes (testnet reset) they restart from the new tip instead of waiting for the old block height.
- The extra testnet indexes are described above.

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
