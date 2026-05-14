// Addresses to skip when scanning the chain. BlueWallet shipped a list of 81
// Bitcoin addresses (faucets, exchange hot-wallets, dust attackers) accumulated
// empirically — none of those apply to Neurai. Repopulate as Neurai-specific
// noisy addresses are discovered in production.
export const ADDRESS_IGNORE_LIST: string[] = [];
