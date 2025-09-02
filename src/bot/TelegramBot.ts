import TelegramBot from 'node-telegram-bot-api';
import { Connection, clusterApiUrl, PublicKey } from '@solana/web3.js';
import { LiquidityPoolManager, PoolConfig } from '../LiquidityPoolManager';
import { ZapOutManager, ZapOutConfig, PoolType } from '../ZapOutManager';
import { SwapManager } from '../utils/swapUtils';
import { getProfileTokenAddress, getTokenTrending, TokenProfile, TokenUtils, TPoolLabel, TrendingType } from '../utils/tokenUtils';
import * as cron from 'node-cron';
import { SOLANA_MINT } from '../constants';
import { CpAmm, getUnClaimReward, PositionState, getAmountAFromLiquidityDelta, getAmountBFromLiquidityDelta, Rounding } from '@meteora-ag/cp-amm-sdk';
import Decimal from 'decimal.js';
import "dotenv/config"
import { BN } from '@coral-xyz/anchor';

export interface BotConfig {
  telegramToken: string;
  chatId: string;
  privateKey: string;
  rpcUrl: string;
  swapUrl: string;
}

export interface Position {
  pool: string;
  vested_liquidity?: string,
  unlocked_liquidity?: string,
  permanent_locked_liquidity?: string,
  fee_a?: string
  fee_b?: string,
  positionState?: PositionState
}

export class MeteoraBot {
  private bot: any;
  private config: BotConfig;
  private connection: Connection;
  private swapManager: SwapManager;
  private tokenUtils: TokenUtils;
  private scheduledJobs: cron.ScheduledTask[] = [];
  private cpAmm: CpAmm;

  constructor(config: BotConfig) {
    this.config = config;
    this.bot = new TelegramBot(config.telegramToken, { polling: true });
    this.connection = new Connection(config.rpcUrl);
    this.swapManager = new SwapManager(config.privateKey, config.rpcUrl, config.swapUrl);
    this.tokenUtils = new TokenUtils(this.connection);
    this.cpAmm = new CpAmm(this.connection);
  }

  private async initializeBot() {
    try {
      await this.setupCommands();
      console.log('✅ Bot commands and jobs initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize bot:', error);
      throw error;
    }
  }

  private async setupCommands() {
    // Set bot commands for Telegram menu
    await this.bot.setMyCommands([
      { command: 'help', description: 'Show all available commands' },

      { command: 'positions', description: 'View all LP positions' },
      { command: 'balance', description: 'Check token balances' },
      { command: 'trending', description: 'Get trending tokens (5m)' },
      { command: 'status', description: 'Bot status and info' },
      { command: 'wallet', description: 'Show wallet address' },
      { command: 'start_auto', description: 'Start automated trading' },
      { command: 'stop_auto', description: 'Stop automated trading' },
      { command: 'clear_all', description: 'Clear all positions' },
    ]);

    // Help command
    this.bot.onText(/\/help/, (msg: any) => {
      const helpText = `<b>🤖 LP Trading Bot Commands</b>

<b>📊 Portfolio Commands:</b>
/positions - View all LP positions
/balance - Check token balances

<b>⚡ Quick Actions:</b>
/trending - Get trending tokens (5m)
/clear_all - Clear all positions (zapout)

<b>⚙️ Automation:</b>
/start_auto - Start automated trading
/stop_auto - Stop automated trading
/status - Bot status

<b>📋 Info:</b>
/wallet - Show wallet address
/help - Show this help`;
      this.sendMessage(helpText);
    });

    // Positions command
    this.bot.onText(/\/positions/, async (msg: any) => {
      try {
        await this.handlePositionsCommand();
      } catch (error) {
        this.sendMessage(`❌ Error getting positions: ${error}`);
      }
    });

    // Balance command
    this.bot.onText(/\/balance/, async (msg: any) => {
      try {
        await this.handleBalanceCommand();
      } catch (error) {
        this.sendMessage(`❌ Error getting balance: ${error}`);
      }
    });

    // // Create position command
    // this.bot.onText(/\/create_position (.+) (.+) (.+)/, async (msg: any, match: any) => {
    //   try {
    //     if (!match) return;
    //     const [, tokenA, tokenB, amount] = match;
    //     await this.handleCreatePositionCommand(tokenA, tokenB, parseFloat(amount));
    //   } catch (error) {
    //     this.sendMessage(`❌ Error creating position: ${error}`);
    //   }
    // });

    // // Zap out command
    // this.bot.onText(/\/zap_out (.+) (.+)/, async (msg: any, match: any) => {
    //   try {
    //     if (!match) return;
    //     const [, poolAddress, percentage] = match;
    //     await this.handleZapOutCommand(poolAddress, parseFloat(percentage));
    //   } catch (error) {
    //     this.sendMessage(`❌ Error zapping out: ${error}`);
    //   }
    // });

    // Trending command
    this.bot.onText(/\/trending/, async (msg: any) => {
      try {
        await this.handleTrendingCommand();
      } catch (error) {
        this.sendMessage(`❌ Error getting trending tokens: ${error}`);
      }
    });

    // Clear all positions
    this.bot.onText(/\/clear_all/, async (msg: any) => {
      try {
        await this.handleClearAllCommand();
      } catch (error) {
        this.sendMessage(`❌ Error clearing positions: ${error}`);
      }
    });

    // Automation commands
    this.bot.onText(/\/start_auto/, async (msg: any) => {
      this.startAutomation();
      this.sendMessage("🤖 Automated trading started!");
    });

    this.bot.onText(/\/stop_auto/, async (msg: any) => {
      this.stopAutomation();
      this.sendMessage("⏹️ Automated trading stopped!");
    });

    // Status command
    this.bot.onText(/\/status/, async (msg: any) => {
      const status = this.getStatus();
      this.sendMessage(status);
    });

    // Wallet command
    this.bot.onText(/\/wallet/, async (msg: any) => {
      const walletAddress = this.swapManager.getWalletPublicKey().toString();
      this.sendMessage(`💳 <b>Wallet Address:</b>\n<code>${walletAddress}</code>`);
    });
  }

