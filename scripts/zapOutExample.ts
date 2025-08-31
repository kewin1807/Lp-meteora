import { clusterApiUrl, PublicKey } from "@solana/web3.js";
import { ZapOutManager, ZapOutConfig, PoolType } from "../src/ZapOutManager";
import "dotenv/config";

async function zapOutDammV2Example() {
  console.log("=== DAMM V2 Zap Out Example ===");

  const privateKey = process.env['SOLANA_PRIVATE_KEY'] || "";

  const config: ZapOutConfig = {
    privateKey,
    rpcUrl: clusterApiUrl("mainnet-beta"),
    inputMint: new PublicKey("JCBKQBPvnjr7emdQGCNM8wtE8AZjyvJgh7JMvkfYxypm"),
    outputMint: new PublicKey("So11111111111111111111111111111111111111112"),
    poolAddress: new PublicKey("5UpbPQiWyjE4wmvDiigtLgSXw6uHPZQUaPA1JhUm7bAG"),
    poolType: PoolType.DAMM_V2,
    percentageToZapOut: 100,
    slippage: 50,
  };

  const zapOutManager = new ZapOutManager(config);

  try {
    console.log(`Using wallet: ${zapOutManager.getWalletPublicKey().toString()}`);

    // Demonstrate token utils
    console.log("Getting token decimals...");
    const inputDecimals = await zapOutManager.getTokenDecimals(config.inputMint);
    const outputDecimals = await zapOutManager.getTokenDecimals(config.outputMint);
    console.log(`Input token decimals: ${inputDecimals}, Output token decimals: ${outputDecimals}`);

    // Check user positions first
    console.log("Checking user positions...");
    const positions = await zapOutManager.getUserPositions();
    console.log(`Found ${positions.length} position(s)`);

    // Execute zap out
    const result = await zapOutManager.executeZapOut();

    console.log("Zap out completed successfully!");
    console.log({
      bestProtocol: result.bestProtocol,
      bestQuote: result.bestQuote.toString(),
      signature: result.signature,
      removedLiquidity: {
        tokenA: result.removedLiquidity.tokenA?.toString(),
        tokenB: result.removedLiquidity.tokenB?.toString(),
      },
    });

  } catch (error) {
    console.error("Error in DAMM V2 zap out:", error);
  }
}

async function zapOutDlmmExample() {
  console.log("=== DLMM Zap Out Example ===");

  const privateKey = process.env['SOLANA_PRIVATE_KEY'] || "";

  const config: ZapOutConfig = {
    privateKey,
    rpcUrl: clusterApiUrl("mainnet-beta"),
    inputMint: new PublicKey("BFgdzMkTPdKKJeTipv2njtDEwhKxkgFueJQfJGt1jups"), // Example token X
    outputMint: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), // USDC
    poolAddress: new PublicKey("9NRifL3nKQU84hMTbhE7spakkGy5vq4AvNHNQYr8LkW7"), // DLMM LB pair
    poolType: PoolType.DLMM,
    percentageToZapOut: 100,
    slippage: 50, // 0.5% slippage in bps
  };

  const zapOutManager = new ZapOutManager(config);

  try {
    console.log(`Using wallet: ${zapOutManager.getWalletPublicKey().toString()}`);

    // Check user positions first
    console.log("Checking user positions...");
    const positions = await zapOutManager.getUserPositions();
    console.log(`Found ${positions.length} position(s)`);

    // Execute zap out
    const result = await zapOutManager.executeZapOut();

    console.log("Zap out completed successfully!");
    console.log({
      bestProtocol: result.bestProtocol,
      bestQuote: result.bestQuote.toString(),
      signature: result.signature,
      removedLiquidity: {
        tokenX: result.removedLiquidity.tokenX?.toString(),
        tokenY: result.removedLiquidity.tokenY?.toString(),
      },
    });

  } catch (error) {
    console.error("Error in DLMM zap out:", error);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const poolType = args[0] || "dammv2";

  if (poolType.toLowerCase() === "dammv2" || poolType.toLowerCase() === "damm") {
    await zapOutDammV2Example();
  } else if (poolType.toLowerCase() === "dlmm") {
    await zapOutDlmmExample();
  } else {
    console.log("Usage: npm run zap-out [dammv2|dlmm]");
    console.log("Examples:");
    console.log("  npm run zap-out dammv2  # Zap out from DAMM V2 pool");
    console.log("  npm run zap-out dlmm    # Zap out from DLMM pool");
  }
}

main().catch(console.error);
