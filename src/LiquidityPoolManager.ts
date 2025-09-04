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

      console.log(`Creating position transaction with amounts: TokenA=${tokenAAmountInt}, TokenB=${tokenBAmountInt}`);

      return await this.cpAmm.createPositionAndAddLiquidity({
        owner: this.wallet.publicKey,
        pool: this.config.pool,
        positionNft: positionNft.publicKey,
        liquidityDelta,
        maxAmountTokenA: new BN(tokenAAmountInt),
        maxAmountTokenB: new BN(tokenBAmountInt),
        tokenAAmountThreshold: new BN(tokenAAmountInt),
        tokenBAmountThreshold: new BN(tokenBAmountInt),
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

  async createPositionAndAddLiquidity(): Promise<LiquidityPositionResult> {
    try {
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

      console.log(`Creating position with amounts: TokenA=${tokenAAmount}, TokenB=${tokenBAmount.}`);

      let addLidTokenAAmount = this.config.tokenAAmount;
      let addLidTokenBAmount = this.config.tokenBAmount;

      // Generate position NFT
      const positionNft = Keypair.generate();

      // Calculate liquidity delta
      const liquidityDelta = this.calculateLiquidityDelta(
        addLidTokenAAmount,
        addLidTokenBAmount,
        poolState,
        tokenAInfo
      );

      // Create position transaction
      const createPositionTx = await this.createPositionTransaction(
        positionNft,
        liquidityDelta,
        addLidTokenAAmount,
        addLidTokenBAmount,
        poolState,
        tokenAProgram
      );

      // Build and execute transaction
      const transaction = new Transaction();
      transaction.add(...createPositionTx.instructions);

      const signature = await this.executeTransaction(transaction, positionNft);

      return {
        position: derivePositionAddress(positionNft.publicKey).toString(),
        positionNft: positionNft.publicKey.toString(),
        signature,
      };
    }
    catch (e) {
      console.error(`Error creating position and adding liquidity: ${e}`);
      throw new Error(`Error creating position and adding liquidity: ${e}`);
    }
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
