# Meteora Telegram Bot Setup Guide

This guide will help you set up and run the Meteora Telegram trading bot that integrates with your LP positions and automated trading strategies.

## Prerequisites

1. **Telegram Bot Token**: Create a bot using [@BotFather](https://t.me/BotFather)
2. **Telegram Chat ID**: Your chat/group ID where the bot will send messages
3. **Solana Wallet**: Private key for your trading wallet
4. **Node.js**: Version 16 or higher

## Setup Instructions

### 1. Create Telegram Bot

1. Open Telegram and search for [@BotFather](https://t.me/BotFather)
2. Send `/newbot` command
3. Follow the instructions to name your bot
4. Save the **Bot Token** provided

### 2. Get Chat ID

1. Add your bot to a group or start a private chat
2. Send a message to the bot
3. Visit: `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
4. Find your **Chat ID** in the response

### 3. Environment Configuration

Create a `.env` file in your project root:

```bash
# Solana Configuration
SOLANA_PRIVATE_KEY=your_base58_private_key_here
RPC_URL=https://api.mainnet-beta.solana.com

# Telegram Bot Configuration
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_from_botfather
TELEGRAM_CHAT_ID=your_telegram_chat_id

# Jupiter API Configuration
JUPITER_API_URL=https://lite-api.jup.ag

# Trading Configuration
DEFAULT_SLIPPAGE=50
DEFAULT_INVESTMENT_AMOUNT=100
MAX_POSITIONS=5

# Automation Settings
AUTO_TRADING_ENABLED=false
TRADING_INTERVAL_MINUTES=5
RISK_MANAGEMENT_ENABLED=true
```

### 4. Install Dependencies

```bash
npm install
```

### 5. Run the Bot

```bash
npm run bot
```

## Bot Commands

### Portfolio Commands
- `/positions` - View all LP positions
- `/pnl` - Check portfolio P&L
- `/balance` - Check token balances

### Trading Commands
- `/create_position <tokenA> <tokenB> <amount>` - Create new LP position
- `/zap_out <pool_address> <percentage>` - Zap out from position

### Quick Actions
- `/trending` - Get trending tokens (5m)
- `/clear_all` - Clear all positions (zapout)

### Automation
- `/start_auto` - Start automated trading
- `/stop_auto` - Stop automated trading
- `/status` - Bot status

### Info
- `/wallet` - Show wallet address
- `/help` - Show help message

## Automated Trading Features

The bot includes a scheduled job system that:

1. **Clears all positions** - Zaps out of all existing LP positions
2. **Fetches trending tokens** - Gets 5-minute trending data
3. **Filters DAMM V2 pools** - Finds suitable pools for trading
4. **Creates new positions** - Automatically invests in trending opportunities
5. **Notifies via Telegram** - Sends updates to your chat

### Automation Schedule

- **Interval**: Every 5 minutes (configurable)
- **Safety**: Multiple error handling layers
- **Notifications**: Real-time updates on all actions

## Safety Features

### Risk Management
- **Slippage Protection**: Configurable slippage limits
- **Position Limits**: Maximum number of concurrent positions
- **Error Handling**: Graceful failure handling with notifications

### Security
- **Private Key Protection**: Never logged or transmitted
- **Environment Variables**: Sensitive data in .env files
- **Error Isolation**: Individual position failures don't stop the bot

## Usage Examples

### Manual Trading
```
/positions
📊 Your LP Positions:

1. DAMM V2 Pool
   Pool: 5UpbPQi...
   Tokens: USDC / SOL
   Liquidity: 1,234.56
   Est. Value: $567.89
```

### Automated Trading Notification
```
🤖 Starting automated trading cycle...
🧹 Cleared 3/3 positions successfully!
🔥 Found trending token: BONK
✅ Automated position created for BONK
```

### Error Handling
```
⚠️ Automated trading error: Insufficient balance
❌ Failed to create position for TOKEN: Pool not found
```

## Troubleshooting

### Common Issues

1. **Bot not responding**
   - Check if bot token is correct
   - Verify bot is added to the chat
   - Check internet connection

2. **Transaction failures**
   - Increase slippage tolerance
   - Check wallet balance
   - Verify RPC connection

3. **Position errors**
   - Ensure sufficient token balance
   - Check pool liquidity
   - Verify pool addresses

### Debug Mode

Set `NODE_ENV=development` for detailed logging:

```bash
NODE_ENV=development npm run bot
```

## Configuration Options

### Trading Parameters
```typescript
{
  slippage: 50,              // 0.5% slippage
  investmentAmount: 100,     // $100 per position
  maxPositions: 5,           // Max 5 concurrent positions
  automationInterval: 5,     // 5 minutes
}
```

### Notification Settings
- Position updates
- Trade confirmations
- Error alerts
- Performance summaries

## Advanced Features

### Custom Strategies
The bot supports custom trading strategies by modifying:
- `filterDammV2Pools()` - Token filtering logic
- `createAutomatedPosition()` - Position sizing
- `executeAutomatedTrading()` - Trading frequency

### Integration Points
- **DEXScreener API** - Trending token data
- **Jupiter API** - Swap execution
- **Meteora SDK** - LP position management
- **Solana RPC** - Blockchain interaction

## Support

For issues and questions:
1. Check the troubleshooting section
2. Review error messages in the chat
3. Check console logs for detailed errors
4. Verify environment configuration

## Security Notice

⚠️ **Important**: Never share your private keys or bot tokens. Keep your `.env` file secure and never commit it to version control.

