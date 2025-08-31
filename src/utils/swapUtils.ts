import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";

export interface SwapConfig {
  privateKey: string;
  rpcUrl: string;
  inputMint: PublicKey;
  outputMint: PublicKey;
  amount: number; // Amount in smallest token unit (lamports for SOL)
  maxAccounts: number;
  slippage: number; // Slippage in bps (50 = 0.5%)
}

export interface SwapResult {
  signature: string;
  inputAmount: string;
  outputAmount: string;
  priceImpact: number;
}

export class SwapManager {
  private connection: Connection;
  private wallet: Keypair;
  private swapUrl: string;

  constructor(privateKey: string, rpcUrl: string, swapUrl: string) {
    this.connection = new Connection(rpcUrl);
    this.wallet = Keypair.fromSecretKey(bs58.decode(privateKey));
    this.swapUrl = swapUrl;
  }

  /**
   * Swap tokens using Jupiter API directly
   */
  async swapTokens(config: SwapConfig): Promise<SwapResult> {
    console.log(`Swapping ${config.amount} tokens...`);

    // Get quote from Jupiter API
    const quote: any = await this.getQuote(
      config.inputMint,
      config.outputMint,
      config.amount,
      config.slippage,
      config.maxAccounts
    );

    console.log(`Quote: ${quote.inAmount} → ${quote.outAmount}`);
    console.log(`Price impact: ${quote.priceImpactPct || 0}%`);

    // Get swap transaction from Jupiter API
    const swapResponse = await fetch(`${this.swapUrl}/swap/v1/swap`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: this.wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        dynamicSlippage: true,
        prioritizationFeeLamports: {
          priorityLevelWithMaxLamports: {
            maxLamports: 1000000,
            priorityLevel: "veryHigh"
          }
        }
      }),
    });

    const swapData: any = await swapResponse.json();

    if (swapData.error) {
      throw new Error(`Jupiter swap error: ${swapData.error}`);
    }

    // Deserialize the versioned transaction
    const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

    // Sign the transaction
    transaction.sign([this.wallet]);

    console.log("Executing swap...");
    const signature = await this.connection.sendTransaction(transaction);
    await this.connection.confirmTransaction(signature, 'confirmed');

    console.log(`Swap completed: ${signature}`);

    return {
      signature,
      inputAmount: quote.inAmount,
      outputAmount: quote.outAmount,
      priceImpact: parseFloat(quote.priceImpactPct || "0"),
    };
  }

  /**
   * Get quote without executing swap
   */
  async getQuote(
    inputMint: PublicKey,
    outputMint: PublicKey,
    amount: number,
    slippage: number = 50,
    maxAccounts: number = 20
  ) {
    // Ensure amount is an integer
    const integerAmount = Math.floor(amount);

    const response = await fetch(
      `${this.swapUrl}/swap/v1/quote?` +
      `inputMint=${inputMint.toString()}&` +
      `outputMint=${outputMint.toString()}&` +
      `amount=${integerAmount}&` +
      `slippageBps=${slippage}&` +
      `maxAccounts=${maxAccounts}`
    );

    const quote: any = await response.json();

    if (quote.error) {
      throw new Error(`Jupiter quote error: ${quote.error}`);
    }

    return quote;
  }

  getWalletPublicKey(): PublicKey {
    return this.wallet.publicKey;
  }

  getConnection(): Connection {
    return this.connection;
  }
}
