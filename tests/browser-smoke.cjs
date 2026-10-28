const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const origin = 'http://127.0.0.1:4179';
const sourcePreview = process.env.YAOC_TEST_SOURCE_PREVIEW === '1';

async function openApp(browser, options = {}) {
  const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
  const config = JSON.parse(await fs.readFile(path.join(root, 'src-tauri/tauri.conf.json')));
  if (!sourcePreview)
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
    const gatewayCallbacks = new Set();
    const runWaiters = new Map();
    const runResults = new Map();
    window.testFinishRun = (runId, status = 'ok') => {
      runResults.set(runId, { status });
      runWaiters.get(runId)?.({ status });
    };
    window.testEmitGatewayEvent = (frame) => {
      for (const callback of gatewayCallbacks) callback(frame);
      if (
        !options.manualRunCompletion &&
        frame.event === 'chat' &&
        frame.payload?.state === 'final'
      ) {
        window.testFinishRun(frame.payload.runId);
      }
    };
    let thinkingLevel = 'medium';
    let model = 'provider/model-a';
    const thinkingMetadata = () =>
      options.legacyThinking
        ? {}
        : {
            thinkingLevels:
              options.thinkingLevels ||
              (model === 'provider/model-12'
                ? [
                    { id: 'off', label: 'None' },
                    { id: 'low', label: 'Low' },
                    { id: 'high', label: 'High' },
                  ]
                : [
                    { id: 'off', label: 'None' },
                    { id: 'adaptive', label: 'Adaptive' },
                    { id: 'low', label: 'Low' },
                    { id: 'medium', label: 'Medium' },
                    { id: 'high', label: 'High' },
                    { id: 'xhigh', label: 'Extra high' },
                  ]),
            thinkingDefault: model === 'provider/model-12' ? 'low' : 'adaptive',
          };
    window.testRequests = [];
    window.testSaves = [];
    window.testHotkeys = [];
    window.testSessionRows = options.sessionRows;
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
      onGatewayEvent: (callback) => {
        gatewayCallbacks.add(callback);
        return () => gatewayCallbacks.delete(callback);
      },
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
            sessions:
              window.testSessionRows ||
              (options.sessionAliases
                ? [
                    { key: 'test-2', agentId: 'main', label: 'Friendly test' },
                    {
                      key: 'agent:main:test-2',
                      agentId: 'main',
                      model: 'model-a',
                      modelProvider: 'provider',
                      thinkingLevel,
                    },
                  ]
                : [
                    {
                      key: 'main',
                      agentId: 'main',
                      model: model.split('/')[1],
                      modelProvider: 'provider',
                      thinkingLevel,
                      ...thinkingMetadata(),
                    },
                  ]),
          };
        if (method === 'models.list')
          return {
            models: Array.from({ length: 30 }, (_, i) => ({
              id: i === 0 ? 'model-a' : `model-${i}`,
              provider: 'provider',
              name: i === 0 ? 'Model A' : `Model ${i}`,
              ...thinkingMetadata(),
            })),
          };
        if (method === 'sessions.patch') {
          if ('label' in params && options.rejectSessionLabel) {
            return { ok: false, error: { message: 'Label denied by fixture' } };
          }
          if ('model' in params) model = params.model;
          if ('thinkingLevel' in params) {
            if (options.rejectThinking) throw new Error('Reasoning denied by fixture');
            thinkingLevel = params.thinkingLevel;
          }
          return {
            ok: true,
            entry: { thinkingLevel },
            resolved: {
              model: model?.split('/')[1] || '',
              modelProvider: 'provider',
              ...thinkingMetadata(),
            },
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
        if (method === 'agent.wait') {
          return (
            runResults.get(params.runId) ||
            new Promise((resolve) => runWaiters.set(params.runId, resolve))
          );
        }
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
      await page.locator('.message-body').waitFor();
      const reload = page.getByRole('button', { name: 'Reload chat', exact: true });
      const reset = page.getByRole('button', { name: 'Reset session context', exact: true });
      await reload.focus();
      await page.locator('#reload-chat-tooltip').waitFor({ state: 'visible' });
      assert.equal(await reload.getAttribute('title'), null);
      await page.keyboard.press('Escape');
      await page.locator('#reload-chat-tooltip').waitFor({ state: 'hidden' });
      await page.evaluate(() => {
        const request = window.openclawApi.request;
        window.testActionCalls = [];
        window.openclawApi.request = (method, params) => {
          if (method === 'chat.history' || method === 'sessions.reset') {
            window.testActionCalls.push(method);
            return new Promise((resolve, reject) => {
              window.testReleaseAction = resolve;
              window.testRejectAction = () => reject(new Error('Action denied by fixture'));
            });
          }
          return request(method, params);
        };
      });
      await reload.click();
      await page.waitForFunction(
        () =>
          document.querySelector('[aria-label="Reload chat"]').getAttribute('aria-busy') === 'true'
      );
      assert.equal(await reload.locator('.spin-icon').count(), 1);
      assert.equal(await reset.isDisabled(), true);
      await reload.evaluate((el) => el.click());
      assert.equal(await page.evaluate(() => window.testActionCalls.length), 1);
      await page.evaluate(() => window.testReleaseAction({ messages: [] }));
      await page.waitForFunction(
        () =>
          document.querySelector('[aria-label="Reload chat"]').getAttribute('aria-busy') === 'false'
      );
      await reset.click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[aria-label="Reset session context"]')
            .getAttribute('aria-busy') === 'true'
      );
      assert.equal(await reset.locator('.spin-icon').count(), 1);
      assert.equal(await reload.isDisabled(), true);
      await page.evaluate(() => window.testReleaseAction({ ok: true }));
      const notice = page.locator('.message-card.system').filter({ hasText: 'was reset.' });
      await notice.waitFor();
      assert.equal(await notice.evaluate((el) => el.classList.contains('error')), false);
      assert.equal(
        await notice.evaluate((el) => getComputedStyle(el).backgroundColor),
        await page.evaluate(() => {
          const sample = document.createElement('div');
          sample.style.background = 'var(--bg-elevated)';
          document.body.append(sample);
          const color = getComputedStyle(sample).backgroundColor;
          sample.remove();
          return color;
        })
      );
      await page.waitForFunction(
        () =>
          document
            .querySelector('[aria-label="Reset session context"]')
            .getAttribute('aria-busy') === 'false'
      );
      await reset.hover();
      await page.locator('#reset-session-tooltip').waitFor({ state: 'visible' });
      await page.screenshot({ path: path.join(root, '.local', `chat-feedback-${theme}.png`) });
      await reset.click();
      await page.waitForFunction(() => window.testActionCalls.length === 3);
      await page.evaluate(() => window.testRejectAction());
      await page
        .locator('.message-card.system.error')
        .filter({ hasText: 'Could not reset session:' })
        .waitFor();
      await page.close();
    }
    {
      const focusPage = await openApp(browser);
      const composer = focusPage.getByRole('textbox', { name: 'Message Assistant', exact: true });
      await composer.waitFor();
      const expectComposerFocus = () =>
        focusPage.waitForFunction(() => document.activeElement?.matches('.composer-input'));
      await expectComposerFocus();
      await focusPage.evaluate(() => window.openclawApi.disconnect());
      await composer.fill('Offline draft');
      await expectComposerFocus();
      assert.equal(
        await focusPage.getByRole('button', { name: 'Send message', exact: true }).isDisabled(),
        true
      );
      await composer.evaluate((el) => el.blur());
      await expectComposerFocus();
      await focusPage.evaluate(() => window.openclawApi.connect());
      await expectComposerFocus();
      assert.equal(await composer.inputValue(), 'Offline draft');
      const attachButton = focusPage.getByRole('button', {
        name: 'Attach images or files',
        exact: true,
      });
      await attachButton.focus();
      await focusPage.evaluate(() => window.dispatchEvent(new Event('focus')));
      await focusPage.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      );
      assert.equal(await attachButton.evaluate((el) => document.activeElement === el), true);
      await composer.focus();
      await focusPage.keyboard.press('Control+p');
      await focusPage.getByRole('dialog').waitFor();
      assert.equal(await composer.evaluate((el) => document.activeElement === el), false);
      await focusPage.keyboard.press('Escape');
      await expectComposerFocus();
      await focusPage.close();
    }

    for (const theme of ['dark', 'light']) {
      const tokenPage = await openApp(browser, {
        theme,
        sessionRows: [
          {
            key: 'main',
            agentId: 'main',
            totalTokens: 42100,
            contextTokens: 128000,
            inputTokens: 40000,
            outputTokens: 2100,
          },
          { key: 'other', agentId: 'main', totalTokens: 90000, contextTokens: 100000 },
        ],
      });
      const meter = tokenPage.locator('.session-token-meter');
      await meter.filter({ hasText: 'Tokens: 42.1K / 128K (33%)' }).waitFor();
      assert.equal(await tokenPage.locator('.chat-session-header .session-token-meter').count(), 0);
      assert.equal(await tokenPage.locator('.composer-toolbar .session-token-meter').count(), 1);
      assert.equal(
        await meter.evaluate((el) => el.nextElementSibling?.matches('.session-model-refresh')),
        true
      );
      assert.ok((await meter.getAttribute('class')).includes('token-low'));
      await meter.focus();
      await meter.locator('.session-token-tooltip').waitFor({ state: 'visible' });
      const tooltipBounds = await meter.locator('.session-token-tooltip').boundingBox();
      const meterBounds = await meter.boundingBox();
      assert.ok(tooltipBounds.y >= 0 && tooltipBounds.y + tooltipBounds.height <= meterBounds.y);
      assert.match(await meter.getAttribute('aria-label'), /Input: 40,000\nOutput: 2,100/);
      await tokenPage.locator('.session-item').filter({ hasText: 'other' }).click();
      await meter.filter({ hasText: 'Tokens: 90K / 100K (90%)' }).waitFor();
      assert.ok((await meter.getAttribute('class')).includes('token-high'));
      const updateUsage = async (values) => {
        await tokenPage.evaluate((values) => {
          window.testSessionRows = [
            { key: 'main', agentId: 'main' },
            { key: 'other', agentId: 'main', ...values },
          ];
          window.testEmitGatewayEvent({
            event: 'sessions.updated',
            payload: {
              sessions: window.testSessionRows,
            },
          });
        }, values);
      };
      await updateUsage({ totalTokens: 60000, contextTokens: 100000 });
      await meter.filter({ hasText: '(60%)' }).waitFor();
      assert.ok((await meter.getAttribute('class')).includes('token-medium'));
      await updateUsage({ totalTokens: 85000, contextTokens: 100000 });
      await meter.filter({ hasText: '(85%)' }).waitFor();
      assert.ok((await meter.getAttribute('class')).includes('token-medium'));
      await updateUsage({ totalTokens: 120000, contextTokens: 100000 });
      await meter.filter({ hasText: '(120%)' }).waitFor();
      await updateUsage({ totalTokens: 0, contextTokens: 0 });
      await meter.filter({ hasText: 'Tokens: 0' }).waitFor();
      assert.equal(await meter.locator('span').nth(1).innerText(), 'Tokens: 0');
      await updateUsage({ totalTokens: -1, contextTokens: 100000 });
      await meter.filter({ hasText: 'Tokens unavailable' }).waitFor();
      await updateUsage({ totalTokens: 42 });
      await meter.filter({ hasText: 'Tokens: 42' }).waitFor();
      assert.equal(await meter.locator('span').nth(1).innerText(), 'Tokens: 42');
      await updateUsage({});
      await meter.filter({ hasText: 'Tokens unavailable' }).waitFor();
      await tokenPage.setViewportSize({ width: 900, height: 700 });
      const narrowMeter = await meter.boundingBox();
      const narrowRefresh = await tokenPage.locator('.session-model-refresh').boundingBox();
      assert.ok(narrowMeter.x + narrowMeter.width <= narrowRefresh.x);
      assert.ok(
        Math.abs(
          narrowMeter.y + narrowMeter.height / 2 - narrowRefresh.y - narrowRefresh.height / 2
        ) < 1
      );
      assert.equal(
        await tokenPage
          .locator('.composer-toolbar')
          .evaluate((el) => el.scrollWidth > el.clientWidth),
        false
      );
      // Sidebars can constrain the chat pane independently of the native window width.
      await updateUsage({ totalTokens: 42100, contextTokens: 128000 });
      await meter.filter({ hasText: 'Tokens: 42.1K / 128K (33%)' }).waitFor();
      for (const width of [500, 400, 300]) {
        await tokenPage.locator('.chat-pane').evaluate((el, width) => {
          el.style.flex = 'none';
          el.style.width = `${width}px`;
        }, width);
        assert.equal(
          await tokenPage
            .locator('.session-model-row')
            .evaluate((el) => el.scrollWidth > el.clientWidth),
          false,
          `Model controls overflow at ${width}px`
        );
        const header = await tokenPage.locator('.chat-session-header').boundingBox();
        const actions = await tokenPage.locator('.chat-session-actions').boundingBox();
        assert.ok(
          actions.y + actions.height <= header.y + header.height,
          `Header actions extend into the transcript at ${width}px`
        );
        const token = await meter.boundingBox();
        const refresh = await tokenPage.locator('.session-model-refresh').boundingBox();
        assert.ok(token.x + token.width <= refresh.x);
        assert.ok(Math.abs(token.y + token.height / 2 - refresh.y - refresh.height / 2) < 1);
        for (const name of ['Session model', 'Reasoning effort']) {
          const selector = tokenPage.getByRole('button', { name, exact: true });
          await selector.click();
          await tokenPage.getByRole('dialog').waitFor();
          await tokenPage.keyboard.press('Escape');
        }
      }
      await tokenPage.close();
    }
    for (const theme of ['dark', 'light']) {
      const page = await openApp(browser, { theme });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.locator('.message-body').waitFor();
      assert.equal(
        await page
          .locator('.sidebar')
          .getByText(/win32|x86_64/)
          .count(),
        0
      );
      assert.equal(await page.evaluate(() => Boolean(window.injected)), false);
      assert.equal(
        await page.locator('.message-body script, .message-body a[href^="javascript:"]').count(),
        0
      );
      await page.getByRole('button', { name: 'Show keyboard shortcuts', exact: true }).click();
      const shortcuts = page.getByRole('tabpanel', { name: 'Shortcuts', exact: true });
      await shortcuts.getByText('Ctrl+P', { exact: true }).waitFor();
      await shortcuts.getByText('Ctrl+Shift+P', { exact: true }).waitFor();
      await shortcuts.getByText('Alt+Shift+3', { exact: true }).waitFor();
      await page.keyboard.press('Escape');
      const draftInput = page.getByRole('textbox', { name: 'Message Assistant', exact: true });
      await draftInput.fill('Keep this draft?');
      await page.keyboard.press('Control+/');
      await shortcuts.waitFor();
      await page.keyboard.press('Escape');
      assert.equal(await draftInput.inputValue(), 'Keep this draft?');
      await page.keyboard.press('Control+Shift+P');
      await page.getByPlaceholder('Type a command or action...').fill('>keyboard shortcuts');
      await page.getByRole('option').filter({ hasText: 'Show Keyboard Shortcuts' }).click();
      await shortcuts.waitFor();
      assert.equal(await page.getByRole('dialog', { name: 'Quick Switcher' }).count(), 0);
      await page.keyboard.press('Escape');
      await draftInput.fill('');
      await page.keyboard.press('Control+,');
      await page.getByRole('tab', { name: 'General', exact: true }).click();
      const activeChat = await page.locator('.session-item.active .session-key').innerText();
      // Navigate from a form control too, rather than requiring focus on a tab.
      await page.locator('#theme-select').focus();
      for (const tab of ['Gateway Profiles', 'Shortcuts', 'About', 'General']) {
        await page.keyboard.press('Control+PageDown');
        assert.equal(
          await page.getByRole('tab', { name: tab, exact: true }).getAttribute('aria-selected'),
          'true'
        );
        assert.equal(
          await page
            .getByRole('tab', { name: tab, exact: true })
            .evaluate((el) => el === document.activeElement),
          true
        );
        assert.equal(
          await page.locator('.session-item.active .session-key').innerText(),
          activeChat
        );
      }
      await page.keyboard.press('Control+PageUp');
      await page
        .getByRole('tabpanel', { name: 'About', exact: true })
        .getByText('Platform / Arch', { exact: true })
        .waitFor();
      await page.keyboard.press('Control+PageDown');
      await page.locator('#global-hotkey-recorder').waitFor();
      assert.equal(await page.getByText('Build & Version Info', { exact: true }).count(), 0);
      await page.getByRole('tab', { name: 'General', exact: true }).focus();
      await page.keyboard.press('End');
      assert.equal(
        await page.getByRole('tab', { name: 'About', exact: true }).getAttribute('aria-selected'),
        'true'
      );
      const about = page.getByRole('tabpanel', { name: 'About', exact: true });
      await about.getByText('Build & Version Info', { exact: true }).waitFor();
      await about.getByText('Beta / Testing', { exact: true }).waitFor();
      const appVersion = JSON.parse(await fs.readFile(path.join(root, 'package.json'))).version;
      await about.getByText(appVersion, { exact: true }).waitFor();
      await page.keyboard.press('ArrowDown');
      assert.equal(
        await page.getByRole('tab', { name: 'General', exact: true }).getAttribute('aria-selected'),
        'true'
      );
      assert((await page.locator('#global-hotkey-recorder').textContent()).includes('Alt+Shift+3'));
      await page.locator('#global-hotkey-recorder').click();
      await page.keyboard.press('Control+Alt+9');
      await page.getByTitle('Reset to default (Alt+Shift+3)').click();
      assert.equal(await page.evaluate(() => window.testHotkeys.at(-1)), 'Alt+Shift+3');
      await page.getByRole('button', { name: 'Disable', exact: true }).click();
      await page.getByRole('tab', { name: 'Shortcuts', exact: true }).click();
      await shortcuts.getByText('Disabled', { exact: true }).waitFor();
      await page.getByRole('tab', { name: 'General', exact: true }).click();
      await page.getByTitle('Reset to default (Alt+Shift+3)').click();
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
      await effort.click();
      const popup = page.getByRole('dialog', { name: 'Reasoning effort settings' });
      const slider = popup.getByRole('slider', { name: 'Reasoning effort' });
      await popup.getByRole('button', { name: 'Adaptive', exact: true }).click();
      await page.waitForFunction(() =>
        window.testRequests.some(
          (r) => r.method === 'sessions.patch' && r.params.thinkingLevel === 'adaptive'
        )
      );
      assert.equal(
        await popup
          .getByRole('button', { name: 'Adaptive', exact: true })
          .getAttribute('aria-pressed'),
        'true'
      );
      assert.equal(
        await popup.locator('.thinking-slider-track').getAttribute('class'),
        'thinking-slider-track is-muted'
      );
      await slider.press('End');
      await page.waitForFunction(() =>
        window.testRequests.some(
          (r) => r.method === 'sessions.patch' && r.params.thinkingLevel === 'xhigh'
        )
      );
      assert.equal(
        await popup
          .getByRole('button', { name: 'Adaptive', exact: true })
          .getAttribute('aria-pressed'),
        'false'
      );
      assert.equal(
        await popup.locator('.thinking-slider-track').getAttribute('class'),
        'thinking-slider-track is-active'
      );
      await popup.getByRole('button', { name: 'None', exact: true }).click();
      await page.waitForFunction(() =>
        window.testRequests.some(
          (r) => r.method === 'sessions.patch' && r.params.thinkingLevel === 'off'
        )
      );
      assert.equal(
        await popup.getByRole('button', { name: 'None', exact: true }).getAttribute('aria-pressed'),
        'true'
      );
      await popup.getByRole('button', { name: 'Default', exact: true }).click();
      await page.waitForFunction(() =>
        window.testRequests.some(
          (r) => r.method === 'sessions.patch' && r.params.thinkingLevel === null
        )
      );
      assert.equal(
        await popup
          .getByRole('button', { name: 'Default', exact: true })
          .getAttribute('aria-pressed'),
        'true'
      );
      await page.keyboard.press('Escape');
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
      assert.equal(
        await page.getByRole('button', { name: 'Adaptive', exact: true }).isDisabled(),
        true
      );
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
    const tracked = await openApp(browser, { manualRunCompletion: true });
    const trackedComposer = tracked.getByRole('textbox', {
      name: 'Message Assistant',
      exact: true,
    });
    await trackedComposer.fill('Wait for the whole run');
    await trackedComposer.press('Enter');
    await tracked.waitForFunction(() => window.testRequests.some((r) => r.method === 'agent.wait'));
    await tracked.evaluate(() => {
      window.testEmitGatewayEvent({
        event: 'chat',
        payload: {
          sessionKey: 'main',
          runId: 'test-run',
          state: 'final',
          message: { content: 'First message' },
        },
      });
      window.testEmitGatewayEvent({
        event: 'agent',
        payload: {
          sessionKey: 'main',
          runId: 'older-run',
          stream: 'lifecycle',
          data: { phase: 'end' },
        },
      });
      window.testEmitGatewayEvent({
        event: 'chat',
        payload: { sessionKey: 'main', runId: 'test-run', state: 'delta', delta: 'More work' },
      });
    });
    await tracked.locator('.message-body').filter({ hasText: 'More work' }).waitFor();
    assert.equal(
      await tracked.getByRole('button', { name: 'Stop response', exact: true }).isVisible(),
      true,
      'Message boundaries and stale ends must keep the current run busy'
    );
    await tracked.evaluate(() => window.testFinishRun('test-run'));
    await tracked.getByRole('button', { name: 'Send message', exact: true }).waitFor();
    await tracked.evaluate(() =>
      window.testEmitGatewayEvent({
        event: 'agent',
        payload: {
          sessionKey: 'main',
          runId: 'test-run',
          stream: 'lifecycle',
          data: { phase: 'end' },
        },
      })
    );
    assert.equal(
      await tracked.getByRole('button', { name: 'Send message', exact: true }).isVisible(),
      true
    );
    await tracked.close();

    const created = await openApp(browser);
    await created.locator('.message-body').waitFor();
    await created.getByTitle('New Session', { exact: true }).click();
    await created.getByPlaceholder('Session key (e.g. feature-x)').fill('test-2');
    await created.getByPlaceholder('Session key (e.g. feature-x)').press('Enter');
    assert.equal(
      await created
        .locator('.session-key')
        .filter({ hasText: /^test-2$/ })
        .count(),
      1
    );
    const composer = created.getByRole('textbox', { name: 'Message Assistant', exact: true });
    await composer.fill('Hello');
    await composer.press('Enter');
    await created.waitForFunction(() =>
      window.testRequests.some(
        (r) => r.method === 'chat.send' && r.params.sessionKey === 'agent:main:test-2'
      )
    );
    await created.evaluate(() =>
      window.testEmitGatewayEvent({
        event: 'chat',
        payload: {
          sessionKey: 'agent:main:test-2',
          runId: 'test-run',
          state: 'delta',
          delta: 'Immediate canonical reply',
        },
      })
    );
    await created
      .locator('.message-body')
      .filter({ hasText: 'Immediate canonical reply' })
      .waitFor();
    assert.equal(
      await created.locator('.session-item').count(),
      2,
      'No duplicate row after qualified event'
    );
    assert.equal(
      await created
        .locator('.session-key')
        .filter({ hasText: /^agent:main:test-2$/ })
        .count(),
      0
    );
    await created.evaluate(() =>
      window.testEmitGatewayEvent({
        event: 'chat',
        payload: {
          sessionKey: 'agent:main:test-2',
          runId: 'test-run',
          state: 'final',
          message: { content: 'Immediate canonical reply' },
        },
      })
    );
    await created.getByRole('button', { name: 'Send message', exact: true }).waitFor();
    assert.equal(
      await created.getByRole('button', { name: 'Stop response', exact: true }).count(),
      0
    );
    assert.equal(await created.locator('.session-status-spinner').count(), 0);
    await created.close();
    const aliases = await openApp(browser, { sessionAliases: true });
    await aliases.locator('.message-body').waitFor();
    assert.equal(
      await aliases.locator('.session-item').count(),
      1,
      'Legacy and qualified list aliases collapse'
    );
    assert.equal(await aliases.locator('.session-key').textContent(), 'Friendly test');
    assert(
      await aliases.evaluate(() =>
        window.testRequests.some(
          (r) => r.method === 'chat.history' && r.params.sessionKey === 'agent:main:test-2'
        )
      )
    );
    await aliases.close();
    const mixed = await openApp(browser);
    await mixed.locator('.message-body').waitFor();
    await mixed.getByTitle('New Session', { exact: true }).click();
    await mixed.getByPlaceholder('Session key (e.g. feature-x)').fill('SoCLaaS');
    await mixed.getByPlaceholder('Session key (e.g. feature-x)').press('Enter');
    await mixed.waitForFunction(() =>
      window.testRequests.some(
        (r) =>
          r.method === 'sessions.patch' &&
          r.params.key === 'agent:main:soclaas' &&
          r.params.label === 'SoCLaaS'
      )
    );
    const savedLabel = await mixed.evaluate(
      () =>
        window.testRequests.find(
          (r) => r.method === 'sessions.patch' && r.params.key === 'agent:main:soclaas'
        ).params
    );
    const mixedComposer = mixed.getByRole('textbox', { name: 'Message Assistant', exact: true });
    await mixedComposer.fill('Hello from SoCLaaS');
    await mixedComposer.press('Enter');
    await mixed.waitForFunction(() =>
      window.testRequests.some(
        (r) => r.method === 'chat.send' && r.params.sessionKey === 'agent:main:soclaas'
      )
    );
    await mixed.evaluate(() =>
      window.testEmitGatewayEvent({
        event: 'chat',
        payload: {
          sessionKey: 'agent:main:soclaas',
          runId: 'test-run',
          state: 'delta',
          delta: 'Mixed-case immediate reply',
        },
      })
    );
    await mixed
      .locator('.message-body')
      .filter({ hasText: 'Mixed-case immediate reply' })
      .waitFor();
    assert.equal(
      await mixed.locator('.session-item').count(),
      2,
      'Lowercase events do not create a second mixed-case session'
    );
    assert.equal(await mixed.locator('.session-item.active .session-key').textContent(), 'SoCLaaS');
    assert.equal(await mixed.locator('.session-status-spinner').count(), 1);
    await mixed.evaluate(() =>
      window.testEmitGatewayEvent({
        event: 'chat',
        payload: {
          sessionKey: 'agent:main:soclaas',
          runId: 'test-run',
          state: 'final',
          message: { content: 'Mixed-case immediate reply' },
        },
      })
    );
    await mixed.getByRole('button', { name: 'Send message', exact: true }).waitFor();
    assert.equal(await mixed.locator('.session-status-spinner').count(), 0);
    await mixed.evaluate(() => {
      window.testSessionRows = [{ key: 'agent:main:soclaas', agentId: 'main' }];
    });
    await mixed.getByTitle('Refresh Sessions from Gateway', { exact: true }).click();
    await mixed.waitForFunction(() => document.querySelectorAll('.session-item').length === 1);
    assert.equal(
      await mixed.locator('.session-item.active .session-key').textContent(),
      'SoCLaaS',
      'List refresh retains the typed label'
    );
    await mixed.close();
    // A fresh app has no local label cache; recover only Gateway-owned metadata.
    const restarted = await openApp(browser, { sessionRows: [savedLabel] });
    await restarted.locator('.message-body').waitFor();
    assert.equal(
      await restarted.locator('.session-item.active .session-key').textContent(),
      'SoCLaaS',
      'Capitalization survives restart through the Gateway label'
    );
    await restarted.close();
    const labelRejected = await openApp(browser, { rejectSessionLabel: true });
    await labelRejected.locator('.message-body').waitFor();
    const labelWarning = new Promise((resolve) =>
      labelRejected.once('dialog', async (dialog) => {
        assert.match(
          dialog.message(),
          /name could not be saved to OpenClaw: Label denied by fixture/
        );
        await dialog.accept();
        resolve();
      })
    );
    await labelRejected.getByTitle('New Session', { exact: true }).click();
    await labelRejected.getByPlaceholder('Session key (e.g. feature-x)').fill('Unsaved Name');
    await labelRejected.getByPlaceholder('Session key (e.g. feature-x)').press('Enter');
    await labelWarning;
    assert.equal(
      await labelRejected.locator('.session-item.active .session-key').textContent(),
      'Unsaved Name'
    );
    await labelRejected.close();
    const caseAliases = await openApp(browser, {
      sessionRows: [
        { key: 'agent:main:SoCLaaS', label: 'SoCLaaS' },
        { key: 'agent:main:soclaas', model: 'model-a', modelProvider: 'provider' },
      ],
    });
    await caseAliases.locator('.message-body').waitFor();
    assert.equal(
      await caseAliases.locator('.session-item').count(),
      1,
      'Existing mixed-case list aliases collapse'
    );
    assert.equal(
      await caseAliases.locator('.session-item.active .session-key').textContent(),
      'SoCLaaS'
    );
    await caseAliases.close();
    const legacy = await openApp(browser, { legacyThinking: true });
    await legacy.locator('.message-body').waitFor();
    await legacy.getByRole('button', { name: 'Reasoning effort', exact: true }).click();
    assert.equal(
      await legacy.getByRole('button', { name: 'Adaptive', exact: true }).isDisabled(),
      true
    );
    assert.equal(
      await legacy.getByRole('slider', { name: 'Reasoning effort' }).getAttribute('max'),
      '3'
    );
    await legacy.close();
    const binary = await openApp(browser, {
      thinkingLevels: [
        { id: 'off', label: 'None' },
        { id: 'on', label: 'On' },
      ],
    });
    await binary.locator('.message-body').waitFor();
    await binary.getByRole('button', { name: 'Reasoning effort', exact: true }).click();
    assert.equal(await binary.getByRole('slider').count(), 0);
    await binary.getByRole('button', { name: 'On', exact: true }).click();
    await binary.waitForFunction(() =>
      window.testRequests.some(
        (r) => r.method === 'sessions.patch' && r.params.thinkingLevel === 'on'
      )
    );
    await binary.close();
    const empty = await openApp(browser, { thinkingLevels: [] });
    await empty.locator('.message-body').waitFor();
    await empty.getByRole('button', { name: 'Reasoning effort', exact: true }).click();
    assert.equal(await empty.getByRole('slider').count(), 0);
    assert.equal(await empty.getByRole('button', { name: 'None', exact: true }).isDisabled(), true);
    assert.equal(
      await empty.getByRole('button', { name: 'Adaptive', exact: true }).isDisabled(),
      true
    );
    await empty.close();
    const rejected = await openApp(browser, { rejectThinking: true });
    await rejected.locator('.message-body').waitFor();
    await rejected.getByRole('button', { name: 'Reasoning effort', exact: true }).click();
    await rejected.getByRole('button', { name: 'Adaptive', exact: true }).click();
    await rejected.getByRole('alert').filter({ hasText: 'Reasoning denied by fixture' }).waitFor();
    assert.equal(
      await rejected
        .getByRole('button', { name: 'Adaptive', exact: true })
        .getAttribute('aria-pressed'),
      'false'
    );
    assert.equal(
      await rejected.locator('.thinking-slider-track').getAttribute('class'),
      'thinking-slider-track is-active'
    );
    await rejected.close();
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
      (sourcePreview
        ? 'PASS: source preview/escaped Markdown,'
        : 'PASS: production CSP/escaped Markdown,') +
        ' both themes, popup bounds, model/reasoning changes, attachments, send/stop, default/saved hotkeys, and profile-load failure protection.'
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
