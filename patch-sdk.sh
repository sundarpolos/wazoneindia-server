#!/bin/bash
# Apply critical SDK patches after npm install

# Patch 1: Write creds.json immediately on creation (so reconnections preserve the same QR)
CREDS_FILE="node_modules/@berrysdk/transport/vendor/lib/Utils/use-multi-file-auth-state.js"
if [ -f "$CREDS_FILE" ]; then
  if grep -q "writeData(creds, 'creds.json'" "$CREDS_FILE" 2>/dev/null; then
    echo "[patch] creds.json write already patched"
  else
    sed -i '' "s/const creds = (await readData('creds.json')) || initAuthCreds();/const creds = (await readData('creds.json')) || initAuthCreds(); if (!await readData('creds.json')) { await writeData(creds, 'creds.json'); }/" "$CREDS_FILE"
    echo "[patch] use-multi-file-auth-state.js patched"
  fi
fi

# Patch 2: Add error handling to saveCreds()
SOCKET_FILE="node_modules/@berrysdk/socket/dist/index.js"
if [ -f "$SOCKET_FILE" ]; then
  if grep -q "saveCreds().catch" "$SOCKET_FILE" 2>/dev/null; then
    echo "[patch] socket saveCreds already patched"
  else
    # Replace void saveCreds() with saveCreds().catch(...)
    python3 -c "
import re
with open('$SOCKET_FILE', 'r') as f:
    content = f.read()
content = content.replace('void saveCreds()', 'saveCreds().catch(err => console.error(\"[Socket] saveCreds error:\", err))')
with open('$SOCKET_FILE', 'w') as f:
    f.write(content)
" 2>/dev/null || echo "[patch] python3 not available, skipping socket patch"
    echo "[patch] socket saveCreds patched"
  fi
fi

echo "[patch] SDK patches applied"
