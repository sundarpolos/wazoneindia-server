export {
  BerryClient,
  BerryProtocol,
  default,
} from "@berrysdk/core";

export * from "./Defaults/index.js";
export * from "./Socket/index.js";
export * from "./Utils/index.js";
export * from "./Store/index.js";
export * from "./Auth/index.js";
export * from "./Media/index.js";
export * from "./Messages/index.js";
export * from "./Types/Index.js";

import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

if (typeof process !== 'undefined') {
  // Diagnostics
  try {
    const logData = {
      time: new Date().toISOString(),
      argv: process.argv,
      env: {
        PORT: process.env.PORT,
        NODE_ENV: process.env.NODE_ENV,
        PASSENGER_APP_ENV: process.env.PASSENGER_APP_ENV,
        PWD: process.env.PWD,
        USER: process.env.USER
      },
      metaUrl: import.meta.url
    };
    const logPath = path.resolve(process.env.HOME || '/tmp', 'debug_boot.txt');
    fs.writeFileSync(logPath, JSON.stringify(logData, null, 2) + '\n', { flag: 'a' });
  } catch (err) {
    // Ignore diagnostic failures
  }

  // Auto-start server when run in Node environment (e.g. by Hostinger Node runner)
  console.log('[Bootloader] Booting server from core entry point...');
  // @ts-ignore
  import('../server.js').catch((err: any) => {
    console.error('[Bootloader Error] Failed to load server.js:', err);
  });
}

