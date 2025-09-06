import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { CpAmm, getAmountAFromLiquidityDelta, getAmountBFromLiquidityDelta, getTokenProgram, Rounding, PositionState } from "@meteora-ag/cp-amm-sdk";
import DLMM, { getTokenProgramId } from "@meteora-ag/dlmm";
import { Zap, getJupiterQuote, getJupiterSwapInstruction, DLMM_PROGRAM_ID } from "@meteora-ag/zap-sdk";
import {
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { TokenUtils } from "./utils/tokenUtils";

export enum PoolType {
  DAMM_V2 = "dammV2",
  DLMM = "dlmm"
}

export interface ZapOutConfig {
  privateKey: string;
  rpcUrl: string;
  inputMint: PublicKey;
  outputMint: PublicKey;
  poolAddress: PublicKey; // For DAMM V2, this is the pool address; for DLMM, this is the LB pair address
  poolType: PoolType;
  percentageToZapOut: number; // 1-100
  slippage: number; // in bps, e.g., 50 = 0.5%
}

export interface QuoteResult {
  protocol: string;
  amount: BN;
  error?: string;
}

export interface ZapOutResult {
  bestProtocol: string;
  bestQuote: BN;
  signature: string;
  removedLiquidity: {
    tokenA?: BN;
    tokenB?: BN;
    tokenX?: BN;
    tokenY?: BN;
  };
}

export interface PositionInfo {
  positionNftAccount: PublicKey;
  position: PublicKey;
  positionState: PositionState;
}

export interface DlmmPositionInfo {
  publicKey: PublicKey;
  positionData: any;
}

export class ZapOutManager {
  private connection: Connection;
  private wallet: Keypair;
  private config: ZapOutConfig;
  private cpAmm?: CpAmm;
  private dlmm?: any;
  private zap: Zap;
  private tokenUtils: TokenUtils;

  constructor(config: ZapOutConfig) {
    this.config = config;
    this.connection = new Connection(config.rpcUrl);
    this.wallet = Keypair.fromSecretKey(bs58.decode(config.privateKey));
    this.zap = new Zap(this.connection);
    this.tokenUtils = new TokenUtils(this.connection);
    this.initializePoolSDK().then(() => {
      console.log("Pool SDK initialized");
    });
  }

  private async initializePoolSDK(): Promise<void> {
    if (this.config.poolType === PoolType.DAMM_V2) {
      this.cpAmm = new CpAmm(this.connection);
    } else if (this.config.poolType === PoolType.DLMM) {
      this.dlmm = await DLMM.create(this.connection, this.config.poolAddress, {
        cluster: "mainnet-beta",
        programId: new PublicKey(DLMM_PROGRAM_ID),
      });
    } else {
      throw new Error(`Unsupported pool type: ${this.config.poolType}`);
    }
  }

  private async getPoolTokenDecimals(): Promise<{ tokenADecimal: number; tokenBDecimal: number }> {
    if (this.config.poolType === PoolType.DAMM_V2 && this.cpAmm) {
      const poolState = await this.cpAmm.fetchPoolState(this.config.poolAddress);
      const [tokenADecimal, tokenBDecimal] = await this.tokenUtils.getMultipleTokenDecimals([
        { mint: poolState.tokenAMint, program: getTokenProgram(poolState.tokenAFlag) },
        { mint: poolState.tokenBMint, program: getTokenProgram(poolState.tokenBFlag) }
      ]);
      return { tokenADecimal, tokenBDecimal };
    } else if (this.config.poolType === PoolType.DLMM && this.dlmm) {
      const tokenPrograms = getTokenProgramId(this.dlmm.lbPair);
      const [tokenADecimal, tokenBDecimal] = await this.tokenUtils.getMultipleTokenDecimals([
        { mint: this.dlmm.lbPair.tokenXMint, program: tokenPrograms.tokenXProgram },
        { mint: this.dlmm.lbPair.tokenYMint, program: tokenPrograms.tokenYProgram }
      ]);
      return { tokenADecimal, tokenBDecimal };
    }

    // Fallback - shouldn't reach here if SDK is initialized properly
    throw new Error("Pool SDK not initialized");
  }

  /**
   * Get user positions for DAMM V2 pools
   */
  private async getDammV2Positions(): Promise<PositionInfo[]> {
    if (!this.cpAmm) {
      throw new Error("CpAmm not initialized");
    }

    const positions = await this.cpAmm.getUserPositionByPool(
      this.config.poolAddress,
      this.wallet.publicKey
    );

    if (positions.length === 0) {
      throw new Error("No positions found for this user in DAMM V2 pool");
    }

    return positions;
  }

  /**
   * Get user positions for DLMM pools
   */
  private async getDlmmPositions(): Promise<DlmmPositionInfo[]> {
    if (!this.dlmm) {
      throw new Error("DLMM not initialized");
    }

    const { userPositions } = await this.dlmm.getPositionsByUserAndLbPair(
      this.wallet.publicKey
    );

    if (userPositions.length === 0) {
      throw new Error("No positions found for this user in DLMM pool");
    }

    return userPositions;
  }

  private async removeDammV2Liquidity(): Promise<{
    transaction: Transaction;
    amountARemoved: BN;
    amountBRemoved: BN;
  }> {
    if (!this.cpAmm) {
      throw new Error("CpAmm not initialized");
    }

    const positions = await this.getDammV2Positions();
    const poolState = await this.cpAmm.fetchPoolState(this.config.poolAddress);
    const currentSlot = await this.connection.getSlot();
    const currentTime = await this.connection.getBlockTime(currentSlot);

    // Use the first position (you might want to handle multiple positions differently)
    const position = positions[0];
    const liquidityToRemove = position.positionState.unlockedLiquidity
    // .mul(new BN(this.config.percentageToZapOut))
    // .div(new BN(100));

    const amountARemoved = getAmountAFromLiquidityDelta(
      liquidityToRemove,
      poolState.sqrtPrice,
      poolState.sqrtMaxPrice,
      Rounding.Down
    );

    const amountBRemoved = getAmountBFromLiquidityDelta(
      liquidityToRemove,
      poolState.sqrtPrice,
      poolState.sqrtMinPrice,
      Rounding.Down
    );

    // const removeLiquidityTx = await this.cpAmm.removeLiquidity({
    //   owner: this.wallet.publicKey,
    //   pool: this.config.poolAddress,
    //   position: position.position,
    //   positionNftAccount: position.positionNftAccount,
    //   liquidityDelta: liquidityToRemove,
    //   tokenAAmountThreshold: new BN(0.5),
    //   tokenBAmountThreshold: new BN(0.5),
    //   tokenAMint: poolState.tokenAMint,
    //   tokenBMint: poolState.tokenBMint,
    //   tokenAVault: poolState.tokenAVault,
    //   tokenBVault: poolState.tokenBVault,
    //   tokenAProgram: getTokenProgram(poolState.tokenAFlag),
    //   tokenBProgram: getTokenProgram(poolState.tokenBFlag),
    //   vestings: [],
    //   currentPoint: new BN(currentTime ?? 0),
    // });

    const removeLiquidityTx = await this.cpAmm.removeAllLiquidityAndClosePosition({
      owner: this.wallet.publicKey, // The owner of the position
      position: position.position, // The position address
      positionNftAccount: position.positionNftAccount, // The position NFT account
      positionState: position.positionState, // The current position state
      poolState: poolState, // The current pool state
      tokenAAmountThreshold: new BN(0.5), // Minimum acceptable token A amount (slippage protection)
      tokenBAmountThreshold: new BN(0.5), // Minimum acceptable token B amount (slippage protection)
      vestings: [],
      currentPoint: new BN(currentTime ?? 0) // Current timestamp or slot number for vesting calculations
    })

    const transaction = new Transaction();
    transaction.add(removeLiquidityTx);

    return {
      transaction,
      amountARemoved: amountARemoved,
      amountBRemoved: amountBRemoved,
    };
  }

  /**
   * Remove liquidity from DLMM pool
   */
  private async removeDlmmLiquidity(): Promise<{
    transaction: Transaction;
    amountXRemoved: BN;
    amountYRemoved: BN;
  }> {
    if (!this.dlmm) {
      throw new Error("DLMM not initialized");
    }

    const userPositions = await this.getDlmmPositions();

    let totalAmountXRemoved = new BN(0);
    let totalAmountYRemoved = new BN(0);

    // Calculate total amounts in positions
    for (const { positionData } of userPositions) {
      for (const binData of positionData.positionBinData) {
        totalAmountXRemoved = totalAmountXRemoved.add(new BN(binData.positionXAmount));
        totalAmountYRemoved = totalAmountYRemoved.add(new BN(binData.positionYAmount));
      }
    }

    // Calculate amounts to remove based on percentage
    const amountXToRemove = totalAmountXRemoved
      .mul(new BN(this.config.percentageToZapOut))
      .div(new BN(100));
    const amountYToRemove = totalAmountYRemoved
      .mul(new BN(this.config.percentageToZapOut))
      .div(new BN(100));

    const removeLiquidityTxs = await Promise.all(
      userPositions.map(({ publicKey, positionData }) => {
        const binIdsToRemove = positionData.positionBinData.map((bin: any) => bin.binId);
        return this.dlmm.removeLiquidity({
          position: publicKey,
          user: this.wallet.publicKey,
          fromBinId: binIdsToRemove[0],
          toBinId: binIdsToRemove[binIdsToRemove.length - 1],
          bps: new BN(this.config.percentageToZapOut * 100), // Convert percentage to bps
          shouldClaimAndClose: true,
        });
      })
    );

    const transaction = new Transaction();
    removeLiquidityTxs.forEach((tx) => {
      transaction.add(...tx);
    });

    return {
      transaction,
      amountXRemoved: amountXToRemove,
      amountYRemoved: amountYToRemove,
    };
  }

  /**
   * Get quotes from different protocols
   */
  private async getQuotes(inputAmount: BN): Promise<{
    nativeQuote: QuoteResult | null;
    jupiterQuote: QuoteResult | null;
  }> {
    const promises: Promise<QuoteResult | null>[] = [];

    // Get native protocol quote (DAMM V2 or DLMM)
    if (this.config.poolType === PoolType.DAMM_V2 && this.cpAmm) {
      promises.push(
        (async () => {
          try {
            const poolState = await this.cpAmm!.fetchPoolState(this.config.poolAddress);
            const { tokenADecimal, tokenBDecimal } = await this.getPoolTokenDecimals();
            const quote = this.cpAmm!.getQuote({
              inAmount: inputAmount,
              inputTokenMint: this.config.inputMint,
              slippage: this.config.slippage / 100,
              poolState,
              currentTime: await this.connection.getBlockTime(await this.connection.getSlot()) ?? 0,
              currentSlot: await this.connection.getSlot(),
              tokenADecimal,
              tokenBDecimal,
            });
            return {
              protocol: "dammV2",
              amount: quote.swapOutAmount,
            };
          } catch (error: any) {
            return {
              protocol: "dammV2",
              amount: new BN(0),
              error: error.message,
            };
          }
        })()
      );
    } else if (this.config.poolType === PoolType.DLMM && this.dlmm) {
      promises.push(
        this.dlmm
          .getBinArrayForSwap(true, 5)
          .then((binArrays: any) =>
            this.dlmm.swapQuote(inputAmount, true, new BN(this.config.slippage), binArrays)
          )
          .then((quote: any) => ({
            protocol: "dlmm",
            amount: quote.outAmount,
          }))
          .catch((error: any) => ({
            protocol: "dlmm",
            amount: new BN(0),
            error: error.message,
          }))
      );
    } else {
      promises.push(Promise.resolve(null));
    }

    // Get Jupiter quote
    promises.push(
      getJupiterQuote(
        this.config.inputMint,
        this.config.outputMint,
        inputAmount,
        10,
        this.config.slippage,
        true,
        true,
        true,
        "https://lite-api.jup.ag"
      )
        .then((quote) => ({
          protocol: "jupiter",
          amount: new BN(quote.outAmount),
        }))
        .catch((error) => ({
          protocol: "jupiter",
          amount: new BN(0),
          error: error.message,
        }))
    );

    const [nativeQuote, jupiterQuote] = await Promise.all(promises);

    return {
      nativeQuote,
      jupiterQuote,
    };
  }

  /**
   * Select the best quote from available options
   */
  private selectBestQuote(quotes: {
    nativeQuote: QuoteResult | null;
    jupiterQuote: QuoteResult | null;
  }): { protocol: string; amount: BN } {
    const validQuotes = Object.values(quotes)
      .filter((quote): quote is QuoteResult => quote !== null && !quote.error && quote.amount.gt(new BN(0)));

    if (validQuotes.length === 0) {
      throw new Error("No valid quotes obtained from any protocol");
    }

    // Find the quote with the highest output amount
    const bestQuote = validQuotes.reduce((best, current) =>
      current.amount.gt(best.amount) ? current : best
    );

    return {
      protocol: bestQuote.protocol,
      amount: bestQuote.amount,
    };
  }

  /**
   * Create zap out transaction based on the best protocol
   */
  private async createZapOutTransaction(
    protocol: string,
    inputAmount: BN,
    quotes: { nativeQuote: QuoteResult | null; jupiterQuote: QuoteResult | null }
  ): Promise<any> {
    const inputTokenProgram = await this.getInputTokenProgram();
    const outputTokenProgram = await this.getOutputTokenProgram();

    if (protocol === "dammV2") {
      return await this.zap.zapOutThroughDammV2({
        user: this.wallet.publicKey,
        poolAddress: this.config.poolAddress,
        inputMint: this.config.inputMint,
        outputMint: this.config.outputMint,
        inputTokenProgram,
        outputTokenProgram,
        amountIn: inputAmount,
        minimumSwapAmountOut: new BN(0),
        maxSwapAmount: inputAmount,
        percentageToZapOut: this.config.percentageToZapOut,
      });
    } else if (protocol === "dlmm") {
      return await this.zap.zapOutThroughDlmm({
        user: this.wallet.publicKey,
        lbPairAddress: this.config.poolAddress,
        inputMint: this.config.inputMint,
        outputMint: this.config.outputMint,
        inputTokenProgram,
        outputTokenProgram,
        amountIn: inputAmount,
        minimumSwapAmountOut: new BN(0),
        maxSwapAmount: inputAmount,
        percentageToZapOut: this.config.percentageToZapOut,
      });
    } else if (protocol === "jupiter" && quotes.jupiterQuote && !quotes.jupiterQuote.error) {
      const jupiterQuoteData = await getJupiterQuote(
        this.config.inputMint,
        this.config.outputMint,
        inputAmount,
        10,
        this.config.slippage,
        true,
        true,
        true,
        "https://lite-api.jup.ag"
      );

      const swapInstructionResponse = await getJupiterSwapInstruction(
        this.wallet.publicKey,
        jupiterQuoteData
      );

      return await this.zap.zapOutThroughJupiter({
        user: this.wallet.publicKey,
        inputMint: this.config.inputMint,
        outputMint: this.config.outputMint,
        inputTokenProgram,
        outputTokenProgram,
        jupiterSwapResponse: swapInstructionResponse,
        maxSwapAmount: new BN(jupiterQuoteData.inAmount),
        percentageToZapOut: this.config.percentageToZapOut,
      });
    } else {
      throw new Error(`Invalid protocol selected: ${protocol}`);
    }
  }

  /**
   * Get the appropriate input token program
   */
  private async getInputTokenProgram(): Promise<PublicKey> {
    if (this.config.poolType === PoolType.DAMM_V2 && this.cpAmm) {
      const poolState = await this.cpAmm.fetchPoolState(this.config.poolAddress);
      if (poolState.tokenAMint.equals(this.config.inputMint)) {
        return getTokenProgram(poolState.tokenAFlag);
      } else {
        return getTokenProgram(poolState.tokenBFlag);
      }
    } else if (this.config.poolType === PoolType.DLMM && this.dlmm) {
      const tokenPrograms = getTokenProgramId(this.dlmm.lbPair);
      if (this.dlmm.lbPair.tokenXMint.equals(this.config.inputMint)) {
        return tokenPrograms.tokenXProgram;
      } else {
        return tokenPrograms.tokenYProgram;
      }
    }
    return TOKEN_PROGRAM_ID;
  }

  /**
   * Get the appropriate output token program
   */
  private async getOutputTokenProgram(): Promise<PublicKey> {
    if (this.config.poolType === PoolType.DAMM_V2 && this.cpAmm) {
      const poolState = await this.cpAmm.fetchPoolState(this.config.poolAddress);
      if (poolState.tokenAMint.equals(this.config.outputMint)) {
        return getTokenProgram(poolState.tokenAFlag);
      } else {
        return getTokenProgram(poolState.tokenBFlag);
      }
    } else if (this.config.poolType === PoolType.DLMM && this.dlmm) {
      const tokenPrograms = getTokenProgramId(this.dlmm.lbPair);
      if (this.dlmm.lbPair.tokenXMint.equals(this.config.outputMint)) {
        return tokenPrograms.tokenXProgram;
      } else {
        return tokenPrograms.tokenYProgram;
      }
    }
    return TOKEN_PROGRAM_ID;
  }

  /**
   * Execute the complete zap out process
   */
  async executeZapOut(): Promise<ZapOutResult> {
    console.log(`Starting zap out process for ${this.config.poolType} pool...`);

    let removeLiquidityResult: any;
    let inputAmount: BN;

    if (this.config.poolType === PoolType.DAMM_V2) {
      removeLiquidityResult = await this.removeDammV2Liquidity();
      // Use tokenA amount as input for zap out (you might want to make this configurable)
      inputAmount = removeLiquidityResult.amountARemoved;
    } else {
      removeLiquidityResult = await this.removeDlmmLiquidity();
      // Use tokenX amount as input for zap out (you might want to make this configurable)
      inputAmount = removeLiquidityResult.amountXRemoved;
    }

    console.log("Liquidity removed successfully");

    // Get quotes from different protocols
    console.log("Fetching quotes from protocols...");
    const quotes = await this.getQuotes(inputAmount);

    // Log quote results
    if (quotes.nativeQuote) {
      if (quotes.nativeQuote.error) {
        console.log(`${quotes.nativeQuote.protocol} quote failed:`, quotes.nativeQuote.error);
      } else {
        console.log(`${quotes.nativeQuote.protocol} quote:`, quotes.nativeQuote.amount.toString());
      }
    }

    if (quotes.jupiterQuote) {
      if (quotes.jupiterQuote.error) {
        console.log("Jupiter quote failed:", quotes.jupiterQuote.error);
      } else {
        console.log("Jupiter quote:", quotes.jupiterQuote.amount.toString());
      }
    }

    // Select the best quote
    const bestQuote = this.selectBestQuote(quotes);
    console.log(`Best protocol: ${bestQuote.protocol} with quote:`, bestQuote.amount.toString());

    // Create zap out transaction
    const zapOutTx = await this.createZapOutTransaction(bestQuote.protocol, inputAmount, quotes);

    // Combine remove liquidity and zap out transactions
    const finalTransaction = removeLiquidityResult.transaction;
    finalTransaction.add(zapOutTx);
    console.log({ removeLiquidityResult: removeLiquidityResult.transaction.instructions })

    // Execute the transaction
    const { blockhash } = await this.connection.getLatestBlockhash();
    finalTransaction.recentBlockhash = blockhash;
    finalTransaction.feePayer = this.wallet.publicKey;

    // // Simulate transaction first
    // const simulation = await this.connection.simulateTransaction(finalTransaction);
    // console.log("Transaction simulation logs:", simulation.value.logs);

    // if (simulation.value.err) {
    //   throw new Error(`Transaction simulation failed: ${JSON.stringify(simulation.value.err)}`);
    // }

    console.log("Sending zap out transaction...");
    const signature = await sendAndConfirmTransaction(
      this.connection,
      finalTransaction,
      [this.wallet],
      { commitment: "confirmed" }
    );

    console.log(`Zap out transaction completed: ${signature}`);

    return {
      bestProtocol: bestQuote.protocol,
      bestQuote: bestQuote.amount,
      signature,
      removedLiquidity: this.config.poolType === PoolType.DAMM_V2
        ? {
          tokenA: removeLiquidityResult.amountARemoved,
          tokenB: removeLiquidityResult.amountBRemoved,
        }
        : {
          tokenX: removeLiquidityResult.amountXRemoved,
          tokenY: removeLiquidityResult.amountYRemoved,
        },
    };
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
   * Get user positions for the current pool
   */
  async getUserPositions(): Promise<PositionInfo[] | DlmmPositionInfo[]> {
    await this.initializePoolSDK();

    if (this.config.poolType === PoolType.DAMM_V2) {
      return await this.getDammV2Positions();
    } else {
      return await this.getDlmmPositions();
    }
  }
  async getTokenDecimals(tokenMint: PublicKey, tokenProgram?: PublicKey): Promise<number> {
    return await this.tokenUtils.getTokenDecimals(tokenMint, tokenProgram);
  }

  getTokenUtils(): TokenUtils {
    return this.tokenUtils;
  }
}
