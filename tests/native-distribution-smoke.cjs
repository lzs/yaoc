// Run explicitly on Windows after building. Uses isolated profile directories and only test-owned processes.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const net = require('node:net');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
(async () => {
  const testRoot = fs.mkdtempSync(path.join(root, '.local', 'native-mode-'));
  const portable = path.join(testRoot, 'portable');
  const installed = path.join(testRoot, 'installed space 测试');
  const appdata = path.join(testRoot, 'roaming');
  const local = path.join(testRoot, 'local');
  for (const dir of [portable, installed, appdata, local]) fs.mkdirSync(dir, { recursive: true });
  for (const dir of [portable, installed])
    fs.copyFileSync(path.join(root, 'release/yaoc-x64.exe'), path.join(dir, 'yaoc.exe'));
  const marker = JSON.stringify({ formatVersion: 1, installDirectory: installed });
  fs.writeFileSync(
    path.join(installed, 'install-metadata.json'),
    Buffer.concat([Buffer.from([255, 254]), Buffer.from(marker, 'utf16le')])
  );
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const env = {
    ...process.env,
    APPDATA: appdata,
    LOCALAPPDATA: local,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port,
  };
  const children = [];
  let browser;
  const launch = (directory) => {
    const child = cp.spawn(path.join(directory, 'yaoc.exe'), [], {
      env,
      windowsHide: true,
      stdio: 'ignore',
    });
    children.push(child);
    return child;
  };
  const connect = async () => {
    for (let i = 0; i < 100; i++) {
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/json/version');
        if (response.ok) break;
      } catch {}
      await sleep(100);
    }
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
    const context = browser.contexts()[0];
    for (let i = 0; i < 100; i++) {
      if (context.pages().length) break;
      await sleep(100);
    }
    const page = context.pages()[0];
    await page.waitForFunction(() => Boolean(window.openclawApi));
    return page;
  };
  try {
    const first = launch(portable);
    let page = await connect();
    let info = await page.evaluate(() => window.openclawApi.getSystemInfo());
    assert.equal(info.distribution.mode, 'portable');
    assert.equal(info.distribution.dataDirectory, path.join(appdata, 'yaoc'));
    await page.evaluate(() => localStorage.setItem('yaoc.native-mode-test', 'shared'));
    await page.evaluate(() =>
      window.openclawApi.showNotification('Portable test', 'Notification fallback works', false)
    );
    await page.getByRole('status').filter({ hasText: 'Notification fallback works' }).waitFor();
    await page.screenshot({ path: path.join(testRoot, 'portable-notification.png') });
    for (const method of ['downloadUpdate', 'installUpdate']) {
      const error = await page.evaluate(async (method) => {
        try {
          await window.openclawApi[method]();
          return '';
        } catch (e) {
          return String(e);
        }
      }, method);
      assert.match(error, /Portable copies must be updated manually/);
    }
    // Another executable, even with installed metadata, must focus this primary and exit.
    await page.evaluate(() => window.openclawApi.windowAction('close'));
    const second = launch(installed);
    await Promise.race([
      new Promise((resolve) => second.once('exit', resolve)),
      sleep(5000).then(() => {
        throw Error('Second copy did not exit');
      }),
    ]);
    assert.equal(second.exitCode, 0);
    assert.equal(
      (await page.evaluate(() => window.openclawApi.getSystemInfo())).distribution.mode,
      'portable'
    );
    await page.evaluate(() => window.openclawApi.quitApp()).catch(() => {});
    await new Promise((resolve) => {
      if (first.exitCode !== null) resolve();
      else first.once('exit', resolve);
    });
    await browser.close().catch(() => {});
    browser = null;
    launch(installed);
    page = await connect();
    info = await page.evaluate(() => window.openclawApi.getSystemInfo());
    assert.equal(info.distribution.mode, 'installed');
    assert.equal(
      await page.evaluate(() => localStorage.getItem('yaoc.native-mode-test')),
      'shared'
    );
    assert.equal(info.distribution.webviewDirectory, path.join(local, 'ai.openclaw.chat.lite'));
    await page.evaluate(() => window.openclawApi.quitApp()).catch(() => {});
    console.log(
      'PASS: native portable/installed detection (Unicode metadata), shared WebView2 localStorage, second-launch exit, portable backend guards and notification banner.'
    );
  } finally {
    if (browser) await browser.close().catch(() => {});
    for (const child of children) if (child.exitCode === null) child.kill();
    // Leave isolated data under .local for inspection; never remove real user profiles.
    console.log('Isolated native test data: ' + testRoot);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
