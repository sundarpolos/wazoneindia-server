import BerryProtocol from '../dist/index.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sessionId = '919843350000';

async function test() {
  console.log("Initializing BerryProtocol with session ID:", sessionId);
  const client = new BerryProtocol({
    sessionId: sessionId,
    authFolder: path.resolve(__dirname, '../.berry-sessions')
  });

  // Listen to connection open
  client.on('connection.open', () => {
    console.log("Connected successfully to WhatsApp!");
  });

  console.log("Connecting...");
  await client.connect();

  // Wait a few seconds for session initialization
  await new Promise(resolve => setTimeout(resolve, 4000));

  console.log("Sending legacy button message...");
  try {
    const payload = {
      text: 'Test Legacy Button Message from Chip Maestro',
      footer: 'Choose below',
      buttons: [
        { id: 'opt_1', title: 'Option 1' },
        { id: 'opt_2', title: 'Option 2' }
      ]
    };

    const res = await client.sendLegacyButtons(`${sessionId}@s.whatsapp.net`, payload);
    console.log("Result:", JSON.stringify(res, null, 2));
  } catch (err) {
    console.error("Failed to send legacy buttons:", err);
  }

  // Keep alive for 3 seconds, then disconnect
  await new Promise(resolve => setTimeout(resolve, 3000));
  await client.disconnect();
  console.log("Disconnected.");
}

test().catch(console.error);
