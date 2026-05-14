/**
 * Build a jayson JSON-RPC client from a Neurai RPC URL string.
 *
 * Supports:
 *   - https:// (the public Neurai endpoints `rpc-main.neurai.org/rpc` and
 *     `rpc-testnet.neurai.org/rpc` accept anonymous calls over HTTPS)
 *   - http://  (self-hosted node, typically `http://user:pass@host:port`)
 *   - Custom paths (e.g. `/rpc`), since the public endpoints serve JSON-RPC
 *     under a sub-path rather than `/`.
 *   - Optional HTTP Basic auth via `user:pass@` in the URL, for self-hosted
 *     nodes that require credentials.
 */

// jayson and url are CommonJS — `require` keeps the call shape used elsewhere
// in this codebase consistent.
const jayson = require("jayson/promise");
const url = require("url");

export function buildNeuraiRpcClient(rpcUrl: string) {
  if (!rpcUrl) {
    throw new Error("NEURAI_RPC env variable is not set");
  }

  const parsed = url.parse(rpcUrl);
  const isHttps = parsed.protocol === "https:";

  const options: Record<string, unknown> = {
    host: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.pathname || "/",
  };

  if (parsed.auth) {
    options.headers = {
      Authorization: "Basic " + Buffer.from(parsed.auth).toString("base64"),
    };
  }

  return isHttps ? jayson.client.https(options) : jayson.client.http(options);
}
