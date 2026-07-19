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

if (typeof process !== 'undefined' && process.argv && process.argv[1]) {
  try {
    const mainPath = path.resolve(process.argv[1]);
    const currentPath = fileURLToPath(import.meta.url);
    if (currentPath === mainPath) {
      console.log("[Boot] Running directly as main module. Starting server.js...");
      // @ts-ignore
      import('../server.js').catch(console.error);
    }
  } catch (err) {
    console.error("[Boot] Failed to check main entry point:", err);
  }
}

