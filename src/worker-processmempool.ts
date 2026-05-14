import "reflect-metadata";
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
const CHAIN = process.env.CHAIN;
if (CHAIN !== "mainnet" && CHAIN !== "testnet") {
  console.error("CHAIN env variable must be 'mainnet' or 'testnet'");
  process.exit();
}
const client = buildNeuraiRpcClient(NEURAI_RPC);

let processedTxids = {};

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

async function processMempool() {
  process.env.VERBOSE && console.log(`[${CHAIN}] cached txids=`, Object.keys(processedTxids).length);
  const responseGetrawmempool = await client.request("getrawmempool", []);
  process.env.VERBOSE && console.log(`[${CHAIN}]`, responseGetrawmempool.result.length, "txs in mempool");

  let addresses: string[] = [];
  let allPotentialPushPayloadsArray: components["schemas"]["PushNotificationOnchainAddressGotUnconfirmedTransaction"][] = [];

  let rpcBatch = [];
  const batchSize = 100;
  let countTxidsProcessed = 0;
  for (const txid of responseGetrawmempool.result) {
    countTxidsProcessed++;
    if (!txid) continue;
    if (!processedTxids[txid]) rpcBatch.push(client.request("getrawtransaction", [txid, true], undefined, false));
    if (rpcBatch.length >= batchSize || countTxidsProcessed === responseGetrawmempool.result.length) {
      const startBatch = +new Date();
      // got enough txids - batch fetch them from the Neurai RPC
      const responses = await client.request(rpcBatch);
      for (const response of responses) {
        if (response.result && response.result.vout) {
          for (const output of response.result.vout) {
            if (output.scriptPubKey && (output.scriptPubKey.addresses || output.scriptPubKey.address)) {
              for (const address of output.scriptPubKey?.addresses ?? (output.scriptPubKey?.address ? [output.scriptPubKey?.address] : [])) {
                addresses.push(address);
                processedTxids[response.result.txid] = true;
                const payload: components["schemas"]["PushNotificationOnchainAddressGotUnconfirmedTransaction"] = {
                  address,
                  txid: response.result.txid,
                  sat: Math.floor(output.value * 100000000),
                  type: 3,
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

      if (addresses.length === 0) {
        allPotentialPushPayloadsArray = [];
        addresses = [];
        rpcBatch = [];
        continue;
      }

      // fetching found addresses from db, chain-scoped:
      const query = dataSource.getRepository(TokenToAddress).createQueryBuilder().where("address IN (:...address)", { address: addresses }).andWhere("chain = :chain", { chain: CHAIN });
      for (const t2a of await query.getMany()) {
        for (let payload of allPotentialPushPayloadsArray) {
          if (t2a.address === payload.address) {
            process.env.VERBOSE && console.log(`[${CHAIN}] enqueueing`, payload);
            payload.os = t2a.os === "android" ? "android" : "ios"; // hacky
            payload.token = t2a.token;
            payload.type = 3;
            payload.level = "transactions";
            payload.badge = 1;
            await sendQueueRepository.save({
              data: JSON.stringify(payload),
            });
          }
        }
      }

      allPotentialPushPayloadsArray = [];
      addresses = [];
      rpcBatch = [];

      const endBatch = +new Date();
      // process.stdout.write('.');
      process.env.VERBOSE && console.log("batch took", (endBatch - startBatch) / 1000, "sec");
    }
  }
}

dataSource
  .initialize()
  .then(async (connection) => {
    // start worker
    console.log("db connected");
    console.log(`running groundcontrol worker-processmempool on chain ${CHAIN}`);
    console.log(require("fs").readFileSync("./bowie.txt").toString("ascii"));

    sendQueueRepository = dataSource.getRepository(SendQueue);

    while (1) {
      const start = +new Date();
      try {
        await processMempool();
      } catch (error) {
        console.warn(`[${CHAIN}] Exception in processMempool():`, error);
      }
      const end = +new Date();
      console.log(`[${CHAIN}] processing mempool took`, (end - start) / 1000, "sec");
      console.log("-----------------------");
      await new Promise((resolve) => setTimeout(resolve, 9000, false));
    }
  })
  .catch((error) => {
    console.error(`[${CHAIN}] exception in mempool processor:`, error, "comitting suicide");
    process.exit(1);
  });
