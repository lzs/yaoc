// Run after the local x64 Beta build. Uses an isolated native profile and test-owned process.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const net = require('node:net');
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
  const testRoot = fs.mkdtempSync(path.join(root, '.local', 'native-gateway-'));
  const appdata = path.join(testRoot, 'roaming');
  const local = path.join(testRoot, 'local');
  fs.mkdirSync(path.join(appdata, 'yaoc'), { recursive: true });
  fs.mkdirSync(local, { recursive: true });
  const port = await unusedPort();
  const unavailablePort = await unusedPort();
  fs.writeFileSync(
    path.join(appdata, 'yaoc', 'gateway-profiles.json'),
    JSON.stringify({
      profiles: [
        { id: 'demo', name: 'Demo Gateway', endpoint: 'mock://demo' },
        {
          id: 'unavailable',
          name: 'Unavailable Gateway',
          endpoint: 'ws://127.0.0.1:' + unavailablePort,
        },
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
    await page.evaluate(() => {
      window.nativeChatEvents = [];
      window.openclawApi.onGatewayEvent((frame) => {
        if (frame.event === 'chat') window.nativeChatEvents.push(frame.payload);
      });
    });
    const composer = page.getByRole('textbox', { name: 'Message Assistant', exact: true });
    const send = page.getByRole('button', { name: 'Send message', exact: true });
    for (const message of ['first demo message', 'second demo message']) {
      await composer.fill(message);
      await send.click();
      await page.locator('.message-card.assistant').filter({ hasText: message }).waitFor();
      await send.waitFor();
      await page.waitForFunction(() => !document.querySelector('button[title="Stop generating"]'));
    }
    const events = await page.evaluate(() => window.nativeChatEvents);
    assert.equal(events.length, 2);
    assert.notEqual(events[0].runId, events[1].runId);
    for (const event of events) {
      const result = await page.evaluate(
        (runId) => window.openclawApi.request('agent.wait', { runId }),
        event.runId
      );
      assert.equal(result.status, 'ok');
      assert.equal(result.runId, event.runId);
    }
    await page.getByRole('button', { name: 'Active Gateway profile', exact: true }).click();
    await page.getByRole('option', { name: /^Unavailable Gateway / }).click();
    await page.waitForFunction(() => document.querySelector('.status-dot.error'));
    const error = await page.evaluate(async () => {
      try {
        await window.openclawApi.request('agents.list', {});
        return '';
      } catch (e) {
        return String(e);
      }
    });
    assert.match(error, /not connected/i, 'The previous mock transport must be disconnected');
    await page.getByRole('button', { name: 'Active Gateway profile', exact: true }).click();
    await page.getByRole('option', { name: /^Demo Gateway / }).click();
    await page.waitForFunction(() => document.querySelector('.status-dot.connected'));
    console.log(
      'PASS: native demo completes consecutive sends; profile switching disconnects the old transport, attempts the new one, and reconnects the demo.'
    );
    await page.evaluate(() => window.openclawApi.quitApp()).catch(() => {});
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (child.exitCode === null) child.kill();
    console.log('Isolated native gateway test data: ' + testRoot);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
