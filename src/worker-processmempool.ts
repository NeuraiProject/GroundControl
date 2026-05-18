import "reflect-metadata";
import { Subscriber } from "zeromq";
import { Repository } from "typeorm";
import { TokenToAddress } from "./entity/TokenToAddress";
import { SendQueue } from "./entity/SendQueue";
import dataSource from "./data-source";
import { components } from "./openapi/api";
import { buildNeuraiRpcClient } from "./neurai-rpc-client";
require("dotenv").config();

const NEURAI_RPC = process.env.NEURAI_RPC;
if (!NEURAI_RPC) {
  console.error("NEURAI_RPC env variable is not set");
  process.exit();
}

const NEURAI_ZMQ = process.env.NEURAI_ZMQ;
if (!NEURAI_ZMQ) {
  console.error("NEURAI_ZMQ env variable is not set");
  process.exit();
}

const CHAIN = process.env.CHAIN;
if (CHAIN !== "mainnet" && CHAIN !== "testnet") {
  console.error("CHAIN env variable must be 'mainnet' or 'testnet'");
  process.exit();
}

const client = buildNeuraiRpcClient(NEURAI_RPC);

// Dedup cache: a tx hits us via `hashtx` (unconfirmed) and then again via
// the block worker once confirmed; only the unconfirmed notification path
// is the mempool worker's job, so we squelch repeats here.
const processedTxids: Record<string, number> = {};
const TXID_CACHE_TTL_MS = 30 * 60 * 1000;

// ZMQ has no heartbeat; periodically sweep the mempool in case some
// notifications dropped silently.
const SAFETY_POLL_MS = 5 * 60 * 1000;

process
  .on("unhandledRejection", (reason, p) => {
    console.error(reason, "Unhandled Rejection at Promise", p);
    process.exit(1);
  })
  .on("uncaughtException", (err) => {
    console.error(err, "Uncaught Exception thrown");
    process.exit(1);
  });

let sendQueueRepository: Repository<SendQueue>;

async function processTx(txid: string) {
  if (processedTxids[txid]) return;
  processedTxids[txid] = Date.now();

  let txData: any;
  try {
    const response = await client.request("getrawtransaction", [txid, true]);
    txData = response.result;
  } catch (e: any) {
    process.env.VERBOSE && console.warn(`[${CHAIN}] getrawtransaction ${txid} failed:`, e?.message);
    return;
  }
  if (!txData || !txData.vout) return;

  const addresses: string[] = [];
  const allPotentialPushPayloadsArray: components["schemas"]["PushNotificationOnchainAddressGotUnconfirmedTransaction"][] = [];
  for (const output of txData.vout) {
    if (output.scriptPubKey && (output.scriptPubKey.addresses || output.scriptPubKey.address)) {
      for (const address of output.scriptPubKey?.addresses ?? (output.scriptPubKey?.address ? [output.scriptPubKey?.address] : [])) {
        addresses.push(address);
        allPotentialPushPayloadsArray.push({
          address,
          txid: txData.txid,
          sat: Math.floor(output.value * 100000000),
          type: 3,
          level: "transactions",
          token: "",
          os: "ios",
        });
      }
    }
  }
  if (addresses.length === 0) return;

  const query = dataSource.getRepository(TokenToAddress).createQueryBuilder().where("address IN (:...address)", { address: addresses }).andWhere("chain = :chain", { chain: CHAIN });
  for (const t2a of await query.getMany()) {
    for (let payload of allPotentialPushPayloadsArray) {
      if (t2a.address === payload.address) {
        process.env.VERBOSE && console.log(`[${CHAIN}] enqueueing`, payload);
        payload.os = t2a.os === "android" ? "android" : "ios";
        payload.token = t2a.token;
        payload.type = 3;
        payload.level = "transactions";
        payload.badge = 1;
        await sendQueueRepository.save({ data: JSON.stringify(payload) });
      }
    }
  }
}

function gcCache() {
  const cutoff = Date.now() - TXID_CACHE_TTL_MS;
  for (const txid of Object.keys(processedTxids)) {
    if (processedTxids[txid] < cutoff) delete processedTxids[txid];
  }
}

async function safetySweep() {
  try {
    const response = await client.request("getrawmempool", []);
    for (const txid of response.result) {
      if (!processedTxids[txid]) await processTx(txid);
    }
  } catch (e: any) {
    console.warn(`[${CHAIN}] safety sweep error:`, e?.message);
  }
  gcCache();
}

dataSource
  .initialize()
  .then(async () => {
    console.log("db connected");
    console.log(`running groundcontrol worker-processmempool on chain ${CHAIN} via ZMQ ${NEURAI_ZMQ}`);

    sendQueueRepository = dataSource.getRepository(SendQueue);

    // Initial sweep to backfill anything already in the mempool when we
    // start, then a periodic safety net.
    await safetySweep();
    setInterval(() => {
      safetySweep();
    }, SAFETY_POLL_MS);

    const sock = new Subscriber();
    sock.connect(NEURAI_ZMQ);
    sock.subscribe("hashtx");

    for await (const [topicBuf, bodyBuf] of sock) {
      const txid = bodyBuf.toString("hex");
      process.env.VERBOSE && console.log(`[${CHAIN}] zmq`, topicBuf.toString(), txid);
      try {
        await processTx(txid);
      } catch (e) {
        console.warn(`[${CHAIN}] processTx error:`, e);
      }
    }
  })
  .catch((error) => {
    console.error(`[${CHAIN}] exception in mempool processor:`, error, "comitting suicide");
    process.exit(1);
  });
