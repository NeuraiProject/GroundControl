import "reflect-metadata";
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

// Per-chain key so mainnet and testnet workers don't trample each other's
// progress in the shared `KeyValue` table.
const LAST_PROCESSED_BLOCK_KEY = `LAST_PROCESSED_BLOCK_${CHAIN}`;

async function processBlock(blockNum, sendQueueRepository: Repository<SendQueue>) {
  console.log(`[${CHAIN}] processing new block`, +blockNum);
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

  // Match only against subscriptions for this chain so a mainnet address that
  // happens to collide with a testnet address (or vice versa) never crosses
  // chains.
  const query = dataSource.getRepository(TokenToAddress).createQueryBuilder().where("address IN (:...address)", { address: addresses }).andWhere("chain = :chain", { chain: CHAIN });

  let entities2save = [];
  for (const t2a of await query.getMany()) {
    for (let payload of allPotentialPushPayloadsArray) {
      if (t2a.address === payload.address) {
        process.env.VERBOSE && console.log(`[${CHAIN}] enqueueing`, payload);
        payload.os = t2a.os === "android" ? "android" : "ios"; // hacky
        payload.token = t2a.token;
        payload.type = 2;
        payload.badge = 1;
        entities2save.push({
          data: JSON.stringify(payload),
        });
      }
    }
  }

  if (entities2save.length > 0) {
    await sendQueueRepository.createQueryBuilder().insert().into(SendQueue).values(entities2save).execute();
  }

  // Subscriptions to specific txids, also chain-scoped:
  const query2 = dataSource.getRepository(TokenToTxid).createQueryBuilder().where("txid IN (:...txids)", { txids }).andWhere("chain = :chain", { chain: CHAIN });
  entities2save = [];
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
    entities2save.push({
      data: JSON.stringify(payload),
    });
  }

  if (entities2save.length > 0) {
    await sendQueueRepository.createQueryBuilder().insert().into(SendQueue).values(entities2save).execute();
  }
}

dataSource
  .initialize()
  .then(async (connection) => {
    // start worker
    console.log("db connected");
    console.log(`running groundcontrol worker-blockprocessor on chain ${CHAIN}`);

    const KeyValueRepository = dataSource.getRepository(KeyValue);
    const sendQueueRepository = dataSource.getRepository(SendQueue);

    while (1) {
      const keyVal = await KeyValueRepository.findOneBy({ key: LAST_PROCESSED_BLOCK_KEY });
      if (!keyVal) {
        // if no info saved in database we assume we are all caught up and wait for the next block
        const responseGetblockcount = await client.request("getblockcount", []);
        await KeyValueRepository.save({ key: LAST_PROCESSED_BLOCK_KEY, value: responseGetblockcount.result });
        continue; // skipping worker iteration
      }

      const responseGetblockcount = await client.request("getblockcount", []);

      if (+responseGetblockcount.result <= +keyVal.value) {
        await new Promise((resolve) => setTimeout(resolve, 10_000, false));
        continue;
      }

      let nextBlockToProcess: number = +keyVal.value + 1;
      const start = +new Date();
      try {
        await processBlock(nextBlockToProcess, sendQueueRepository);
      } catch (error) {
        console.warn(`[${CHAIN}] exception when processing block:`, error, "continuing as usual");
        if (error.message.includes("socket hang up")) {
          // issue fetching block from the Neurai node
          console.warn(`[${CHAIN}] retrying block number`, nextBlockToProcess);
          continue; // skip overwriting `LAST_PROCESSED_BLOCK_${CHAIN}` in `KeyValue` table
        }
      }
      const end = +new Date();
      console.log(`[${CHAIN}] took`, (end - start) / 1000, "sec");
      keyVal.value = String(nextBlockToProcess);
      await KeyValueRepository.save(keyVal);
    }
  })
  .catch((error) => {
    console.error(`[${CHAIN}] exception in blockprocessor:`, error, "comitting suicide");
    process.exit(1);
  });
