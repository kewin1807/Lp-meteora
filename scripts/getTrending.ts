import { getProfileTokenAddress, getTokenTrending, TPoolLabel, TrendingType } from "../src/utils/tokenUtils";

const getTrendingTokens = async (timeframe: TrendingType = TrendingType.TRENDING_5M) => {
  try {
    const data = await getTokenTrending(timeframe);
    const filterData = data.filter(item => item.labels === TPoolLabel.DYN2);
    // Collect unique base token addresses
    const quoteAddresses = Array.from(new Set(filterData.map(item => item.quote).filter(Boolean)));

    if (quoteAddresses.length === 0) return [];

    // Batch requests: 30 addresses per call
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

(async () => {
  const trending = await getTrendingTokens();
  console.log(trending);
})();