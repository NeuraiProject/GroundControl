/**
 * Neurai JSON-RPC client built on @neuraiproject/neurai-rpc, from a URL string.
 *
 * Supports:
 *   - https:// (the public Neurai endpoints `rpc-main.neurai.org/rpc` and
 *     `rpc-testnet.neurai.org/rpc` accept anonymous calls over HTTPS)
 *   - http://  (self-hosted node, typically `http://user:pass@host:port`)
 *   - Custom paths (e.g. `/rpc`), since the public endpoints serve JSON-RPC
 *     under a sub-path rather than `/`.
 *   - Optional HTTP Basic auth via `user:pass@` in the URL.
 *
 * Responses are parsed losslessly: a number arrives as a JavaScript number only
 * when it keeps every digit the node wrote, and as its decimal text otherwise,
 * so amounts beyond 2^53 base units are not rounded before AmountUtils reads them.
 */
import { getRPC } from "@neuraiproject/neurai-rpc";

/** The node could not be reached or answered without a JSON-RPC response: retry later. */
export class RpcUnavailableError extends Error {}

export type NeuraiRpcClient = { request(method: string, params: unknown[]): Promise<{ result: any }> };

function errorFor(method: string, rejection: any): Error {
  if (rejection instanceof Error) return rejection;
  // neurai-rpc rejects with plain objects: `type: "ServerUnreachable"` when fetch failed, an HTTP
  // `status` without `error` when no JSON-RPC answer came back, and `error` for a JSON-RPC error.
  const rpcError = rejection?.error && typeof rejection.error === "object" ? rejection.error : null;
  if (rejection?.type === "ServerUnreachable" || (rejection?.status && !rpcError)) {
    const cause = rejection?.originalError?.message ?? rejection?.statusText ?? rejection?.status ?? "unreachable";
    return new RpcUnavailableError(`${method}: Neurai RPC unavailable (${cause})`);
  }
  const message = rpcError?.message ?? rejection?.description ?? JSON.stringify(rejection);
  return Object.assign(new Error(`${method}: ${message}`), { code: rpcError?.code });
}

export function buildNeuraiRpcClient(rpcUrl: string): NeuraiRpcClient {
  if (!rpcUrl) {
    throw new Error("NEURAI_RPC env variable is not set");
  }
  // fetch() refuses URLs with credentials, so they travel as the Basic auth
  // header instead. The public endpoints accept any credentials.
  const url = new URL(rpcUrl);
  const username = decodeURIComponent(url.username) || "anonymous";
  const password = decodeURIComponent(url.password) || "anonymous";
  url.username = "";
  url.password = "";
  const rpc = getRPC(username, password, url.toString());

  return {
    async request(method: string, params: unknown[]) {
      try {
        return { result: await rpc(method, params as any[]) };
      } catch (rejection) {
        throw errorFor(method, rejection);
      }
    },
  };
}
