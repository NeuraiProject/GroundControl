import "reflect-metadata";
import { Subscriber } from "zeromq";
import { Repository } from "typeorm";
import { TokenToAddress } from "./entity/TokenToAddress";
import { SendQueue } from "./entity/SendQueue";
import dataSource from "./data-source";
import { components } from "./openapi/api";
import { buildNeuraiRpcClient } from "./neurai-rpc-client";
import { PaymentUtils } from "./utils/paymentUtils";
require("dotenv").config();

const NEURAI_RPC = process.env.NEURAI_RPC;
if (!NEURAI_RPC) {
  console.error("NEURAI_RPC env variable is not set");
  process.exit();
}

// Optional: the public RPC endpoints don't expose ZMQ, so without it we poll.
const NEURAI_ZMQ = process.env.NEURAI_ZMQ;

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

// With ZMQ, sweeping the mempool is only a safety net (ZMQ has no heartbeat,
// so notifications could drop silently); without it, it is how we find new txs.
const POLL_MS = NEURAI_ZMQ ? 5 * 60 * 1000 : 9 * 1000;

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

  const outputs = PaymentUtils.outputs(txData);
  if (outputs.length === 0) return;

  const query = dataSource.getRepository(TokenToAddress).createQueryBuilder().where("address IN (:...address)", { address: outputs.map((output) => output.address) }).andWhere("chain = :chain", { chain: CHAIN });
  // One push per device, however many of the transaction's outputs paid that device.
  for (const payment of PaymentUtils.perDevice(outputs, await query.getMany())) {
    const payload: components["schemas"]["PushNotificationOnchainAddressGotUnconfirmedTransaction"] = {
      address: payment.address,
      txid: txData.txid,
      sat: payment.sat,
      ...(payment.assets.length > 0 ? { assets: payment.assets } : {}),
      type: 3,
      level: "transactions",
      token: payment.token,
      os: payment.os === "android" ? "android" : "ios",
      badge: 1,
    };
    process.env.VERBOSE && console.log(`[${CHAIN}] enqueueing`, payload);
    await sendQueueRepository.save({ data: JSON.stringify(payload) });
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
    console.log(`running groundcontrol worker-processmempool on chain ${CHAIN} via ${NEURAI_ZMQ ? `ZMQ ${NEURAI_ZMQ}` : `RPC polling every ${POLL_MS / 1000}s`}`);

    sendQueueRepository = dataSource.getRepository(SendQueue);

    // Initial sweep to backfill anything already in the mempool when we
    // start, then periodic sweeps.
    await safetySweep();
    setInterval(() => {
      safetySweep();
    }, POLL_MS);
    if (!NEURAI_ZMQ) return;

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