  private async handlePositionsCommand() {
    this.sendMessage("📊 Fetching positions...");
    const positions = await this.getAllPoolPostions();

    if (positions.length === 0) {
      this.sendMessage("📭 No positions found.");
      return;
    }

    let message = `<b>📊 Your LP Positions</b>\n\n`;
    for (const position of positions) {

      const poolState = await this.cpAmm.fetchPoolState(new PublicKey(position.pool as string));
      const amountA = getAmountAFromLiquidityDelta(
        new BN(position.unlocked_liquidity ?? '0'),
        poolState.sqrtPrice,
        poolState.sqrtMaxPrice,
        Rounding.Down
      );
      const amountB = getAmountBFromLiquidityDelta(
        new BN(position.unlocked_liquidity ?? '0'),
        poolState.sqrtPrice,
        poolState.sqrtMinPrice,
        Rounding.Down
      );

      const unclaimed = getUnClaimReward(poolState, position.positionState as PositionState);
      const feeDecimalsA = await this.tokenUtils.getTokenDecimals(poolState.tokenAMint);
      const feeDecimalsB = await this.tokenUtils.getTokenDecimals(poolState.tokenBMint);

      const tokenAMintStr = poolState.tokenAMint.toBase58();
      const tokenBMintStr = poolState.tokenBMint.toBase58();

      // Format deposit amounts to UI with decimals
      const amountAUi = new Decimal(amountA.toString())
        .div(new Decimal(10).pow(feeDecimalsA))
        .toFixed(Math.min(feeDecimalsA, 6));
      const amountBUi = new Decimal(amountB.toString())
        .div(new Decimal(10).pow(feeDecimalsB))
        .toFixed(Math.min(feeDecimalsB, 6));

      const feeAUi = new Decimal(unclaimed.feeTokenA.toString())
        .div(new Decimal(10).pow(feeDecimalsA))
        .toFixed(Math.min(feeDecimalsA, 6));
      const feeBUi = new Decimal(unclaimed.feeTokenB.toString())
        .div(new Decimal(10).pow(feeDecimalsB))
        .toFixed(Math.min(feeDecimalsB, 6));

      message += `🔒 Pool: <code>${position.pool}</code>\n`;
      message += `• Deposit: <b>${amountAUi}</b> ${tokenAMintStr.slice(0, 6)}… + <b>${amountBUi}</b> ${tokenBMintStr.slice(0, 6)}…\n`;
      message += `• Unclaimed Fees: <b>${feeAUi}</b> ${tokenAMintStr.slice(0, 6)}… | <b>${feeBUi}</b> ${tokenBMintStr.slice(0, 6)}…\n`;
      message += `\n`;
    }
    this.sendMessage(message);
  }

