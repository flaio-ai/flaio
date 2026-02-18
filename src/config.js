import dotenv from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "..", ".env") });

export const config = {
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN,
    channelId: process.env.SLACK_CHANNEL_ID,
    pollInterval: parseInt(process.env.POLL_INTERVAL || "2000", 10),
  },
  hookTimeout: parseInt(process.env.HOOK_TIMEOUT || "300000", 10),
  stopPromptTimeout: parseInt(process.env.STOP_PROMPT_TIMEOUT || "86400000", 10),
};
