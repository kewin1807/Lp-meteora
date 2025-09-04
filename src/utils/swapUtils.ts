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
   * Swap tokens using Jupiter API with retry mechanism
   */
  async swapTokens(config: SwapConfig, maxRetries: number = 3): Promise<SwapResult> {
    console.log(`Swapping ${config.amount} tokens...`);

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Increase slippage and maxAccounts with each retry
        const retrySlippage = config.slippage + (attempt - 1) * 50; // Increase by 0.5% each retry
        const retryMaxAccounts = Math.min(config.maxAccounts + (attempt - 1) * 10, 50); // Increase by 10 each retry, max 50

        console.log(`Attempt ${attempt}/${maxRetries} - Slippage: ${retrySlippage}bps, MaxAccounts: ${retryMaxAccounts}`);

        // Get quote from Jupiter API
        const quote: any = await this.getQuote(
          config.inputMint,
          config.outputMint,
          config.amount,
          retrySlippage,
          retryMaxAccounts
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

      } catch (error) {
        lastError = error as Error;
        console.error(`Swap attempt ${attempt} failed:`, error);

        if (attempt < maxRetries) {
          console.log(`Retrying in 2 seconds...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }

    throw new Error(`Swap failed after ${maxRetries} attempts. Last error: ${lastError?.message}`);
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

  /**
   * Validate if a route exists for the given swap parameters
   */
  async validateRoute(
    inputMint: PublicKey,
    outputMint: PublicKey,
    amount: number,
    maxAccounts: number = 20
  ): Promise<boolean> {
    try {
      const response = await fetch(
        `${this.swapUrl}/swap/v1/quote?` +
        `inputMint=${inputMint.toString()}&` +
        `outputMint=${outputMint.toString()}&` +
        `amount=${Math.floor(amount)}&` +
        `slippageBps=100&` +
        `maxAccounts=${maxAccounts}`
      );

      const quote: any = await response.json();
      return !quote.error && quote.outAmount && quote.outAmount !== "0";
    } catch (error) {
      console.error('Route validation error:', error);
      return false;
    }
  }
}
