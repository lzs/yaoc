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
    fs.copyFileSync(
      process.env.YAOC_NATIVE_TEST_EXE || path.join(root, 'release/yaoc-x64.exe'),
      path.join(dir, 'yaoc.exe')
    );
  const marker = JSON.stringify({ formatVersion: 1, installDirectory: installed });
  fs.writeFileSync(
    path.join(installed, 'install-metadata.json'),
    Buffer.concat([Buffer.from([255, 254]), Buffer.from(marker, 'utf16le')])
  );
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const env = {
    ...process.env,
    APPDATA: appdata,
    LOCALAPPDATA: local,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port,
  };
  const portableKey = 'HKCU\\Software\\Classes\\AppUserModelId\\io.github.lzs.yaoc.portable';
  const installedKey = 'HKCU\\Software\\Classes\\AppUserModelId\\io.github.lzs.yaoc';
  const registryBackup = path.join(testRoot, 'portable-registration.reg');
  const previousPortable =
    cp.spawnSync('reg.exe', ['export', portableKey, registryBackup, '/y'], {
      stdio: 'ignore',
      windowsHide: true,
    }).status === 0;
  const installedBefore = cp.spawnSync('reg.exe', ['query', installedKey], {
    encoding: 'utf8',
    windowsHide: true,
  }).stdout;
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
    const body = 'YAOC native portable test ' + Date.now();
    await page.evaluate(() => window.openclawApi.windowAction('close'));
    await page.evaluate(
      (body) => window.openclawApi.showNotification('Portable Windows toast', body, false),
      body
    );
    assert.equal(await page.locator('.notification-banner').count(), 0);
    let delivered = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const command =
        "$null=[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]; $items=[Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('io.github.lzs.yaoc.portable'); @($items | Where-Object { $_.Content.GetXml().Contains('" +
        body +
        "') }).Count";
      const result = cp.spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', command],
        { encoding: 'utf8', windowsHide: true }
      );
      if (result.status !== 0) throw Error('Cannot inspect native toast history: ' + result.stderr);
      if (Number(result.stdout.trim()) > 0) {
        delivered = true;
        break;
      }
      await sleep(500);
    }
    assert(delivered, 'Portable toast was not found in Windows Notification Center');
    const portableRegistration = cp.spawnSync('reg.exe', ['query', portableKey], {
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(portableRegistration.status, 0);
    assert(
      portableRegistration.stdout.includes(
        path.join(local, 'io.github.lzs.yaoc', 'notifications', 'portable.png')
      )
    );
    const installedAfter = cp.spawnSync('reg.exe', ['query', installedKey], {
      encoding: 'utf8',
      windowsHide: true,
    }).stdout;
    assert.equal(
      installedAfter,
      installedBefore,
      'Portable launch modified installed notification registration'
    );
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
    // WebView2 may leave its debug endpoint alive briefly after the parent exits.
    // Wait for it to close and use a fresh port for the next process.
    for (let i = 0; i < 50; i++) {
      try {
        await fetch('http://127.0.0.1:' + port + '/json/version');
      } catch {
        break;
      }
      await sleep(100);
    }
    const nextServer = net.createServer();
    await new Promise((resolve) => nextServer.listen(0, '127.0.0.1', resolve));
    port = nextServer.address().port;
    await new Promise((resolve) => nextServer.close(resolve));
    env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=' + port;
    launch(installed);
    page = await connect();
    info = await page.evaluate(() => window.openclawApi.getSystemInfo());
    assert.equal(info.distribution.mode, 'installed');
    assert.equal(
      await page.evaluate(() => localStorage.getItem('yaoc.native-mode-test')),
      'shared'
    );
    assert.equal(info.distribution.webviewDirectory, path.join(local, 'io.github.lzs.yaoc'));
    await page.evaluate(() => window.openclawApi.quitApp()).catch(() => {});
    console.log(
      'PASS: native portable/installed detection (Unicode metadata), shared WebView2 localStorage, second-launch exit, portable backend guards and native Windows toasts while hidden.'
    );
  } finally {
    if (browser) await browser.close().catch(() => {});
    for (const child of children) if (child.exitCode === null) child.kill();
    cp.spawnSync('reg.exe', ['delete', portableKey, '/f'], { stdio: 'ignore', windowsHide: true });
    if (previousPortable)
      cp.spawnSync('reg.exe', ['import', registryBackup], { stdio: 'ignore', windowsHide: true });
    // Leave isolated data under .local for inspection; never remove real user profiles.
    console.log('Isolated native test data: ' + testRoot);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
