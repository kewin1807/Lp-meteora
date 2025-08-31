import { clusterApiUrl, Connection, PublicKey } from "@solana/web3.js";
import { getMint, TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddress, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import "dotenv/config";
import { CpAmm, PositionState } from "@meteora-ag/cp-amm-sdk";
import { SOLANA_MINT } from "../constants";



export class TokenUtils {
  private connection: Connection;
  private cache: Map<string, number> = new Map();

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Get token decimals with caching to avoid repeated RPC calls
   */
  async getTokenDecimals(
    tokenMint: PublicKey,
    tokenProgram: PublicKey = TOKEN_PROGRAM_ID
  ): Promise<number> {
    const cacheKey = `${tokenMint.toString()}_${tokenProgram.toString()}`;

    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    try {
      const mintInfo = await getMint(
        this.connection,
        tokenMint,
        'confirmed',
        tokenProgram
      );

      this.cache.set(cacheKey, mintInfo.decimals);
      return mintInfo.decimals;
    } catch (error) {
      console.warn(
        `Failed to get decimals for token ${tokenMint.toString()}, defaulting to 6:`,
        error
      );

      // Cache the fallback value to avoid repeated failures
      this.cache.set(cacheKey, 6);
      return 6; // Default fallback for most SPL tokens
    }
  }

  /**
   * Get decimals for multiple tokens in parallel
   */
  async getMultipleTokenDecimals(
    tokens: Array<{ mint: PublicKey; program?: PublicKey }>
  ): Promise<number[]> {
    const promises = tokens.map(({ mint, program = TOKEN_PROGRAM_ID }) =>
      this.getTokenDecimals(mint, program)
    );

    return Promise.all(promises);
  }

  /**
   * Get token info including decimals and supply
   */
  async getTokenInfo(
    tokenMint: PublicKey,
    tokenProgram: PublicKey = TOKEN_PROGRAM_ID
  ): Promise<{
    decimals: number;
    supply: bigint;
    mintAuthority: PublicKey | null;
    freezeAuthority: PublicKey | null;
  }> {
    const cacheKey = `info_${tokenMint.toString()}_${tokenProgram.toString()}`;

    try {
      const mintInfo = await getMint(
        this.connection,
        tokenMint,
        'confirmed',
        tokenProgram
      );

      const result = {
        decimals: mintInfo.decimals,
        supply: mintInfo.supply,
        mintAuthority: mintInfo.mintAuthority,
        freezeAuthority: mintInfo.freezeAuthority,
      };

      this.cache.set(cacheKey, mintInfo.decimals);

      return result;
    } catch (error) {
      console.warn(
        `Failed to get token info for ${tokenMint.toString()}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Clear the cache (useful for testing or if you need fresh data)
   */
  clearCache(): void {
    this.cache.clear();
  }

  getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }

  /**
   * Get token balance for a specific wallet and token mint
   * Supports both TOKEN_PROGRAM_ID and TOKEN_2022_PROGRAM_ID
   */
  async getTokenBalance(
    walletAddress: PublicKey,
    tokenMint: PublicKey,
    tokenProgram: PublicKey = TOKEN_PROGRAM_ID
  ): Promise<bigint> {
    // Native SOL special-case via lamports
    if (tokenMint.toBase58() === SOLANA_MINT) {
      const lamports = await this.connection.getBalance(walletAddress, { commitment: 'confirmed' });
      return BigInt(lamports);
    }
    try {
      const tokenAccount = await getAssociatedTokenAddress(
        tokenMint,
        walletAddress,
        false,
        tokenProgram
      );

      const accountInfo = await getAccount(this.connection, tokenAccount);
      return accountInfo.amount;
    } catch (error) {
      // Token account doesn't exist, return 0 balance
      return BigInt(0);
    }
  }

  /**
   * Get token balance with automatic program detection
   * Tries TOKEN_PROGRAM_ID first, then TOKEN_2022_PROGRAM_ID
   */
  async getTokenBalanceAuto(
    walletAddress: PublicKey,
    tokenMint: PublicKey
  ): Promise<{ balance: bigint; program: PublicKey }> {
    // Native SOL
    if (tokenMint.toBase58() === SOLANA_MINT) {
      const lamports = await this.connection.getBalance(walletAddress, { commitment: 'confirmed' });
      return { balance: BigInt(lamports), program: TOKEN_PROGRAM_ID };
    }
    // Try TOKEN_PROGRAM_ID first
    try {
      const balance = await this.getTokenBalance(walletAddress, tokenMint, TOKEN_PROGRAM_ID);
      if (balance > BigInt(0)) {
        return { balance, program: TOKEN_PROGRAM_ID };
      }
    } catch (error) {
      // Continue to try TOKEN_2022_PROGRAM_ID
    }

    // Try TOKEN_2022_PROGRAM_ID
    try {
      const balance = await this.getTokenBalance(walletAddress, tokenMint, TOKEN_2022_PROGRAM_ID);
      return { balance, program: TOKEN_2022_PROGRAM_ID };
    } catch (error) {
      // Return 0 balance with TOKEN_PROGRAM_ID as default
      return { balance: BigInt(0), program: TOKEN_PROGRAM_ID };
    }
  }

  /**
   * Get multiple token balances for a wallet
   */
  async getMultipleTokenBalances(
    walletAddress: PublicKey,
    tokenMints: PublicKey[],
    tokenProgram: PublicKey = TOKEN_PROGRAM_ID
  ): Promise<Map<string, bigint>> {
    const balances = new Map<string, bigint>();

    const promises = tokenMints.map(async (mint) => {
      try {
        const balance = await this.getTokenBalance(walletAddress, mint, tokenProgram);
        balances.set(mint.toString(), balance);
      } catch (error) {
        console.warn(`Failed to get balance for token ${mint.toString()}:`, error);
        balances.set(mint.toString(), BigInt(0));
      }
    });

    await Promise.all(promises);
    return balances;
  }

  /**
   * Get multiple token balances with automatic program detection
   */
  async getMultipleTokenBalancesAuto(
    walletAddress: PublicKey,
    tokenMints: PublicKey[]
  ): Promise<Map<string, { balance: bigint; program: PublicKey }>> {
    const balances = new Map<string, { balance: bigint; program: PublicKey }>();

    const promises = tokenMints.map(async (mint) => {
      try {
        const result = await this.getTokenBalanceAuto(walletAddress, mint);
        balances.set(mint.toString(), result);
      } catch (error) {
        console.warn(`Failed to get balance for token ${mint.toString()}:`, error);
        balances.set(mint.toString(), { balance: BigInt(0), program: TOKEN_PROGRAM_ID });
      }
    });

    await Promise.all(promises);
    return balances;
  }

  /**
   * Get token balance with decimals formatting
   */
  async getTokenBalanceFormatted(
    walletAddress: PublicKey,
    tokenMint: PublicKey,
    tokenProgram: PublicKey = TOKEN_PROGRAM_ID
  ): Promise<{ raw: bigint; formatted: string; decimals: number }> {
    // Native SOL
    if (tokenMint.toBase58() === SOLANA_MINT) {
      const lamports = await this.connection.getBalance(walletAddress, { commitment: 'confirmed' });
      const decimals = 9;
      const formatted = (lamports / Math.pow(10, decimals)).toFixed(decimals);
      return { raw: BigInt(lamports), formatted, decimals };
    }

    const [balance, decimals] = await Promise.all([
      this.getTokenBalance(walletAddress, tokenMint, tokenProgram),
      this.getTokenDecimals(tokenMint, tokenProgram)
    ]);

    const formatted = (Number(balance) / Math.pow(10, decimals)).toFixed(decimals);

    return {
      raw: balance,
      formatted,
      decimals
    };
  }

  /**
   * Get token balance with automatic program detection and formatting
   */
  async getTokenBalanceFormattedAuto(
    walletAddress: PublicKey,
    tokenMint: PublicKey
  ): Promise<{ raw: bigint; formatted: string; decimals: number; program: PublicKey }> {
    // Native SOL
    if (tokenMint.toBase58() === SOLANA_MINT) {
      const lamports = await this.connection.getBalance(walletAddress, { commitment: 'confirmed' });
      const decimals = 9;
      const formatted = (lamports / Math.pow(10, decimals)).toFixed(decimals);
      return { raw: BigInt(lamports), formatted, decimals, program: TOKEN_PROGRAM_ID };
    }
    const result = await this.getTokenBalanceAuto(walletAddress, tokenMint);
    const decimals = await this.getTokenDecimals(tokenMint, result.program);

    const formatted = (Number(result.balance) / Math.pow(10, decimals)).toFixed(decimals);

    return {
      raw: result.balance,
      formatted,
      decimals,
      program: result.program
    };
  }

  /**
   * Get all token balances for a wallet with formatting
   */
  async getAllTokenBalancesFormatted(
    walletAddress: PublicKey,
    tokenMints: PublicKey[],
    tokenProgram: PublicKey = TOKEN_PROGRAM_ID
  ): Promise<Map<string, { raw: bigint; formatted: string; decimals: number }>> {
    const balances = new Map<string, { raw: bigint; formatted: string; decimals: number }>();

    const promises = tokenMints.map(async (mint) => {
      try {
        const balanceInfo = await this.getTokenBalanceFormatted(walletAddress, mint, tokenProgram);
        balances.set(mint.toString(), balanceInfo);
      } catch (error) {
        console.warn(`Failed to get formatted balance for token ${mint.toString()}:`, error);
        balances.set(mint.toString(), { raw: BigInt(0), formatted: '0', decimals: 0 });
      }
    });

    await Promise.all(promises);
    return balances;
  }

  /**
   * Get all token balances with automatic program detection and formatting
   */
  async getAllTokenBalancesFormattedAuto(
    walletAddress: PublicKey,
    tokenMints: PublicKey[]
  ): Promise<Map<string, { raw: bigint; formatted: string; decimals: number; program: PublicKey }>> {
    const balances = new Map<string, { raw: bigint; formatted: string; decimals: number; program: PublicKey }>();

    const promises = tokenMints.map(async (mint) => {
      try {
        const balanceInfo = await this.getTokenBalanceFormattedAuto(walletAddress, mint);
        balances.set(mint.toString(), balanceInfo);
      } catch (error) {
        console.warn(`Failed to get formatted balance for token ${mint.toString()}:`, error);
        balances.set(mint.toString(), { raw: BigInt(0), formatted: '0', decimals: 0, program: TOKEN_PROGRAM_ID });
      }
    });

    await Promise.all(promises);
    return balances;
  }

  /**
   * Get list of token accounts and balances for a wallet for a specific token program
   */
  async getWalletTokensByProgram(
    walletAddress: PublicKey,
    tokenProgram: PublicKey = TOKEN_PROGRAM_ID
  ): Promise<Array<{ mint: PublicKey; ata: PublicKey; raw: bigint; decimals: number; formatted: string; program: PublicKey }>> {
    const accounts = await this.connection.getParsedTokenAccountsByOwner(walletAddress, { programId: tokenProgram });

    const results: Array<{ mint: PublicKey; ata: PublicKey; raw: bigint; decimals: number; formatted: string; program: PublicKey }> = [];

    for (const { pubkey, account } of accounts.value) {
      const parsed: any = (account.data as any).parsed;
      if (!parsed || parsed.type !== 'account') continue;

      const info = parsed.info;
      const amountStr: string | undefined = info?.tokenAmount?.amount;
      const mintStr: string | undefined = info?.mint;
      if (!amountStr || !mintStr) continue;

      const raw = BigInt(amountStr);
      if (raw === BigInt(0)) continue; // skip empty accounts

      const mint = new PublicKey(mintStr);
      const decimals = await this.getTokenDecimals(mint, tokenProgram);
      const formatted = (Number(raw) / Math.pow(10, decimals)).toFixed(decimals);

      results.push({
        mint,
        ata: pubkey,
        raw,
        decimals,
        formatted,
        program: tokenProgram,
      });
    }

    return results;
  }

  /**
   * Get list of token accounts and balances for a wallet (SPL + Token-2022)
   */
  async getWalletTokens(
    walletAddress: PublicKey
  ): Promise<Array<{ mint: PublicKey; ata: PublicKey; raw: bigint; decimals: number; formatted: string; program: PublicKey }>> {
    const [splTokens, v2022Tokens] = await Promise.all([
      this.getWalletTokensByProgram(walletAddress, TOKEN_PROGRAM_ID),
      this.getWalletTokensByProgram(walletAddress, TOKEN_2022_PROGRAM_ID)
    ]);

    // Combine results; tokens may exist in both programs but represent different mints
    return [...splTokens, ...v2022Tokens];
  }
}


export const TokenUtilsStatic = {
  /**
   * Common token decimals for well-known tokens
   */
  KNOWN_TOKEN_DECIMALS: {
    // SOL
    'So11111111111111111111111111111111111111112': 9,
    // USDC
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 6,
    // USDT
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 6,
    // BTC
    '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E': 6,
    // ETH
    '2FPyTwcZLUg1MDrwsyoP4D6s1tM7hAkHYRjkNb5w6Pxk': 6,
    // RAY
    '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': 6,
    // SRM
    'SRMuApVNdxXokk5GT7XD5cUUgXMBCoAz2LHeuAoKWRt': 6,
  } as Record<string, number>,

  /**
   * Get known token decimals without RPC call
   */
  getKnownTokenDecimals(tokenMint: string): number | null {
    return this.KNOWN_TOKEN_DECIMALS[tokenMint] || null;
  },

  /**
   * Check if a token is a known token
   */
  isKnownToken(tokenMint: string): boolean {
    return tokenMint in this.KNOWN_TOKEN_DECIMALS;
  },
};

export enum TrendingType {
  TRENDING_5M = "trendingScoreM5",
  TRENDING_1H = "trendingScoreH1",
  TRENDING_6H = "trendingScoreH6",
  TRENDING_24H = "trendingScoreH24",
}

export enum TPoolLabel {
  DLMM = 'DLMM',
  DYNX = 'DYNX',
  DYN2 = 'DYN2'
}

export type TrendingToken = {
  chain: string,
  protocol: string,
  labels: string,
  pool: string,
  quote: string,
  base: string
}

export const getTokenTrending = async (trendingType: TrendingType = TrendingType.TRENDING_5M, page: number = 1): Promise<TrendingToken[]> => {
  try {
    const response = await fetch(`${process.env.DEXSCREEN_API_CRAWL}/pairs?rankBy=${trendingType}&page=${page}`)
    const data: any = await response.json();
    return data.data as TrendingToken[];
  } catch (error) {
    console.error(error);
    return [];
  }
}

export interface TokenProfile {
  address: string;
  symbol: string;
  name: string;
  priceUsd: number;
  priceChange: {
    m5: number;
    h1: number;
    h6: number;
    h24: number;
  };
  volume: {
    h24: number;
    h6: number;
    h1: number;
    m5: number;
  };
  liquidity: {
    usd: number;
    base: number;
    quote: number;
  };
  fdv: number;
  marketCap: number;
  pairAddress: string;
  baseAddress?: string;
  labels: string[];
}

export const getProfileTokenAddress = async (tokenAddresses: string[]): Promise<TokenProfile[]> => {
  if (tokenAddresses.length > 30) {
    return []
  }
  const formatAddresses = tokenAddresses.join(',')
  const response = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${formatAddresses}`)
  const data: any = await response.json();

  return data.map((pair: any) => ({
    address: pair.baseToken?.address || '',
    symbol: pair.baseToken?.symbol || '',
    name: pair.baseToken?.name || '',
    priceUsd: parseFloat(pair.priceUsd) || 0,
    priceChange: {
      m5: pair.priceChange?.m5 || 0,
      h1: pair.priceChange?.h1 || 0,
      h6: pair.priceChange?.h6 || 0,
      h24: pair.priceChange?.h24 || 0,
    },
    volume: {
      h24: pair.volume?.h24 || 0,
      h6: pair.volume?.h6 || 0,
      h1: pair.volume?.h1 || 0,
      m5: pair.volume?.m5 || 0,
    },
    liquidity: {
      usd: pair.liquidity?.usd || 0,
      base: pair.liquidity?.base || 0,
      quote: pair.liquidity?.quote || 0,
    },
    fdv: pair.fdv || 0,
    marketCap: pair.marketCap || 0,
    pairAddress: pair.pairAddress || '',
    labels: pair.labels || [],
  }));
}


// (async () => {
//   const tokenUtils = new TokenUtils(new Connection(clusterApiUrl("mainnet-beta")))
//   const balance = await tokenUtils.getTokenBalanceFormattedAuto(new PublicKey("DHu1wzyMQRhyVTmmrmZKN7LbiyAXk8xhrus45EBYPMJT"), new PublicKey('JCBKQBPvnjr7emdQGCNM8wtE8AZjyvJgh7JMvkfYxypm'))
//   console.log(balance)

//   const solBalance = await tokenUtils.getTokenBalanceFormattedAuto(new PublicKey("DHu1wzyMQRhyVTmmrmZKN7LbiyAXk8xhrus45EBYPMJT"), new PublicKey(SOLANA_MINT))
//   console.log({ solBalance })

//   const tokenHolders = await tokenUtils.getWalletTokens(new PublicKey("DHu1wzyMQRhyVTmmrmZKN7LbiyAXk8xhrus45EBYPMJT"))
//   console.log(tokenHolders)
// })()