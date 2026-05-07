import { Connection, Keypair } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import bs58 from "bs58";
import { carnotIdl } from "@carnot/sdk";
import { config, programIds } from "./config";
import { describeError, isBatchTooSoonLikeMessage } from "./helpers";
import { BatchWatcher } from "./watcher";
import { runSettlementJob } from "./jobs/settlement";
import type { BatchTriggerSignal } from "./types";

async function main() {
  console.log(`Carnot Keeper starting on ${config.NETWORK}...`);

  const connection = new Connection(config.SOLANA_RPC_URL, {
    wsEndpoint: config.SOLANA_WS_URL,
    commitment: config.SOLANA_COMMITMENT,
  });

  const keeperKeypair = Keypair.fromSecretKey(
    bs58.decode(config.KEEPER_KEYPAIR),
  );
  const wallet = new anchor.Wallet(keeperKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: config.SOLANA_COMMITMENT,
  });

  const idlWithAddress = {
    ...carnotIdl,
    address: programIds.carnot,
  } as anchor.Idl;
  const carnotProgram = new anchor.Program(idlWithAddress, provider);

  const watcher = new BatchWatcher(connection, carnotProgram);
  watcher.watchForBatches(async (signal: BatchTriggerSignal) => {
    try {
      await runSettlementJob(signal, carnotProgram, keeperKeypair);
    } catch (err) {
      const msg = describeError(err);
      if (isBatchTooSoonLikeMessage(msg)) {
        console.warn(
          `[keeper] Cooldown active while settling ${signal.batchId}; will retry`,
        );
        return;
      }
      console.error(`[keeper] Settlement failed: ${msg}`);
      process.exit(1);
    }
  });

  console.log(
    `Keeper active. Pubkey: ${keeperKeypair.publicKey.toBase58()}. Polling every ${config.BATCH_POLL_INTERVAL_MS}ms...`,
  );
}

main().catch((err) => {
  console.error("Keeper crashed:", err);
  process.exit(1);
});
