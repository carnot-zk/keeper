/** Parsed `MARKETS_CONFIG` entry — symbol plus 32-byte Pyth feed id (hex, no `0x`). */
export interface KeeperMarketConfig {
  marketId: string;
  pythFeedIdHex: string;
}

export interface BatchTriggerSignal {
  batchId: string;
  marketId: string;
  windowStart?: number;
  windowEnd?: number;
}
