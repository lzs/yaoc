const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const origin = 'http://127.0.0.1:4179';

async function openApp(browser, options = {}) {
  const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
  const config = JSON.parse(await fs.readFile(path.join(root, 'src-tauri/tauri.conf.json')));
  await page.route(`${origin}/**`, async (route) => {
    const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
    const file = path.resolve(dist, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(dist + path.sep)) return route.abort();
    const extension = path.extname(file);
    const contentType =
      {
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.html': 'text/html',
      }[extension] || 'application/octet-stream';
    await route.fulfill({
      body: await fs.readFile(file),
      contentType,
      headers: { 'Content-Security-Policy': config.app.security.csp },
    });
  });
  await page.addInitScript((options) => {
    localStorage.setItem('openclaw.theme.v1', options.theme || 'dark');
    const callbacks = new Set();
    let thinkingLevel = 'medium';
    let model = 'provider/model-a';
    window.testRequests = [];
    window.testSaves = [];
    window.testHotkeys = [];
    window.openclawApi = {
      getSystemInfo: async () => ({ platform: 'win32', arch: 'x64', runtime: 'test' }),
      loadProfiles: async () => {
        if (options.loadError) throw new Error('Unreadable profile fixture');
        return {
          profiles: [{ id: 'test', name: 'Test Gateway', endpoint: 'mock://demo' }],
          activeProfileId: 'test',
          uiState: {
            autoConnect: true,
            showWorkspacePane: false,
            ...(options.hotkey === undefined ? {} : { globalHotkey: options.hotkey }),
          },
        };
      },
      saveProfiles: async (...args) => {
        window.testSaves.push(args);
        if (options.saveError) throw new Error('Settings write fixture failed');
        return { ok: true };
      },
      onStatus: (callback) => {
        callbacks.add(callback);
        return () => callbacks.delete(callback);
      },
      onGatewayEvent: () => () => {},
      connect: async () => {
        for (const callback of callbacks) callback({ state: 'connected', endpoint: 'mock://demo' });
        return { ok: true };
      },
      disconnect: async () => {
        for (const callback of callbacks) callback({ state: 'disconnected' });
        return { ok: true };
      },
      setGlobalHotkey: async (hotkey) => {
        window.testHotkeys.push(hotkey);
        return { ok: true, hotkey };
      },
      request: async (method, params) => {
        window.testRequests.push({ method, params });
        if (method === 'agents.list') return { agents: [{ id: 'main', name: 'Assistant' }] };
        if (method === 'sessions.list')
          return {
            sessions: [
              {
                key: 'main',
                agentId: 'main',
                model: model.split('/')[1],
                modelProvider: 'provider',
                thinkingLevel,
              },
            ],
          };
        if (method === 'models.list')
          return {
            models: Array.from({ length: 30 }, (_, i) => ({
              id: i === 0 ? 'model-a' : `model-${i}`,
              provider: 'provider',
              name: i === 0 ? 'Model A' : `Model ${i}`,
            })),
          };
        if (method === 'sessions.patch') {
          if ('model' in params) model = params.model;
          if ('thinkingLevel' in params) thinkingLevel = params.thinkingLevel;
          return {
            ok: true,
            entry: { thinkingLevel },
            resolved: { model: model?.split('/')[1] || '', modelProvider: 'provider' },
          };
        }
        if (method === 'chat.history')
          return {
            messages: [
              {
                id: 'test-message',
                role: 'assistant',
                content:
                  '**Emphasis** and normal text.\n\n<script>window.injected=true</script>\n\n[unsafe](javascript:alert(1))',
              },
            ],
          };
        if (method === 'chat.send') return { runId: 'test-run' };
        return { ok: true, files: [], entries: [] };
      },
    };
  }, options);
  await page.goto(origin);
  return page;
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });
  try {
    for (const theme of ['dark', 'light']) {
      const page = await openApp(browser, { theme });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.locator('.message-body').waitFor();
      assert.equal(await page.evaluate(() => Boolean(window.injected)), false);
      assert.equal(
        await page.locator('.message-body script, .message-body a[href^="javascript:"]').count(),
        0
      );
      await page.keyboard.press('Control+,');
      await page.locator('#global-hotkey-recorder').waitFor();
      assert((await page.locator('#global-hotkey-recorder').textContent()).includes('Alt+Shift+3'));
      await page.locator('#global-hotkey-recorder').click();
      await page.keyboard.press('Control+Alt+9');
      await page.getByTitle('Reset to default (Alt+Shift+3)').click();
      assert.equal(await page.evaluate(() => window.testHotkeys.at(-1)), 'Alt+Shift+3');
      await page.keyboard.press('Escape');
      const model = page.getByRole('button', { name: 'Session model', exact: true });
      const effort = page.getByRole('button', { name: 'Reasoning effort', exact: true });
      for (const viewport of [
        { width: 1360, height: 860 },
        { width: 960, height: 620 },
      ]) {
        await page.setViewportSize(viewport);
        for (const trigger of [model, effort]) {
          await trigger.click();
          const popup = await page.getByRole('dialog').boundingBox();
          const anchor = await trigger.boundingBox();
          assert(popup.y >= 10 && popup.x >= 10 && popup.x + popup.width <= viewport.width - 10);
          assert(popup.y + popup.height <= anchor.y - 6);
          await page.keyboard.press('Escape');
        }
      }
      await model.click();
      await page.getByRole('textbox', { name: 'Search models' }).fill('Model 12');
      await page.getByRole('textbox', { name: 'Search models' }).press('ArrowDown');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() =>
        window.testRequests.some(
          (r) => r.method === 'sessions.patch' && r.params.model === 'provider/model-12'
        )
      );
      await effort.click();
      await page.getByRole('slider', { name: 'Reasoning effort' }).press('End');
      await page.waitForFunction(() =>
        window.testRequests.some(
          (r) => r.method === 'sessions.patch' && r.params.thinkingLevel === 'high'
        )
      );
      await page.keyboard.press('Escape');
      const input = page.getByRole('textbox', { name: 'Message Assistant', exact: true });
      await input.fill('Hello');
      await input.press('Shift+Enter');
      await input.type('world');
      assert.equal(await input.inputValue(), 'Hello\nworld');
      await page.locator('input[type=file]').setInputFiles({
        name: 'example.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('test attachment'),
      });
      await page.locator('.attachment-chip').waitFor();
      await input.press('Enter');
      await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Stop response', exact: true }).click();
      assert.deepEqual(errors, []);
      await page.close();
    }
    const saved = await openApp(browser, { hotkey: 'Control+Alt+8' });
    await saved.locator('.message-body').waitFor();
    assert.equal(await saved.evaluate(() => window.testHotkeys.at(-1)), 'Control+Alt+8');
    await saved.close();
    const failed = await openApp(browser, { loadError: true });
    await failed.getByRole('alert').filter({ hasText: 'Could not load settings' }).waitFor();
    await failed.keyboard.press('Control+,');
    await failed.getByRole('tab', { name: 'Gateway Profiles' }).click();
    await failed.getByRole('button', { name: '+ New Gateway Profile', exact: true }).click();
    await failed.getByRole('textbox', { name: 'Profile Name' }).fill('Recovery profile');
    await failed.getByRole('button', { name: '+ New', exact: true }).click();
    await failed.getByRole('button', { name: 'Delete Gateway profile' }).click();
    await failed.waitForTimeout(450);
    assert.equal(
      await failed.evaluate(() => window.testSaves.length),
      0,
      'Profile controls must not overwrite settings after a failed load'
    );
    await failed.close();
    const saveFailed = await openApp(browser, { saveError: true });
    await saveFailed.getByRole('alert').filter({ hasText: 'Could not save settings' }).waitFor();
    await saveFailed.keyboard.press('Control+,');
    await saveFailed.getByRole('tab', { name: 'Gateway Profiles' }).click();
    await saveFailed.getByRole('textbox', { name: 'Profile Name' }).fill('Updated profile');
    await saveFailed.waitForFunction(() =>
      window.testSaves.some(([profiles]) => profiles.some((p) => p.name === 'Updated profile'))
    );
    await saveFailed.getByRole('alert').filter({ hasText: 'Could not save settings' }).waitFor();
    await saveFailed.close();
    console.log(
      'PASS: production CSP/escaped Markdown, both themes, popup bounds, model/reasoning changes, attachments, send/stop, default/saved hotkeys, and profile-load failure protection.'
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
