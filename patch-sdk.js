// Apply critical SDK patches after npm install
// These patches fix credential persistence and QR stability
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const patches = [
  {
    file: 'node_modules/@berrysdk/transport/vendor/lib/Utils/use-multi-file-auth-state.js',
    apply: (content) => {
      const oldStr = 'const creds = (await readData(\'creds.json\')) || initAuthCreds();';
      const newStr = oldStr + ' if (!await readData(\'creds.json\')) { await writeData(creds, \'creds.json\'); }';
      if (content.includes(newStr)) return { patched: false, msg: 'already patched' };
      if (!content.includes(oldStr)) return { patched: false, msg: 'pattern not found' };
      return { patched: true, content: content.replace(oldStr, newStr), msg: 'creds.json write patched' };
    }
  },
  {
    file: 'node_modules/@berrysdk/socket/dist/index.js',
    apply: (content) => {
      const oldStr = 'void saveCreds();';
      const newStr = 'saveCreds().catch(err => console.error("[Socket] saveCreds error:", err));';
      if (content.includes(newStr)) return { patched: false, msg: 'already patched' };
      if (!content.includes(oldStr)) return { patched: false, msg: 'pattern not found' };
      return { patched: true, content: content.replace(oldStr, newStr), msg: 'saveCreds error handling patched' };
    }
  }
];

let patchedCount = 0;
for (const p of patches) {
  const filePath = join(__dirname, p.file);
  if (!existsSync(filePath)) {
    console.log(`[patch] ${p.file} — not found, skipping`);
    continue;
  }
  const content = readFileSync(filePath, 'utf-8');
  const result = p.apply(content);
  if (result.patched) {
    writeFileSync(filePath, result.content, 'utf-8');
    console.log(`[patch] ${p.file} — ${result.msg}`);
    patchedCount++;
  } else {
    console.log(`[patch] ${p.file} — ${result.msg}`);
  }
}
console.log(`[patch] Done — ${patchedCount} file(s) patched`);
