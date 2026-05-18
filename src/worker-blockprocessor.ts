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

// ZMQ has no heartbeat; if a silent failure drops notifications, this
// catches us up periodically.
const SAFETY_POLL_MS = 5 * 60 * 1000;

async function processBlockNum(blockNum: number, sendQueueRepository: Repository<SendQueue>) {
  console.log(`[${CHAIN}] processing block`, blockNum);
  const responseGetblockhash = await client.request("getblockhash", [blockNum]);
  const responseGetblock = await client.request("getblock", [responseGetblockhash.result, 2]);
  const addresses: string[] = [];
  const allPotentialPushPayloadsArray: components["schemas"]["PushNotificationOnchainAddressGotPaid"][] = [];
  const txids: string[] = [];
  for (const tx of responseGetblock.result.tx) {
    txids.push(tx.txid);
    if (tx.vout) {
      for (const output of tx.vout) {
        if (output.scriptPubKey && (output.scriptPubKey.addresses || output.scriptPubKey.address)) {
          for (const address of output.scriptPubKey?.addresses ?? (output.scriptPubKey?.address ? [output.scriptPubKey?.address] : [])) {
            addresses.push(address);
            const payload: components["schemas"]["PushNotificationOnchainAddressGotPaid"] = {
              address,
              txid: tx.txid,
              sat: Math.floor(output.value * 100000000),
              type: 2,
              level: "transactions",
              token: "",
              os: "ios",
            };
            allPotentialPushPayloadsArray.push(payload);
          }
        }
      }
    }
  }

  console.log(`[${CHAIN}]`, addresses.length, "addresses paid in block");

  if (addresses.length > 0) {
    const query = dataSource.getRepository(TokenToAddress).createQueryBuilder().where("address IN (:...address)", { address: addresses }).andWhere("chain = :chain", { chain: CHAIN });

    let entities2save = [];
    for (const t2a of await query.getMany()) {
      for (let payload of allPotentialPushPayloadsArray) {
        if (t2a.address === payload.address) {
          process.env.VERBOSE && console.log(`[${CHAIN}] enqueueing`, payload);
          payload.os = t2a.os === "android" ? "android" : "ios";
          payload.token = t2a.token;
          payload.type = 2;
          payload.badge = 1;
          entities2save.push({ data: JSON.stringify(payload) });
        }
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
  let keyVal = await KeyValueRepository.findOneBy({ key: LAST_PROCESSED_BLOCK_KEY });
  const tip = +(await client.request("getblockcount", [])).result;
  if (!keyVal) {
    await KeyValueRepository.save({ key: LAST_PROCESSED_BLOCK_KEY, value: String(tip) });
    console.log(`[${CHAIN}] initialised at tip ${tip}`);
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

dataSource
  .initialize()
  .then(async () => {
    console.log("db connected");
    console.log(`running groundcontrol worker-blockprocessor on chain ${CHAIN} via ZMQ ${NEURAI_ZMQ}`);

    const KeyValueRepository = dataSource.getRepository(KeyValue);
    const sendQueueRepository = dataSource.getRepository(SendQueue);

    // Catch up to current tip before listening to ZMQ.
    await catchUpToTip(KeyValueRepository, sendQueueRepository);

    // Safety net in case ZMQ silently stops delivering.
    setInterval(() => {
      catchUpToTip(KeyValueRepository, sendQueueRepository).catch((e) => console.warn(`[${CHAIN}] safety poll error:`, e));
    }, SAFETY_POLL_MS);

    const sock = new Subscriber();
    sock.connect(NEURAI_ZMQ);
    sock.subscribe("hashblock");

    for await (const [topicBuf, bodyBuf] of sock) {
      process.env.VERBOSE && console.log(`[${CHAIN}] zmq`, topicBuf.toString(), bodyBuf.toString("hex"));
      try {
        await catchUpToTip(KeyValueRepository, sendQueueRepository);
      } catch (e) {
        console.warn(`[${CHAIN}] hashblock handler error:`, e);
      }
    }
  })
  .catch((error) => {
    console.error(`[${CHAIN}] exception in blockprocessor:`, error, "comitting suicide");
    process.exit(1);
  });
