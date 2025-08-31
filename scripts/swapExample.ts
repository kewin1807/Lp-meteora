import { clusterApiUrl, PublicKey } from "@solana/web3.js";
import { SwapManager, SwapConfig } from "../src/utils";
import { BN } from "@coral-xyz/anchor";
import "dotenv/config";

async function main() {
  const privateKey = process.env['SOLANA_PRIVATE_KEY'] || "";

  if (!privateKey) {
    console.error("Please set SOLANA_PRIVATE_KEY in your environment");
    return;
  }

  const swapManager = new SwapManager(privateKey, clusterApiUrl("mainnet-beta"), 'https://lite-api.jup.ag');

  console.log(`Wallet: ${swapManager.getWalletPublicKey().toString()}`);

  // Example swap configuration
  const swapConfig: SwapConfig = {
    privateKey,
    rpcUrl: clusterApiUrl("mainnet-beta"),
    inputMint: new PublicKey("So11111111111111111111111111111111111111112"), // SOL
    outputMint: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), // USDC
    amount: 0.1 * 1e9, // 0.1 SOL (in lamports)
    slippage: 50, // 0.5%
    maxAccounts: 30,
  };

  try {
    // Get quote first
    console.log("Getting quote...");
    const quote = await swapManager.getQuote(
      swapConfig.inputMint,
      swapConfig.outputMint,
      swapConfig.amount,
      swapConfig.slippage,
      swapConfig.maxAccounts
    );

    console.log("Quote received:");
    console.log(`Input: ${quote.inAmount}`);
    console.log(`Output: ${quote.outAmount}`);
    console.log(`Price Impact: ${quote.priceImpactPct}%`);

    // Uncomment to execute the swap
    const result = await swapManager.swapTokens(swapConfig);
    console.log("Swap Result:", result);

  } catch (error) {
    console.error("Swap failed:", error);
  }
}

main().catch(console.error);
