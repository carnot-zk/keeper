import type { AxiosResponse } from "axios";
import axios, { isAxiosError } from "axios";
import type * as anchor from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import type {
  BatchDataResponse,
  ConfirmBatchRequest,
  KeeperWinnerProofsResponse,
} from "@carnot/sdk";
import { hexToBuffer } from "@carnot/sdk";
import { submitSettlement, distributeWinnings } from "../submitter";
import { config, markets } from "../config";
import { recordReward } from "../reward-tracker";
import type { BatchTriggerSignal } from "../types";
import {
  carnotInternalBearerHeaders,
  describeError,
  isBatchTooSoonLikeMessage,
} from "../helpers";

/**
 * Fetch batch data from the Carnot API, run submitSettlement, then distribute
 * per-trade winnings. Proof generation is wired in once prover.ts lands.
 */
export async function runSettlementJob(
  signal: BatchTriggerSignal,
  program: anchor.Program,
  keeper: Keypair,
): Promise<"settled" | "not_ready" | "cooldown"> {
  const marketConfig = markets.find((m) => m.marketId === signal.marketId);
  if (!marketConfig) {
    console.error(
      `[settlement] Unknown marketId in signal: ${signal.marketId}`,
    );
    return "not_ready";
  }

  const nowSecs = Math.floor(Date.now() / 1000);
  if (
    typeof signal.windowEnd === "number" &&
    Number.isFinite(signal.windowEnd) &&
    nowSecs < signal.windowEnd
  ) {
    return "not_ready";
  }
  console.log(
    `[settlement] Starting batch ${signal.batchId} (${signal.marketId})`,
  );

  let batchData: BatchDataResponse;
  try {
    const response = await axios.get<BatchDataResponse>(
      `${config.CARNOT_API_URL}/internal/batch/${signal.batchId}/data`,
      {
        params: {
          marketId: signal.marketId,
          windowStart: signal.windowStart,
          windowEnd: signal.windowEnd,
        },
        headers: carnotInternalBearerHeaders(),
        timeout: 10_000,
      },
    );
    batchData = response.data;
  } catch (err: unknown) {
    if (isAxiosError(err)) {
      if (err.response?.status === 404) return "not_ready";
      if ((err.response?.status ?? 0) >= 500) return "not_ready";
    }
    console.error(
      `[settlement] Failed to fetch batch data: ${describeError(err)}`,
    );
    throw err;
  }

  // proof generation is wired in once prover.ts lands; submit with placeholder.
  const batchIdBuffer = hexToBuffer(signal.batchId);
  let txSig: string | null = null;
  try {
    txSig = await submitSettlement(
      program,
      keeper,
      marketConfig.pythFeedIdHex,
      batchIdBuffer,
      // placeholder; prover.ts will produce the real ProofResult
      undefined as never,
    );
  } catch (err: unknown) {
    const msg = describeError(err);
    if (isBatchTooSoonLikeMessage(msg)) return "cooldown";
    throw err;
  }

  if (txSig) {
    await confirmBatchOnBackend(signal.batchId, txSig);
    await distributeAllTrades(signal.batchId, batchIdBuffer, program, keeper);
  }
  return "settled";
}

async function distributeAllTrades(
  batchId: string,
  batchIdBuffer: Buffer,
  program: anchor.Program,
  keeper: Keypair,
): Promise<void> {
  let proofs: KeeperWinnerProofsResponse;
  try {
    proofs = (
      await axios.get<KeeperWinnerProofsResponse>(
        `${config.CARNOT_API_URL}/internal/batch/${batchId}/winner-proofs`,
        { headers: carnotInternalBearerHeaders(), timeout: 15_000 },
      )
    ).data;
  } catch (err: unknown) {
    console.error(
      `[distribution] Failed to fetch trade proofs for ${batchId}: ${describeError(err)}`,
    );
    return;
  }

  for (const proof of proofs.winners) {
    try {
      await distributeWinnings(program, keeper, batchIdBuffer, proof);
      const fee = BigInt(proof.winningsUsdt);
      void recordReward(batchId, fee, proof.tradeId);
    } catch (err: unknown) {
      const msg = describeError(err);
      if (msg.includes("already in use") || msg.includes("AlreadyInUse")) continue;
      console.error(`[distribution] Failed for trade ${proof.tradeId}: ${msg}`);
    }
  }
}

async function confirmBatchOnBackend(
  batchId: string,
  txSig: string,
): Promise<void> {
  const body: ConfirmBatchRequest = {
    txHash: txSig,
    confirmedAt: Math.floor(Date.now() / 1000),
  };
  try {
    await axios.post<void, AxiosResponse<void>, ConfirmBatchRequest>(
      `${config.CARNOT_API_URL}/internal/batch/${batchId}/confirm`,
      body,
      { headers: carnotInternalBearerHeaders(), timeout: 10_000 },
    );
  } catch (err: unknown) {
    console.warn(
      `[settlement] backend confirm failed for ${batchId}: ${describeError(err)}`,
    );
  }
}
