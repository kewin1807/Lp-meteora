import { clusterApiUrl, PublicKey, Keypair } from "@solana/web3.js";
import { LiquidityPoolManager, PoolConfig } from "../src/LiquidityPoolManager";
import * as fs from "fs";
import "dotenv/config";
import Decimal from "decimal.js";
(async () => {
  // Load private key from file
  const privateKey = process.env['SOLANA_PRIVATE_KEY'] || ""
  // load privateKey 
  const CONFIG: PoolConfig = {
    privateKey,
    rpcUrl: clusterApiUrl("mainnet-beta"),
    pool: new PublicKey("HT3VVTqaiyQXAjtqN7ij61zqHuwQNoNPaqqSLXjCHmhq"),
    tokenADecimals: 6,
    tokenBDecimals: 9,
    tokenAAmount: new Decimal(11036.86).mul(new Decimal(1e6)),
    tokenBAmount: new Decimal(0.1).mul(new Decimal(1e9)), // SOL
  };

  // Create liquidity pool manager instance
  const liquidityManager = new LiquidityPoolManager(CONFIG);

  try {
    // Create position and add liquidity
    const result = await liquidityManager.createPositionAndAddLiquidity();

    console.log({
      position: result.position,
      positionNft: result.positionNft,
      signature: result.signature,
    });
  } catch (error) {
    console.error("Error creating liquidity position:", error);
  }
})();