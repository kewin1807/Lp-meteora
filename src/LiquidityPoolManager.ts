import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { CpAmm, derivePositionAddress, PositionState } from "@meteora-ag/cp-amm-sdk";
import {
  getMint,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import Decimal from "decimal.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";

export interface PoolConfig {
  privateKey: string;
  rpcUrl: string;
  pool: PublicKey;
  tokenADecimals: number;
  tokenBDecimals: number;
  tokenAAmount: Decimal;
  tokenBAmount: Decimal;
}

export interface TokenInfo {
  mint: any;
  currentEpoch: number;
}

export interface LiquidityPositionResult {
  position: string;
  positionNft: string;
  signature: string;
}

export class LiquidityPoolManager {
  private connection: Connection;
  private cpAmm: CpAmm;
  private wallet: Keypair;
  private config: PoolConfig;

  constructor(config: PoolConfig) {
    this.config = config;
    this.connection = new Connection(config.rpcUrl);
    this.cpAmm = new CpAmm(this.connection);
    this.wallet = Keypair.fromSecretKey(bs58.decode(config.privateKey));
  }

  private async getPoolAndTokenInfo() {
    const poolState = await this.cpAmm.fetchPoolState(this.config.pool);
    const tokenAAccountInfo = await this.connection.getAccountInfo(
      poolState.tokenAMint
    );

    let tokenAProgram = TOKEN_PROGRAM_ID;
    let tokenAInfo: TokenInfo | null = null;

    if (tokenAAccountInfo && tokenAAccountInfo.owner) {
      tokenAProgram = tokenAAccountInfo.owner;
      const baseMint = await getMint(
        this.connection,
        poolState.tokenAMint,
        this.connection.commitment,
        tokenAProgram
      );
      const epochInfo = await this.connection.getEpochInfo();
      tokenAInfo = {
        mint: baseMint,
        currentEpoch: epochInfo.epoch,
      };
    }

    return { poolState, tokenAProgram, tokenAInfo };
  }

  private calculateLiquidityDelta(
    addLidTokenAAmount: Decimal,
    addLidTokenBAmount: Decimal,
    poolState: any,
    tokenAInfo: TokenInfo
  ) {
    try {
      // Convert Decimal to integer string to avoid BN issues
      const tokenAAmountInt = addLidTokenAAmount.floor().toString();
      const tokenBAmountInt = addLidTokenBAmount.floor().toString();

      console.log(`Liquidity delta calculation: TokenA=${tokenAAmountInt}, TokenB=${tokenBAmountInt}`);

      return this.cpAmm.getLiquidityDelta({
        maxAmountTokenA: new BN(tokenAAmountInt),
        maxAmountTokenB: new BN(tokenBAmountInt),
        sqrtPrice: poolState.sqrtPrice,
        sqrtMinPrice: poolState.sqrtMinPrice,
        sqrtMaxPrice: poolState.sqrtMaxPrice,
        tokenAInfo,
      });
    } catch (error) {
      console.error('Error in calculateLiquidityDelta:', error);
      console.error('TokenA amount:', addLidTokenAAmount.toString());
      console.error('TokenB amount:', addLidTokenBAmount.toString());
      throw error;
    }
  }

  /**
   * Create position and add liquidity transaction
   */
  private async createPositionTransaction(
    positionNft: Keypair,
    liquidityDelta: any,
    addLidTokenAAmount: Decimal,
    addLidTokenBAmount: Decimal,
    poolState: any,
    tokenAProgram: PublicKey
  ) {
    try {
      // Convert to integer strings to avoid BN issues
      const tokenAAmountInt = addLidTokenAAmount.floor().toString();
      const tokenBAmountInt = addLidTokenBAmount.floor().toString();

      // Calculate slippage thresholds with buffer for transfer fees
      // Add 5% buffer to account for transfer fees and slippage
      const slippageBuffer = new Decimal(1.05); // 5% buffer
      const tokenAAmountThreshold = addLidTokenAAmount.mul(slippageBuffer).floor().toString();
      const tokenBAmountThreshold = addLidTokenBAmount.mul(slippageBuffer).floor().toString();

      console.log(`Creating position transaction with amounts: TokenA=${tokenAAmountInt}, TokenB=${tokenBAmountInt}`);
      console.log(`Slippage thresholds: TokenA=${tokenAAmountThreshold}, TokenB=${tokenBAmountThreshold}`);

      return await this.cpAmm.createPositionAndAddLiquidity({
        owner: this.wallet.publicKey,
        pool: this.config.pool,
        positionNft: positionNft.publicKey,
        liquidityDelta,
        maxAmountTokenA: new BN(tokenAAmountInt),
        maxAmountTokenB: new BN(tokenBAmountInt),
        tokenAAmountThreshold: new BN(tokenAAmountThreshold),
        tokenBAmountThreshold: new BN(tokenBAmountThreshold),
        tokenAMint: poolState.tokenAMint,
        tokenBMint: poolState.tokenBMint,
        tokenAProgram,
        tokenBProgram: TOKEN_PROGRAM_ID,
      });
    } catch (error) {
      console.error('Error in createPositionTransaction:', error);
      console.error('TokenA amount:', addLidTokenAAmount.toString());
      console.error('TokenB amount:', addLidTokenBAmount.toString());
      throw error;
    }
  }

  /**
   * Create position transaction with retry-specific slippage
   */
  private async createPositionTransactionWithSlippage(
    positionNft: Keypair,
    liquidityDelta: any,
    addLidTokenAAmount: Decimal,
    addLidTokenBAmount: Decimal,
    poolState: any,
    tokenAProgram: PublicKey,
    attempt: number
  ) {
    try {
      // Convert to integer strings to avoid BN issues
      const tokenAAmountInt = addLidTokenAAmount.floor().toString();
      const tokenBAmountInt = addLidTokenBAmount.floor().toString();

      // Calculate slippage thresholds with increasing buffer for retries
      // Start with 5% buffer, increase by 2% each retry
      const baseSlippageBuffer = new Decimal(1.05); // 5% base buffer
      const retrySlippageBuffer = new Decimal(1 + (attempt - 1) * 0.02); // +2% each retry
      const totalSlippageBuffer = baseSlippageBuffer.mul(retrySlippageBuffer);

      const tokenAAmountThreshold = addLidTokenAAmount.mul(totalSlippageBuffer).floor().toString();
      const tokenBAmountThreshold = addLidTokenBAmount.mul(totalSlippageBuffer).floor().toString();

      console.log(`Creating position transaction with amounts: TokenA=${tokenAAmountInt}, TokenB=${tokenBAmountInt}`);
      console.log(`Slippage thresholds (attempt ${attempt}): TokenA=${tokenAAmountThreshold}, TokenB=${tokenBAmountThreshold}`);
      console.log(`Slippage buffer: ${totalSlippageBuffer.mul(100).sub(100).toFixed(2)}%`);

      return await this.cpAmm.createPositionAndAddLiquidity({
        owner: this.wallet.publicKey,
        pool: this.config.pool,
        positionNft: positionNft.publicKey,
        liquidityDelta,
        maxAmountTokenA: new BN(tokenAAmountInt),
        maxAmountTokenB: new BN(tokenBAmountInt),
        tokenAAmountThreshold: new BN(tokenAAmountThreshold),
        tokenBAmountThreshold: new BN(tokenBAmountThreshold),
        tokenAMint: poolState.tokenAMint,
        tokenBMint: poolState.tokenBMint,
        tokenAProgram,
        tokenBProgram: TOKEN_PROGRAM_ID,
      });
    } catch (error) {
      console.error('Error in createPositionTransactionWithSlippage:', error);
      console.error('TokenA amount:', addLidTokenAAmount.toString());
      console.error('TokenB amount:', addLidTokenBAmount.toString());
      throw error;
    }
  }

  /**
   * Execute the transaction
   */
  private async executeTransaction(
    transaction: Transaction,
    positionNft: Keypair
  ): Promise<string> {
    transaction.feePayer = this.wallet.publicKey;
    transaction.recentBlockhash = (
      await this.connection.getLatestBlockhash()
    ).blockhash;
    transaction.sign(...[this.wallet, positionNft]);

    return await sendAndConfirmTransaction(
      this.connection,
      transaction,
      [this.wallet, positionNft],
      { commitment: "confirmed" }
    );
  }

  async createPositionAndAddLiquidity(maxRetries: number = 3): Promise<LiquidityPositionResult> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`Position creation attempt ${attempt}/${maxRetries}`);

        // Get pool and token information
        const { poolState, tokenAProgram, tokenAInfo } = await this.getPoolAndTokenInfo();

        if (!tokenAInfo) {
          throw new Error("Token A info not found");
        }

        // Validate and sanitize input amounts
        const tokenAAmount = Number(this.config.tokenAAmount);
        const tokenBAmount = Number(this.config.tokenBAmount);

        if (!isFinite(tokenAAmount) || tokenAAmount <= 0) {
          throw new Error(`Invalid tokenAAmount: ${this.config.tokenAAmount}`);
        }
        if (!isFinite(tokenBAmount) || tokenBAmount <= 0) {
          throw new Error(`Invalid tokenBAmount: ${this.config.tokenBAmount}`);
        }

        // Adjust amounts slightly for retries to handle precision issues
        const amountReduction = new Decimal(1 - (attempt - 1) * 0.01); // Reduce by 1% each retry
        let addLidTokenAAmount = this.config.tokenAAmount.mul(amountReduction);
        let addLidTokenBAmount = this.config.tokenBAmount.mul(amountReduction);

        console.log(`Creating position with amounts: TokenA=${addLidTokenAAmount.toString()}, TokenB=${addLidTokenBAmount.toString()}`);

        // Generate position NFT
        const positionNft = Keypair.generate();

        // Calculate liquidity delta
        const liquidityDelta = this.calculateLiquidityDelta(
          addLidTokenAAmount,
          addLidTokenBAmount,
          poolState,
          tokenAInfo
        );

        // Create position transaction with retry-specific slippage
        const createPositionTx = await this.createPositionTransactionWithSlippage(
          positionNft,
          liquidityDelta,
          addLidTokenAAmount,
          addLidTokenBAmount,
          poolState,
          tokenAProgram,
          attempt
        );

        // Build and execute transaction
        const transaction = new Transaction();
        transaction.add(...createPositionTx.instructions);

        const signature = await this.executeTransaction(transaction, positionNft);

        console.log(`Position created successfully on attempt ${attempt}`);
        return {
          position: derivePositionAddress(positionNft.publicKey).toString(),
          positionNft: positionNft.publicKey.toString(),
          signature,
        };
      } catch (error) {
        lastError = error as Error;
        console.error(`Position creation attempt ${attempt} failed:`, error);

        if (attempt < maxRetries) {
          console.log(`Retrying position creation in 2 seconds...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }

    throw new Error(`Position creation failed after ${maxRetries} attempts. Last error: ${lastError?.message}`);
  }

  /**
   * Get wallet public key
   */
  getWalletPublicKey(): PublicKey {
    return this.wallet.publicKey;
  }

  /**
   * Get connection instance
   */
  getConnection(): Connection {
    return this.connection;
  }

  /**
   * Get CpAmm instance
   */
  getCpAmm(): CpAmm {
    return this.cpAmm;
  }

  async getAllPostionPoolbyUser(): Promise<Array<{ positionNftAccount: PublicKey; position: PublicKey; positionState: PositionState }>> {
    const positionAccounts = await this.cpAmm.getUserPositionByPool(this.config.pool, this.wallet.publicKey);
    console.log(`User has ${positionAccounts.length} positions in this pool`);
    return positionAccounts;
  }
}
