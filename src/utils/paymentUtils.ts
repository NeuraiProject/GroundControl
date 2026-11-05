import { AmountUtils } from "./amountUtils";

/** An asset amount in exact base units (1 unit = 100,000,000). */
export type AssetAmount = { name: string; amount: bigint };

/** One address paid by one transaction output. */
export type PaidOutput = { n: number; address: string; sat: bigint; asset?: AssetAmount };

/** Everything one transaction paid to the addresses of one subscribed device. */
export type DevicePayment = { token: string; os: string; address: string; sat: bigint; assets: AssetAmount[] };

/** The amounts of a push payload: numbers while they are exact in JavaScript, decimal text beyond. */
export type PaymentJson = { sat: number | string; assets?: { name: string; amount: number | string }[] };

export class PaymentUtils {
  /**
   * Lists the addresses paid by a decoded transaction (`getblock` verbosity 2 or verbose `getrawtransaction`), one entry per
   * output address. Asset outputs (issue, reissue, transfer) carry their asset next to the output's XNA value, normally 0.
   */
  static outputs(tx: any): PaidOutput[] {
    const outputs: PaidOutput[] = [];
    (tx.vout ?? []).forEach((output, n: number) => {
      const scriptPubKey = output.scriptPubKey;
      const asset = scriptPubKey?.asset?.name ? { name: scriptPubKey.asset.name, amount: AmountUtils.toBaseUnits(scriptPubKey.asset.amount) } : undefined;
      for (const address of scriptPubKey?.addresses ?? (scriptPubKey?.address ? [scriptPubKey.address] : [])) {
        outputs.push({ n, address, sat: AmountUtils.toBaseUnits(output.value), ...(asset ? { asset } : {}) });
      }
    });
    return outputs;
  }

  /**
   * Folds a transaction's outputs into one payment per subscribed device, so a transaction paying a device several times
   * (e.g. XNA change plus asset transfers back to the sender) yields a single push. `address` is the device's first paid
   * address in output order.
   */
  static perDevice(outputs: PaidOutput[], subscriptions: { token: string; os: string; address: string }[]): DevicePayment[] {
    const payments: DevicePayment[] = [];
    const countedOutputs: Record<string, boolean> = {};
    for (const output of outputs) {
      for (const subscription of subscriptions) {
        if (subscription.address !== output.address) continue;
        // A multisig output lists several addresses; count it once per device.
        const outputKey = subscription.token + ":" + output.n;
        if (countedOutputs[outputKey]) continue;
        countedOutputs[outputKey] = true;

        let payment = payments.find((p) => p.token === subscription.token);
        if (!payment) {
          payment = { token: subscription.token, os: subscription.os, address: output.address, sat: BigInt(0), assets: [] };
          payments.push(payment);
        }
        payment.sat += output.sat;
        if (output.asset) {
          const sameAsset = payment.assets.find((a) => a.name === output.asset.name);
          if (sameAsset) sameAsset.amount += output.asset.amount;
          else payment.assets.push({ ...output.asset });
        }
      }
    }
    return payments;
  }

  /** The `sat` and `assets` fields of a push payload for one device payment. */
  static toJson(payment: DevicePayment): PaymentJson {
    return {
      sat: AmountUtils.toJson(payment.sat),
      ...(payment.assets.length > 0 ? { assets: payment.assets.map((asset) => ({ name: asset.name, amount: AmountUtils.toJson(asset.amount) })) } : {}),
    };
  }
}
