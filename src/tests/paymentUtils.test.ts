import { describe, it, expect } from "vitest";
import { PaymentUtils } from "../utils/paymentUtils";

const MINE = "tnq1r5yje326mgdaka7d8hcxkvypfn9dz3tg2yy34rr7ndjexk05n4qvq06dwg5";
const OTHER = "tLW6nMzmAgnnkoHoHXuG7dzqSXrGuLUTPe";

// Shape of testnet tx 27613d04…, a self-send: XNA change plus two asset transfers back to the same address.
const selfSendTx = {
  txid: "27613d0495b64871aade45687871f728f04f05a8016eea8f32e48a5779c19fd9",
  vout: [
    { value: 8989.968685, n: 0, scriptPubKey: { type: "witness_v0_keyhash", addresses: [MINE] } },
    { value: 0, n: 1, scriptPubKey: { type: "transfer_asset", addresses: [MINE], asset: { name: "&CHAT!", amount: 1 } } },
    { value: 0, n: 2, scriptPubKey: { type: "transfer_asset", addresses: [MINE], asset: { name: "&CHAT", amount: 999999 } } },
    { value: 0, n: 3, scriptPubKey: { type: "nulldata" } },
  ],
};

describe("PaymentUtils", () => {
  describe("outputs", () => {
    it("should list every paid address with XNA in base units and the asset, if any", () => {
      expect(PaymentUtils.outputs(selfSendTx)).toEqual([
        { n: 0, address: MINE, sat: 898996868500n },
        { n: 1, address: MINE, sat: 0n, asset: { name: "&CHAT!", amount: 100000000n } },
        { n: 2, address: MINE, sat: 0n, asset: { name: "&CHAT", amount: 99999900000000n } },
      ]);
    });

    it("should accept the singular `address` field", () => {
      expect(PaymentUtils.outputs({ vout: [{ value: 1, scriptPubKey: { address: OTHER } }] })).toEqual([{ n: 0, address: OTHER, sat: 100000000n }]);
    });

    it("should handle transactions without outputs", () => {
      expect(PaymentUtils.outputs({})).toEqual([]);
    });
  });

  describe("perDevice", () => {
    const device = { token: "tok-a", os: "android", address: MINE };

    it("should fold all outputs to a device into one payment", () => {
      expect(PaymentUtils.perDevice(PaymentUtils.outputs(selfSendTx), [device])).toEqual([
        {
          token: "tok-a",
          os: "android",
          address: MINE,
          sat: 898996868500n,
          assets: [
            { name: "&CHAT!", amount: 100000000n },
            { name: "&CHAT", amount: 99999900000000n },
          ],
        },
      ]);
    });

    it("should sum repeated assets and several addresses of the same device", () => {
      const tx = {
        vout: [
          { value: 0, scriptPubKey: { addresses: [OTHER], asset: { name: "GOLD", amount: 1.5 } } },
          { value: 0, scriptPubKey: { addresses: [MINE], asset: { name: "GOLD", amount: 2 } } },
          { value: 0.25, scriptPubKey: { addresses: [MINE] } },
        ],
      };
      const payments = PaymentUtils.perDevice(PaymentUtils.outputs(tx), [device, { ...device, address: OTHER }]);
      expect(payments).toEqual([{ token: "tok-a", os: "android", address: OTHER, sat: 25000000n, assets: [{ name: "GOLD", amount: 350000000n }] }]);
    });

    it("should give each subscribed device its own payment", () => {
      const tx = { vout: [{ value: 1, scriptPubKey: { addresses: [MINE] } }] };
      const payments = PaymentUtils.perDevice(PaymentUtils.outputs(tx), [device, { token: "tok-b", os: "ios", address: MINE }]);
      expect(payments.map((p) => [p.token, p.sat])).toEqual([
        ["tok-a", 100000000n],
        ["tok-b", 100000000n],
      ]);
    });

    it("should count a multisig output once even if the device subscribed to several of its addresses", () => {
      const tx = { vout: [{ value: 2, scriptPubKey: { type: "multisig", addresses: [MINE, OTHER] } }] };
      const payments = PaymentUtils.perDevice(PaymentUtils.outputs(tx), [device, { ...device, address: OTHER }]);
      expect(payments).toEqual([{ token: "tok-a", os: "android", address: MINE, sat: 200000000n, assets: [] }]);
    });

    it("should ignore outputs to addresses nobody subscribed to", () => {
      const tx = { vout: [{ value: 1, scriptPubKey: { addresses: [OTHER] } }] };
      expect(PaymentUtils.perDevice(PaymentUtils.outputs(tx), [device])).toEqual([]);
    });

    it("should sum amounts beyond 2^53 base units exactly", () => {
      // As the RPC client returns them: decimal text when no JavaScript number holds the digits.
      const tx = {
        vout: [
          { value: "60000000.00000001", scriptPubKey: { addresses: [MINE] } },
          { value: "60000000.00000002", scriptPubKey: { addresses: [MINE] } },
          { value: 0, scriptPubKey: { addresses: [MINE], asset: { name: "BIG", amount: "1000000000.12345678" } } },
          { value: 0, scriptPubKey: { addresses: [MINE], asset: { name: "BIG", amount: "999999999.87654322" } } },
        ],
      };
      const [payment] = PaymentUtils.perDevice(PaymentUtils.outputs(tx), [device]);
      expect(payment.sat).toBe(12000000000000003n);
      expect(payment.assets).toEqual([{ name: "BIG", amount: 200000000000000000n }]);
    });
  });

  describe("toJson", () => {
    it("should keep exact amounts as numbers and larger ones as digit strings", () => {
      const payment = { token: "tok-a", os: "android", address: MINE, sat: 12000000000000003n, assets: [{ name: "BIG", amount: 1n }] };
      expect(PaymentUtils.toJson(payment)).toEqual({ sat: "12000000000000003", assets: [{ name: "BIG", amount: 1 }] });
      expect(PaymentUtils.toJson({ ...payment, sat: 5n, assets: [] })).toEqual({ sat: 5 });
      // The queue stores the payload as JSON text: it must serialize.
      expect(JSON.parse(JSON.stringify(PaymentUtils.toJson(payment))).sat).toBe("12000000000000003");
    });
  });
});
