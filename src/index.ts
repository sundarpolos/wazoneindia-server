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

if (typeof process !== 'undefined') {
  try {
    const fs = await import('fs');
    const path = await import('path');
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
    fs.writeFileSync(
      path.resolve(process.cwd(), 'debug_boot.txt'),
      JSON.stringify(logData, null, 2) + '\n',
      { flag: 'a' }
    );

    const mainPath = path.resolve(process.argv[1] || '');
    const currentPath = fileURLToPath(import.meta.url);
    // If not loaded by server.js, run the server
    const isLoadedByServer = mainPath.endsWith('server.js');
    if (!isLoadedByServer) {
      console.log("[Boot] App not loaded by server.js. Bootstrapping server.js...");
      // @ts-ignore
      import('../server.js').catch(console.error);
    }
  } catch (err) {
    console.error("[Boot] Failed to run boot diagnostics:", err);
  }
}

