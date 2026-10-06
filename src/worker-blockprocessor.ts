import "reflect-metadata";
import { Subscriber } from "zeromq";
import { Repository } from "typeorm";
import { TokenToAddress } from "./entity/TokenToAddress";
import { SendQueue } from "./entity/SendQueue";
import { KeyValue } from "./entity/KeyValue";
import { TokenToTxid } from "./entity/TokenToTxid";
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

process
  .on("unhandledRejection", (reason, p) => {
    console.error(reason, "Unhandled Rejection at Promise", p);
    process.exit(1);
  })
  .on("uncaughtException", (err) => {
    console.error(err, "Uncaught Exception thrown");
    process.exit(1);
  });

const client = buildNeuraiRpcClient(NEURAI_RPC);

const LAST_PROCESSED_BLOCK_KEY = `LAST_PROCESSED_BLOCK_${CHAIN}`;
// Genesis hash of the chain LAST_PROCESSED_BLOCK refers to. Lets us notice a
// chain reset (e.g. the DePIN testnet relaunch), where old heights are void.
const GENESIS_BLOCK_HASH_KEY = `GENESIS_BLOCK_HASH_${CHAIN}`;

// With ZMQ this is only a safety net (ZMQ has no heartbeat, so a silent
// failure could drop notifications); without it, it is how we find new blocks.
const POLL_MS = NEURAI_ZMQ ? 5 * 60 * 1000 : 10 * 1000;

// neuraid's getblockchaininfo has no `initialblockdownload` flag, so mirror its
// IsInitialBlockDownload(): a tip older than this means the node is syncing.
const MAX_TIP_AGE_S = 24 * 60 * 60;

async function processBlockNum(blockNum: number, sendQueueRepository: Repository<SendQueue>) {
  console.log(`[${CHAIN}] processing block`, blockNum);
  const responseGetblockhash = await client.request("getblockhash", [blockNum]);
  const responseGetblock = await client.request("getblock", [responseGetblockhash.result, 2]);
  const txs = responseGetblock.result.tx.map((tx) => ({ txid: tx.txid, outputs: PaymentUtils.outputs(tx) }));
  const txids: string[] = txs.map((tx) => tx.txid);
  const addresses: string[] = [];
  for (const tx of txs) {
    for (const output of tx.outputs) addresses.push(output.address);
  }

  console.log(`[${CHAIN}]`, addresses.length, "addresses paid in block");

  if (addresses.length > 0) {
    const query = dataSource.getRepository(TokenToAddress).createQueryBuilder().where("address IN (:...address)", { address: addresses }).andWhere("chain = :chain", { chain: CHAIN });
    const subscriptions = await query.getMany();

    let entities2save = [];
    for (const tx of txs) {
      // One push per device and transaction, however many of its outputs paid that device.
      for (const payment of PaymentUtils.perDevice(tx.outputs, subscriptions)) {
        const payload: components["schemas"]["PushNotificationOnchainAddressGotPaid"] = {
          address: payment.address,
          txid: tx.txid,
          sat: payment.sat,
          ...(payment.assets.length > 0 ? { assets: payment.assets } : {}),
          type: 2,
          level: "transactions",
          token: payment.token,
          os: payment.os === "android" ? "android" : "ios",
          badge: 1,
        };
        process.env.VERBOSE && console.log(`[${CHAIN}] enqueueing`, payload);
        entities2save.push({ data: JSON.stringify(payload) });
      }
    }
    if (entities2save.length > 0) {
      await sendQueueRepository.createQueryBuilder().insert().into(SendQueue).values(entities2save).execute();
    }
  }

  if (txids.length > 0) {
    const query2 = dataSource.getRepository(TokenToTxid).createQueryBuilder().where("txid IN (:...txids)", { txids }).andWhere("chain = :chain", { chain: CHAIN });
    const entities2save = [];
    for (const t2txid of await query2.getMany()) {
      const payload: components["schemas"]["PushNotificationTxidGotConfirmed"] = {
        txid: t2txid.txid,
        type: 4,
        level: "transactions",
        token: t2txid.token,
        os: t2txid.os === "ios" ? "ios" : "android",
        badge: 1,
      };
      process.env.VERBOSE && console.log(`[${CHAIN}] enqueueing`, payload);
      entities2save.push({ data: JSON.stringify(payload) });
    }
    if (entities2save.length > 0) {
      await sendQueueRepository.createQueryBuilder().insert().into(SendQueue).values(entities2save).execute();
    }
  }
}