  private async handleBalanceCommand() {
    this.sendMessage("💳 Fetching balances...");
    const allHolderTokens = await this.tokenUtils.getWalletTokens(this.swapManager.getWalletPublicKey());
    const nativeToken = await this.tokenUtils.getTokenBalanceFormattedAuto(this.swapManager.getWalletPublicKey(), new PublicKey(SOLANA_MINT));

    let message = "💳 *Token Balances:*\n\n";
    for (const [token, balance] of allHolderTokens.entries()) {
      message += `${token}: ${balance.formatted}\n`;
    }

    message += `\n`;
    message += `Native Token: ${nativeToken.formatted}\n`;
    this.sendMessage(message);
  }

  private async handleCreatePositionCommand(tokenA: string, tokenB: string, amount: number) {
    this.sendMessage(`🔄 Creating position: ${amount} ${tokenA}/${tokenB}...`);

    try {

      this.sendMessage(`✅ Position created successfully!\nTokens: ${tokenA}/${tokenB}\nAmount: ${amount}`);
    } catch (error) {
      throw new Error(`Failed to create position: ${error}`);
    }
  }

  private async handleZapOutCommand(poolAddress: string, percentage: number = 100) {
    this.sendMessage(`⚡ Zapping out ${percentage}% from pool: ${poolAddress.slice(0, 8)}...`);

    try {
      const zapOutConfig: ZapOutConfig = {
        privateKey: this.config.privateKey,
        rpcUrl: this.config.rpcUrl,
        inputMint: new PublicKey("So11111111111111111111111111111111111111112"), // SOL
        outputMint: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), // USDC
        poolAddress: new PublicKey(poolAddress),
        poolType: PoolType.DAMM_V2, // You'd determine this dynamically
        percentageToZapOut: percentage,
        slippage: 50,
      };

      const zapOutManager = new ZapOutManager(zapOutConfig);
      const result = await zapOutManager.executeZapOut();

      const zapOutMessage = `✅ Zap out completed!
Best Protocol: ${result.bestProtocol}
${this.createSolscanLink(result.signature)}`;
      this.sendMessage(zapOutMessage);
    } catch (error) {
      throw new Error(`Failed to zap out: ${error}`);
    }
  }

  private async handleTrendingCommand() {
    this.sendMessage("🔥 Fetching trending tokens...");

    try {
      const trendingTokens = await this.getTrendingTokens();

      let message = "🔥 *Trending Tokens (5m):*\n\n";
      trendingTokens.slice(0, 10).forEach((token, index) => {
        message += `${index + 1}. ${token.symbol} - ${token.priceChange.h24}%\n`;
        message += `   Price: $${token.priceUsd}\n`;
        message += `   Volume: $${token.volume.h24}\n\n`;
      });

      this.sendMessage(message);
    } catch (error) {
      throw new Error(`Failed to get trending tokens: ${error}`);
    }
  }

  private async handleClearAllCommand() {
    this.sendMessage("🧹 Clearing all positions...");

    try {
      const positions = await this.getAllPoolPostions();
      let cleared = 0;

      for (const position of positions) {
        try {
          // Zap out from each position
          await this.zapOutPosition(position.pool);
          cleared++;
        } catch (error) {
          console.error(`Failed to clear position ${position.pool}:`, error);
        }
      }

      this.sendMessage(`✅ Cleared ${cleared}/${positions.length} positions successfully!`);
    } catch (error) {
      throw new Error(`Failed to clear positions: ${error}`);
    }
  }

  private setupScheduledJobs() {
    // Automated trading job - runs every 5 minutes
    const autoTradingJob = cron.schedule(process.env.CRON_SCHEDULE || "*/30 * * * *", async () => {
      try {
        await this.executeAutomatedTrading();
      } catch (error) {
        console.error('Automated trading error:', error);
        this.sendMessage(`⚠️ Automated trading error: ${error}`);
      }
    }, { scheduled: false });

    this.scheduledJobs.push(autoTradingJob);
  }

  private async executeAutomatedTrading() {
    this.sendMessage("🤖 Starting automated trading cycle...");

    const MAX_TRENDING_COUNT = parseInt(process.env.MAX_TRENDING_COUNT || "5"); // 5 or 10
    const MAX_SOL_PER_TOKEN = parseFloat(process.env.MAX_SOL_PER_TOKEN || "0.1");

    try {
      // 1. Get current trending tokens
      const trending = await this.getTrendingTokens();
      const validTrending = trending.filter(token => this.isValidToken(token)).slice(0, MAX_TRENDING_COUNT);

      if (validTrending.length === 0) {
        this.sendMessage("⚠️ No valid trending tokens found");
        return;
      }

      // 2. Get current positions and extract token addresses
      const currentPositions = await this.getAllPoolPostions();
      const currentPool = new Set();
      for (const pos of currentPositions) {
        // const tokenAddress = await this.getTokenFromPool(pos.pool);
        // if (tokenAddress) currentTokens.add(tokenAddress);
        currentPool.add(pos.pool);
      }

      const trendingTokens = new Set(validTrending.map(token => token.pairAddress));



      // 3. ZapOut tokens no longer in trending
      const poolRemove = Array.from(currentPool).filter(token => !trendingTokens.has(token as string));
      if (poolRemove.length > 0) {
        this.sendMessage(`🗑️ Removing ${poolRemove.length} outdated positions...`);
        for (const pool of poolRemove) {
          try {
            // const position = currentPositions.find(pos => this.getTokenFromPoolSync(pos.pool) === tokenAddress);
            // if (position) {
            await this.zapOutPosition(pool as string);
            this.sendMessage(`✅ Zapped out from ${(pool as string).slice(0, 8)}...`);
          } catch (error) {
            console.error(`Failed to zap out ${pool}:`, error);
            this.sendMessage(`❌ Zapped out from ${(pool as string).slice(0, 8)}...`);

          }
        }
        await new Promise(resolve => setTimeout(resolve, 3000));
      }

      // 4. Calculate SOL allocation per token
      const solBalance = await this.tokenUtils.getTokenBalanceFormattedAuto(
        this.swapManager.getWalletPublicKey(),
        new PublicKey(SOLANA_MINT)
      );


      // 5. Create positions for new trending tokens
      const tokensToAdd = validTrending.filter(token => !currentPool.has(token.pairAddress));

      let total_position = 0;
      if (tokensToAdd.length > 0) {
        const availableSol = Number(solBalance.formatted) * 0.989; // Use 96% of balance
        const solPerToken = Math.min(availableSol / tokensToAdd.length, MAX_SOL_PER_TOKEN);

        this.sendMessage(`📊 <b>Trading Plan:</b>
  Trending tokens: ${tokensToAdd.length}
  Available SOL: ${availableSol.toFixed(4)}
  SOL per token: ${solPerToken.toFixed(4)}`);
        this.sendMessage(`🚀 Creating ${tokensToAdd.length} new positions...`);
        for (const token of tokensToAdd) {
          try {
            await this.createAutomatedPosition(token, solPerToken);
            this.sendMessage(`✅ Position created for ${token.symbol}`);
            total_position += 1
            await new Promise(resolve => setTimeout(resolve, 3000)); // Wait between positions
          } catch (error) {
            this.sendMessage(`❌ Failed to create position for ${token.symbol}: ${error}`);
          }
        }

        // 6. Summary
        this.sendMessage(`🎯 <b>Trading cycle completed!</b>
        Active positions: ${total_position}
        Total SOL used: ${(tokensToAdd.length * solPerToken).toFixed(4)}`);
      }
      else {
        this.sendMessage(`🎯 <b>Trading cycle completed!</b>
        No new positions to create`);
      }



    } catch (error) {
      this.sendMessage(`❌ Automated trading error: ${error}`);
    }
  }

  private startAutomation() {
    if (!this.scheduledJobs || this.scheduledJobs.length === 0) {
      this.setupScheduledJobs();
    }
    this.scheduledJobs.forEach(job => job.start());
  }

  private stopAutomation() {
    this.scheduledJobs.forEach(job => job.stop());
  }

  private getStatus(): string {
    const walletAddress = this.swapManager.getWalletPublicKey().toString();
    return `<b>🤖 Bot Status</b>

Status: 🟢 Running
Wallet: <code>${walletAddress}</code>
RPC: ${this.config.rpcUrl}
Scheduled Jobs: ${this.scheduledJobs.length}`;
  }

  private sendMessage(text: string) {
    try {
      // Try HTML format first (more reliable than MarkdownV2)
      this.bot.sendMessage(this.config.chatId, text, {
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });
    } catch (error) {
      console.error('Failed to send HTML message:', error);
      // Fallback to plain text
      try {
        this.bot.sendMessage(this.config.chatId, text);
      } catch (fallbackError) {
        console.error('Failed to send fallback message:', fallbackError);
      }
    }
  }

  private createSolscanLink(signature: string): string {
    return `<a href="https://solscan.io/tx/${signature}">View on Solscan</a>`;
  }

  private createDexScreenerLink(tokenAddress: string, symbol?: string): string {
    const displayText = symbol ? `${symbol} on DexScreener` : 'View on DexScreener';
    return `<a href="https://dexscreener.com/solana/${tokenAddress}">${displayText}</a>`;
  }

  private createPoolLink(poolAddress: string): string {
    return `<a href="https://dexscreener.com/solana/${poolAddress}">Pool on DexScreener</a>`;
  }

  // Helper methods - implement these based on your needs
  private async getAllPoolPostions(): Promise<Position[]> {
    // fixed damv2
    const cpAmm = new CpAmm(this.connection);
    const postions = await cpAmm.getPositionsByUser(this.swapManager.getWalletPublicKey());

    return postions.map(item => ({
      pool: item?.positionState?.pool.toBase58(),
      vested_liquidity: item?.positionState?.vestedLiquidity.toString(),
      fee_a: item?.positionState?.metrics?.totalClaimedAFee?.toString(),
      fee_b: item?.positionState?.metrics?.totalClaimedBFee?.toString(),
      unlocked_liquidity: item?.positionState?.unlockedLiquidity.toString(),
      permanent_locked_liquidity: item?.positionState?.permanentLockedLiquidity.toString(),
      positionState: item?.positionState,
    }))
  }

  private async getTrendingTokens(timeframe: TrendingType = TrendingType.TRENDING_5M): Promise<TokenProfile[]> {
    try {
      const data = await getTokenTrending(timeframe);
      const filterData = data.filter(item => item.labels === TPoolLabel.DYN2 && item.base === SOLANA_MINT);
      const quoteAddresses = Array.from(new Set(filterData.map(item => item.quote).filter(Boolean)));

      if (quoteAddresses.length === 0) return [];

      const chunkSize = 30;
      const chunks: string[][] = [];
      for (let i = 0; i < quoteAddresses.length; i += chunkSize) {
        chunks.push(quoteAddresses.slice(i, i + chunkSize));
      }

      const profilesBatches = await Promise.all(chunks.map(addresses => getProfileTokenAddress(addresses)));
      const profiles = profilesBatches.flat();

      return profiles;
    } catch (error) {
      console.error('Error fetching trending tokens:', error);
      return [];
    }
  }

  private async findFirstDammV2Pool(tokens: TokenProfile[]): Promise<TokenProfile | null> {
    for (const token of tokens) {
      if (Number(token.volume.h24) / Number(token.liquidity.usd) >= 1) {
        return token;
      }
    }
    return null;
  }

  private isValidToken(token: TokenProfile): boolean {
    // Filter criteria for valid tokens
    return (
      // token.volume.h24 > 10000 && // Min volume $10k
      // token.liquidity.usd > 5000 && // Min liquidity $5k
      Number(token.volume.h24) / Number(token.liquidity.usd) >= 1
      // token.priceUsd > 0 // Valid price
    );
  }

  private async getTokenFromPool(poolAddress: string): Promise<string | null> {
    try {
      const poolState = await this.cpAmm.fetchPoolState(new PublicKey(poolAddress));
      // Return the non-SOL token address (tokenA if tokenB is SOL, otherwise tokenA)
      if (poolState.tokenBMint.toBase58() === SOLANA_MINT) {
        return poolState.tokenAMint.toBase58();
      } else {
        return poolState.tokenAMint.toBase58();
      }
    } catch (error) {
      console.error(`Failed to get token from pool ${poolAddress}:`, error);
      return null;
    }
  }

  private getTokenFromPoolSync(poolAddress: string): string | null {
    // Synchronous version - you might need to cache pool states
    // For now, return null and handle async version
    return null;
  }

  private async createAutomatedPosition(token: TokenProfile, maxSolAmount?: number): Promise<void> {
    // Implement automated position creation
    // fetch the sol balance and swap we should split 2 parts, swap and create liquid
    try {
      let usableBalance: number;

      if (maxSolAmount) {
        // Use provided SOL amount
        usableBalance = maxSolAmount;
      } else {
        // Fallback to old logic
        const solBalance = await this.tokenUtils.getTokenBalanceFormattedAuto(this.swapManager.getWalletPublicKey(), new PublicKey("So11111111111111111111111111111111111111112"));
        usableBalance = Math.min(Number(solBalance.formatted), 1);
      }

      const swapAmount = usableBalance * 0.45;

      // Convert SOL amount to lamports (integer)
      const swapAmountLamports = Math.floor(swapAmount * 1e9);
      console.log({ swapAmount, swapAmountLamports });

      const swapResult = await this.swapManager.swapTokens({
        inputMint: new PublicKey(SOLANA_MINT),
        outputMint: new PublicKey(token.address),
        amount: swapAmountLamports,
        privateKey: this.config.privateKey,
        rpcUrl: this.config.rpcUrl,
        maxAccounts: 30,
        slippage: 50,
      });
      const swapMessage = `✅ Swapped ${swapAmount} SOL to ${token.symbol}
Amount: ${swapResult.outputAmount}
${this.createSolscanLink(swapResult.signature)}
${this.createDexScreenerLink(token.address, token.symbol)}`;
      await this.sendMessage(swapMessage);
      const tokenDecimals = await this.tokenUtils.getTokenDecimals(new PublicKey(token.address))

      // Parse the output amount properly using Decimal for precision
      const outputTokenAmountRaw = new Decimal(swapResult.outputAmount);
      const tokenDecimalsPower = new Decimal(10).pow(tokenDecimals);
      const outputTokenAmount = outputTokenAmountRaw.div(tokenDecimalsPower);
      const remainingSolAmount = new Decimal(usableBalance).minus(new Decimal(swapAmount));

      console.log({
        totalSolBalance: Number(usableBalance),
        usableBalance,
        swapAmount,
        swapAmountLamports,
        outputTokenAmountRaw: outputTokenAmountRaw.toString(),
        outputTokenAmount: outputTokenAmount.toString(),
        remainingSolAmount: remainingSolAmount.toString(),
        tokenDecimals
      });

      // create Lidquidity position
      const CONFIG: PoolConfig = {
        privateKey: this.config.privateKey,
        rpcUrl: this.config.rpcUrl,
        pool: new PublicKey(token.pairAddress),
        tokenADecimals: tokenDecimals,
        tokenBDecimals: 9,
        tokenAAmount: outputTokenAmount.toNumber(),
        tokenBAmount: Math.min(remainingSolAmount.toNumber(), 0.5)
      };
      // Create liquidity pool manager instance
      const liquidityManager = new LiquidityPoolManager(CONFIG);
      const liquidityResult = await liquidityManager.createPositionAndAddLiquidity();
      const positionMessage = `✅ Automated position created for ${token.symbol}
Position: ${liquidityResult.position}
${this.createSolscanLink(liquidityResult.signature)}
${this.createPoolLink(token.pairAddress)}`;
      await this.sendMessage(positionMessage);
    } catch (error) {
      throw new Error(`Failed to create automated position: ${error}`);
    }
  }

  private async zapOutPosition(poolAddress: string, poolType: PoolType = PoolType.DAMM_V2): Promise<void> {
    // Implement position zap out
    const poolConfig = await this.cpAmm.fetchPoolState(new PublicKey(poolAddress));
    const zapOutConfig: ZapOutConfig = {
      privateKey: this.config.privateKey,
      rpcUrl: this.config.rpcUrl,
      poolAddress: new PublicKey(poolAddress),
      poolType: poolType,
      percentageToZapOut: 100,
      slippage: 50,
      inputMint: poolConfig.tokenAMint,
      outputMint: poolConfig.tokenBMint,
    };
    const zapOutManager = new ZapOutManager(zapOutConfig);
    const result = await zapOutManager.executeZapOut();
    const zapOutMessage = `✅ Zap out completed!
Best Protocol: ${result.bestProtocol}
${this.createSolscanLink(result.signature)}`;
    await this.sendMessage(zapOutMessage);
  }

  public async start() {
    try {
      await this.initializeBot();
      console.log('Meteora Telegram Bot started!');
      this.sendMessage("🚀 LP Trading Bot is online!");
    } catch (error) {
      console.error('Failed to start bot:', error);
      throw error;
    }
  }

  public stop() {
    this.stopAutomation();
    this.bot.stopPolling();
    console.log('Bot stopped!');
  }
}
