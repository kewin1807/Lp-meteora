import { clusterApiUrl } from "@solana/web3.js";
import { BotConfig, MeteoraBot } from "../src/bot/TelegramBot";
import "dotenv/config";

async function main() {
  const config: BotConfig = {
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
    chatId: process.env.TELEGRAM_CHAT_ID || "",
    privateKey: process.env.SOLANA_PRIVATE_KEY || "",
    rpcUrl: clusterApiUrl("mainnet-beta"),
    // rpcUrl: process.env.RPC_URL || clusterApiUrl("mainnet-beta"),
    swapUrl: "https://lite-api.jup.ag",
  };
  const bot = new MeteoraBot(config);

  // Validate required environment variables
  if (!config.telegramToken) {
    console.error("❌ TELEGRAM_BOT_TOKEN is required in environment variables");
    process.exit(1);
  }

  if (!config.chatId) {
    console.error("❌ TELEGRAM_CHAT_ID is required in environment variables");
    process.exit(1);
  }

  if (!config.privateKey) {
    console.error("❌ SOLANA_PRIVATE_KEY is required in environment variables");
    process.exit(1);
  }

  console.log("🚀 Starting Meteora Telegram Bot...");
  console.log(`💳 Wallet: ${config.privateKey.slice(0, 8)}...`);
  console.log(`🤖 Chat ID: ${config.chatId}`);

  try {
    // Start the bot
    await bot.start();

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      console.log('\n🛑 Shutting down bot...');
      bot.stop();
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      console.log('\n🛑 Shutting down bot...');
      bot.stop();
      process.exit(0);
    });

    console.log("✅ Bot is running! Press Ctrl+C to stop.");
  } catch (error) {
    console.error("❌ Failed to start bot:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ Bot startup error:", error);
  process.exit(1);
});