async function catchUpToTip(KeyValueRepository: Repository<KeyValue>, sendQueueRepository: Repository<SendQueue>) {
  // Don't walk the chain while the node is still syncing: we would push
  // notifications for long-confirmed payments.
  const chainInfo = (await client.request("getblockchaininfo", [])).result;
  if (chainInfo.headers - chainInfo.blocks > 1 || Date.now() / 1000 - chainInfo.mediantime > MAX_TIP_AGE_S) {
    console.log(`[${CHAIN}] node is syncing (${chainInfo.blocks}/${chainInfo.headers}), waiting`);
    return;
  }
  const tip = +chainInfo.blocks;
  const genesisHash = (await client.request("getblockhash", [0])).result;

  let keyVal = await KeyValueRepository.findOneBy({ key: LAST_PROCESSED_BLOCK_KEY });
  const genesisKeyVal = await KeyValueRepository.findOneBy({ key: GENESIS_BLOCK_HASH_KEY });
  // Rows written before the genesis hash was recorded can't be compared; a
  // last processed height above the synced tip gives a reset away instead.
  const chainWasReset = genesisKeyVal ? genesisKeyVal.value !== genesisHash : !!keyVal && +keyVal.value > tip;
  if (!genesisKeyVal || chainWasReset) {
    await KeyValueRepository.save({ key: GENESIS_BLOCK_HASH_KEY, value: genesisHash });
  }
  if (!keyVal || chainWasReset) {
    await KeyValueRepository.save({ key: LAST_PROCESSED_BLOCK_KEY, value: String(tip) });
    console.log(`[${CHAIN}] ${chainWasReset ? "chain reset detected, re-initialised" : "initialised"} at tip ${tip}`);
    return;
  }
  while (+keyVal.value < tip) {
    const nextBlock = +keyVal.value + 1;
    try {
      await processBlockNum(nextBlock, sendQueueRepository);
    } catch (error) {
      console.warn(`[${CHAIN}] exception processing block ${nextBlock}:`, error);
      if ((error as Error).message?.includes("socket hang up")) return;
    }
    keyVal.value = String(nextBlock);
    await KeyValueRepository.save(keyVal);
  }
}

// ZMQ, the poll timer and startup can all ask for a catch-up while one is
// running, and overlapping runs would enqueue the same block twice. Serialise
// them, folding requests that arrive mid-run into a single follow-up run.
let catchUpRunning = false;
let catchUpRequested = false;

async function requestCatchUp(KeyValueRepository: Repository<KeyValue>, sendQueueRepository: Repository<SendQueue>) {
  catchUpRequested = true;
  if (catchUpRunning) return;
  catchUpRunning = true;
  while (catchUpRequested) {
    catchUpRequested = false;
    try {
      await catchUpToTip(KeyValueRepository, sendQueueRepository);
    } catch (e) {
      console.warn(`[${CHAIN}] catch-up error:`, e);
    }
  }
  catchUpRunning = false;
}

dataSource
  .initialize()
  .then(async () => {
    console.log("db connected");
    console.log(`running groundcontrol worker-blockprocessor on chain ${CHAIN} via ${NEURAI_ZMQ ? `ZMQ ${NEURAI_ZMQ}` : `RPC polling every ${POLL_MS / 1000}s`}`);

    const KeyValueRepository = dataSource.getRepository(KeyValue);
    const sendQueueRepository = dataSource.getRepository(SendQueue);

    // Catch up to current tip before listening to ZMQ.
    await requestCatchUp(KeyValueRepository, sendQueueRepository);

    setInterval(() => requestCatchUp(KeyValueRepository, sendQueueRepository), POLL_MS);
    if (!NEURAI_ZMQ) return;

    const sock = new Subscriber();
    sock.connect(NEURAI_ZMQ);
    sock.subscribe("hashblock");

    for await (const [topicBuf, bodyBuf] of sock) {
      process.env.VERBOSE && console.log(`[${CHAIN}] zmq`, topicBuf.toString(), bodyBuf.toString("hex"));
      await requestCatchUp(KeyValueRepository, sendQueueRepository);
    }
  })
  .catch((error) => {
    console.error(`[${CHAIN}] exception in blockprocessor:`, error, "comitting suicide");
    process.exit(1);
  });
