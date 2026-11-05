import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "http";
import { AddressInfo } from "net";
import { buildNeuraiRpcClient, RpcUnavailableError } from "../neurai-rpc-client";
import { PaymentUtils } from "../utils/paymentUtils";

// A node answering raw JSON text, so the test controls every digit the client parses.
let server: http.Server;
let base: string;
const seen: { authorization?: string; path?: string; method?: string }[] = [];
const replies: Record<string, { status: number; body: string }> = {
  getblock: {
    status: 200,
    body:
      '{"result":{"tx":[{"txid":"aa","vout":[{"value":120000000.00000003,"scriptPubKey":{"addresses":["tAddr"]}},{"value":0.29,"scriptPubKey":{"addresses":["tAddr"],"asset":{"name":"BIG","amount":1000000000.12345678}}}]}]},"error":null,"id":1}',
  },
  getrawtransaction: { status: 500, body: '{"result":null,"error":{"code":-5,"message":"No such mempool or blockchain transaction"},"id":1}' },
  getblockcount: { status: 503, body: "Service Unavailable" },
};

beforeAll(async () => {
  server = http.createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => {
      const { method } = JSON.parse(text);
      seen.push({ authorization: request.headers.authorization, path: request.url, method });
      const reply = replies[method] ?? { status: 200, body: '{"result":null,"error":null,"id":1}' };
      response.writeHead(reply.status, { "Content-Type": "application/json" });
      response.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(
  () => new Promise<void>((resolve) => server.close(() => resolve()))
);

describe("buildNeuraiRpcClient", () => {
  it("should send URL credentials as Basic auth and keep the path", async () => {
    await buildNeuraiRpcClient(`http://neurai:change%40me@${base}/rpc`).request("getbestblockhash", []);
    await buildNeuraiRpcClient(`http://${base}/`).request("getbestblockhash", []);
    expect(seen.at(-2)).toMatchObject({ path: "/rpc", authorization: "Basic " + Buffer.from("neurai:change@me").toString("base64") });
    expect(seen.at(-1)).toMatchObject({ path: "/", authorization: "Basic " + Buffer.from("anonymous:anonymous").toString("base64") });
  });

  it("should return amounts no JavaScript number holds as their decimal text", async () => {
    const { result } = await buildNeuraiRpcClient(`http://${base}`).request("getblock", ["hash", 2]);
    const [output, assetOutput] = result.tx[0].vout;
    expect(output.value).toBe("120000000.00000003");
    expect(assetOutput.value).toBe(0.29);
    expect(assetOutput.scriptPubKey.asset.amount).toBe("1000000000.12345678");
    const [payment] = PaymentUtils.perDevice(PaymentUtils.outputs(result.tx[0]), [{ token: "t", os: "ios", address: "tAddr" }]);
    expect(payment.sat).toBe(12000000029000003n);
    expect(payment.assets).toEqual([{ name: "BIG", amount: 100000000012345678n }]);
  });

  it("should reject a JSON-RPC error as an ordinary error with its code", async () => {
    const error = await buildNeuraiRpcClient(`http://${base}`)
      .request("getrawtransaction", ["bb", true])
      .catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RpcUnavailableError);
    expect(error.message).toBe("getrawtransaction: No such mempool or blockchain transaction");
    expect(error.code).toBe(-5);
  });

  it("should reject an unreachable node or a non JSON-RPC answer as unavailable", async () => {
    await expect(buildNeuraiRpcClient(`http://${base}`).request("getblockcount", [])).rejects.toBeInstanceOf(RpcUnavailableError);
    await expect(buildNeuraiRpcClient("http://127.0.0.1:1").request("getblockcount", [])).rejects.toBeInstanceOf(RpcUnavailableError);
  });
});
