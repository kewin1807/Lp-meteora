import WebSocket from 'ws';

const wsUrl = 'wss://io.dexscreener.com/dex/screener/v5/pairs/h24/1?' +
  'rankBy[key]=trendingScoreH6&rankBy[order]=desc&' +
  'filters[chainIds][0]=solana&filters[dexIds][0]=meteora&filters[dexIds][1]=meteoradbc';

const connectWS = () => {
  const ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log('✅ Connected to DexScreener');
  });

  ws.on('message', (data) => {
    try {
      // data is Buffer in Node.js
      const text = data.toString('utf8');
      const parsed = JSON.parse(text);
      console.log('📊 Data received:', parsed);
    } catch (error) {
      console.error('❌ Parse error:', error);
      console.log('Raw data:', data);
    }
  });

  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error.message);
  });

  ws.on('close', (code, reason) => {
    console.log(`❌ Connection closed: ${code} ${reason.toString()}`);
    console.log('🔄 Retrying in 5 seconds...');
    setTimeout(connectWS, 5000);
  });

  return ws;
};

// Start connection
const ws = connectWS();