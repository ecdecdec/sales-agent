import dotenv from 'dotenv';
dotenv.config();

import { sendOneTelegramPending, getNextAvailableClient, initTelegram } from './telegram';
import { initBot } from './mybot';
import { dbHelpers } from './db';

(async () => {
  console.log('Initializing Telegraf bot...');
  await initBot();
  console.log('Initializing Telegram client...');
  await initTelegram();
  console.log('Running Telegram sender...');
  
  while (true) {
    const b = dbHelpers.getPendingMessageAndMarkSending('Telegram');
    if (!b) {
      console.log('No pending Telegram messages.');
      break;
    }
    const client = getNextAvailableClient();
    if (!client) {
      console.log('No available Telegram accounts.');
      dbHelpers.updateStatus(b.id, 'Не писали');
      break;
    }
    const sent = await sendOneTelegramPending(b, client);
    if (sent) {
      console.log(`Sent one pending Telegram message to ${b.name}.`);
    } else {
      console.log(`Failed to send Telegram message to ${b.name}.`);
    }
  }
  console.log('Finished!');
  process.exit(0);
})();
