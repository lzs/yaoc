// Run after the local x64 Beta build. Uses an isolated native profile and test-owned process.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
// Minimal local WebSocket peer: reject connect and close in the same write to
// exercise the real native reader/handshake race rather than mocked UI events.
async function rejectionGateway() {
  let mode = 'pairing';
  const sockets = new Set();
  const frame = (opcode, payload) => {
    const body = Buffer.from(payload);
    const header =
      body.length < 126
        ? Buffer.from([0x80 | opcode, body.length])
        : Buffer.from([0x80 | opcode, 126, body.length >> 8, body.length & 255]);
    return Buffer.concat([header, body]);
  };
  const server = http.createServer();
  server.on('upgrade', (request, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const accept = crypto
      .createHash('sha1')
      .update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
        accept +
        '\r\n\r\n'
    );
    socket.write(
      frame(
        1,
        JSON.stringify({
          type: 'event',
          event: 'connect.challenge',
          payload: { nonce: 'test-nonce' },
        })
      )
    );
    let buffered = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 2) {
        let length = buffered[1] & 127;
        let offset = 2;
        if (length === 126) {
          if (buffered.length < 4) return;
          length = buffered.readUInt16BE(2);
          offset = 4;
        }
        if (length === 127) {
          socket.destroy();
          return;
        }
        const masked = Boolean(buffered[1] & 128);
        const total = offset + (masked ? 4 : 0) + length;
        if (buffered.length < total) return;
        const opcode = buffered[0] & 15;
        const mask = buffered.subarray(offset, offset + 4);
        const body = Buffer.from(buffered.subarray(offset + (masked ? 4 : 0), total));
        buffered = buffered.subarray(total);
        if (masked) for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
        if (opcode !== 1) continue;
        const message = JSON.parse(body.toString());
        if (message.method !== 'connect') continue;
        const error =
          mode === 'auth'
            ? { code: 'INVALID_REQUEST', message: 'unauthorized: token mismatch' }
            : {
                code: 'INVALID_REQUEST',
                message: 'Device access denied',
                details: { code: 'PAIRING_REQUIRED', requestId: 'pairing-test-123' },
              };
        const close = Buffer.concat([
          Buffer.from([3, 240]),
          Buffer.from(mode === 'close-only' ? 'pairing required' : 'connection rejected'),
        ]);
        socket.end(
          Buffer.concat([
            ...(mode === 'close-only'
              ? []
              : [frame(1, JSON.stringify({ type: 'res', id: message.id, ok: false, error }))]),
            frame(8, close),
          ])
        );
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    endpoint: 'ws://127.0.0.1:' + server.address().port,
    setMode: (value) => {
      mode = value;
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
(async () => {
  const testRoot = fs.mkdtempSync(path.join(root, '.local', 'native-pairing-'));
  const appdata = path.join(testRoot, 'roaming');
  const local = path.join(testRoot, 'local');
  fs.mkdirSync(path.join(appdata, 'yaoc'), { recursive: true });
  fs.mkdirSync(local, { recursive: true });
  const rejection = await rejectionGateway();
  const port = await unusedPort();
  fs.writeFileSync(
    path.join(appdata, 'yaoc', 'gateway-profiles.json'),
    JSON.stringify({
      profiles: [
        { id: 'demo', name: 'Demo Gateway', endpoint: 'mock://demo' },
        { id: 'pairing', name: 'Pairing Gateway', endpoint: rejection.endpoint },
      ],
      activeProfileId: 'demo',
      uiState: { autoConnect: true, notificationsEnabled: false, showWorkspacePane: false },
    })
  );
  const child = cp.spawn(
    process.env.YAOC_NATIVE_TEST_EXE || path.join(root, 'release/yaoc-x64.exe'),
    [],
    {
      env: {
        ...process.env,
        APPDATA: appdata,
        LOCALAPPDATA: local,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port,
      },
      windowsHide: true,
      stdio: 'ignore',
    }
  );
  let browser;
  try {
    for (let i = 0; i < 150; i++) {
      try {
        if ((await fetch('http://127.0.0.1:' + port + '/json/version')).ok) break;
      } catch {}
      await sleep(100);
    }
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
    const context = browser.contexts()[0];
    for (let i = 0; i < 100 && !context.pages().length; i++) await sleep(100);
    const page = context.pages()[0];
    await page.waitForFunction(() => document.querySelector('.status-dot.connected'));
    for (const mode of ['pairing', 'pairing', 'pairing', 'close-only', 'auth']) {
      rejection.setMode(mode);
      await page.evaluate(async (endpoint) => {
        await window.openclawApi.disconnect();
        await window.openclawApi.connect({ id: 'pairing', name: 'Pairing Gateway', endpoint });
      }, rejection.endpoint);
      const guide = page.locator('.guide-card');
      if (mode === 'auth') {
        await guide.getByText('unauthorized: token mismatch', { exact: true }).waitFor();
        assert.equal(
          await guide.getByText('ONE-TIME DEVICE PAIRING REQUIRED', { exact: true }).count(),
          0
        );
      } else {
        await guide.getByText('ONE-TIME DEVICE PAIRING REQUIRED', { exact: true }).waitFor();
        if (mode !== 'close-only')
          await guide
            .getByText('openclaw devices approve pairing-test-123', { exact: true })
            .waitFor();
        await page.waitForTimeout(250);
        await guide.getByText('ONE-TIME DEVICE PAIRING REQUIRED', { exact: true }).waitFor();
      }
      await page.evaluate(async () => {
        await window.openclawApi.disconnect();
        await window.openclawApi.connect({
          id: 'demo',
          name: 'Demo Gateway',
          endpoint: 'mock://demo',
        });
      });
      await page.waitForFunction(() => document.querySelector('.status-dot.connected'));
    }
    console.log(
      'PASS: native immediate-close pairing errors retain request IDs, close-only pairing displays guidance, and auth errors stay distinct.'
    );
    await page.evaluate(() => window.openclawApi.quitApp()).catch(() => {});
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (child.exitCode === null) child.kill();
    await rejection.close();
    console.log('Isolated native pairing test data: ' + testRoot);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
