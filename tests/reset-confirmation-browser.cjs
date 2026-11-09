const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
module.exports = async function testResetConfirmation(browser, openApp) {
  const options = (theme) => ({
    theme,
    sessionRows: [
      { key: 'main', agentId: 'main', label: 'Primary', sessionId: 'main-1' },
      { key: 'other', agentId: 'main', label: 'Background', sessionId: 'other-1' },
    ],
  });
  for (const theme of ['dark', 'light']) {
    const page = await openApp(browser, options(theme));
    let nativeDialogs = 0;
    page.on('dialog', async (dialog) => {
      nativeDialogs++;
      await dialog.dismiss();
    });
    await page.locator('.message-body').waitFor();
    const composer = page.getByRole('textbox', { name: 'Message Assistant', exact: true });
    await composer.fill('Keep this draft');
    await page.locator('input[type=file]').setInputFiles({
      name: 'keep.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Keep this attachment'),
    });
    await page.locator('.attachment-chip-name').filter({ hasText: 'keep.txt' }).waitFor();
    const reset = page.getByRole('button', { name: 'Reset session context', exact: true });
    const modal = page.getByRole('dialog', { name: 'Reset this session?', exact: true });
    const resetCount = () =>
      page.evaluate(() => window.testRequests.filter((r) => r.method === 'sessions.reset').length);
    const sendCount = () =>
      page.evaluate(() => window.testRequests.filter((r) => r.method === 'chat.send').length);
    const idle = () =>
      page.waitForFunction(
        () =>
          document
            .querySelector('[aria-label="Reset session context"]')
            .getAttribute('aria-busy') === 'false'
      );
    const respond = async (accept, key, label, trigger, dismiss = 'button') => {
      await trigger();
      await modal.waitFor();
      assert((await modal.textContent()).includes(key));
      assert((await modal.textContent()).includes(label));
      assert.equal(
        await modal
          .getByRole('button', { name: 'Cancel', exact: true })
          .evaluate((el) => el === document.activeElement),
        true
      );
      if (accept) {
        // Duplicate events must settle the pending decision only once.
        await modal.getByRole('button', { name: 'Reset session', exact: true }).evaluate((el) => {
          el.click();
          el.click();
        });
      } else if (dismiss === 'escape') await page.keyboard.press('Escape');
      else if (dismiss === 'enter') await page.keyboard.press('Enter');
      else await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
      await modal.waitFor({ state: 'detached' });
    };
    const original = await page.locator('.message-body').allTextContents();
    await reset.click();
    await modal.waitFor();
    const cancel = modal.getByRole('button', { name: 'Cancel', exact: true });
    assert.equal(await cancel.evaluate((el) => el === document.activeElement), true);
    await page.keyboard.press('Tab');
    assert.equal(
      await modal
        .getByRole('button', { name: 'Reset session', exact: true })
        .evaluate((el) => el === document.activeElement),
      true
    );
    await page.keyboard.press('Tab');
    assert.equal(
      await modal
        .getByRole('button', { name: 'Cancel reset', exact: true })
        .evaluate((el) => el === document.activeElement),
      true
    );
    await page.keyboard.press('Shift+Tab');
    assert.equal(
      await modal
        .getByRole('button', { name: 'Reset session', exact: true })
        .evaluate((el) => el === document.activeElement),
      true
    );
    await page.keyboard.press('Control+PageDown');
    await page.keyboard.press('Control+p');
    await page.keyboard.press('Control+,');
    assert.equal(await page.locator('.session-item.active .session-key').textContent(), 'Primary');
    assert.equal(await page.locator('.quick-switcher-input').count(), 0);
    assert.equal(await page.getByRole('dialog').count(), 1);
    await cancel.focus();
    const directory = path.join(__dirname, '..', '.local', 'reset-preview');
    await fs.mkdir(directory, { recursive: true });
    await page.screenshot({ path: path.join(directory, `${theme}.png`) });
    await page.setViewportSize({ width: 640, height: 650 });
    const bounds = await modal.boundingBox();
    assert(bounds.x >= 0 && bounds.x + bounds.width <= 641);
    await page.screenshot({ path: path.join(directory, `${theme}-compact.png`) });
    await page.setViewportSize({ width: 1360, height: 860 });
    await page.keyboard.press('Escape');
    await modal.waitFor({ state: 'detached' });
    assert.equal(await resetCount(), 0);
    assert.equal(await reset.getAttribute('aria-busy'), 'false');
    assert.equal(await composer.inputValue(), 'Keep this draft');
    assert.equal(await page.locator('.attachment-chip').count(), 1);
    assert.deepEqual(await page.locator('.message-body').allTextContents(), original);
    await respond(false, 'agent:main:main', 'Primary', () => reset.click(), 'enter');
    assert.equal(await resetCount(), 0);

    const background = async () => {
      await page
        .locator('.session-item')
        .filter({ hasText: 'Background' })
        .locator('.session-more-btn')
        .click();
      await page.getByRole('button', { name: 'Reset Session History', exact: true }).click();
    };
    await respond(false, 'agent:main:other', 'Background', background, 'escape');
    assert.equal(await resetCount(), 0);
    await respond(true, 'agent:main:other', 'Background', background);
    await page.waitForFunction(() =>
      window.testRequests.some(
        (r) => r.method === 'sessions.reset' && r.params.key === 'agent:main:other'
      )
    );
    await idle();
    assert.equal(await resetCount(), 1);
    assert.equal(await page.locator('.session-item.active .session-key').textContent(), 'Primary');
    assert.equal(await composer.inputValue(), 'Keep this draft');
    assert.equal(await page.locator('.attachment-chip').count(), 1);
    assert.deepEqual(await page.locator('.message-body').allTextContents(), original);

    const palette = async () => {
      await page.keyboard.press('Control+Shift+p');
      await page.locator('.quick-switcher-input').fill('>reset');
      await page.getByText('Reset / Clear Current Session', { exact: true }).click();
    };
    await respond(false, 'agent:main:main', 'Primary', palette);
    assert.equal(await resetCount(), 1);
    assert.equal(await sendCount(), 0);
    assert.equal(await composer.inputValue(), 'Keep this draft');
    await respond(true, 'agent:main:main', 'Primary', palette);
    await page.waitForFunction(
      () => window.testRequests.filter((r) => r.method === 'sessions.reset').length === 2
    );
    await idle();
    assert.equal(await composer.inputValue(), 'Keep this draft');
    assert.equal(await page.locator('.attachment-chip').count(), 1);

    for (const command of ['/reset', '/NEW continue with another task']) {
      await composer.fill(command);
      await respond(false, 'agent:main:main', 'Primary', () =>
        page.getByRole('button', { name: 'Send message', exact: true }).click()
      );
      assert.equal(await composer.inputValue(), command);
      assert.equal(await page.locator('.attachment-chip').count(), 1);
      assert.equal(await sendCount(), 0);
    }
    await composer.fill('/reset continue');
    await respond(true, 'agent:main:main', 'Primary', () =>
      page.getByRole('button', { name: 'Send message', exact: true }).click()
    );
    await page.waitForFunction(() =>
      window.testRequests.some(
        (r) => r.method === 'chat.send' && r.params.message === '/reset continue'
      )
    );
    assert.equal(await sendCount(), 1);
    assert.equal(await composer.inputValue(), '');
    await page.evaluate(() => window.testFinishRun('test-run'));
    await page.getByRole('button', { name: 'Send message', exact: true }).waitFor();
    await composer.fill('/resetting is an ordinary word');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.waitForFunction(
      () => window.testRequests.filter((r) => r.method === 'chat.send').length === 2
    );
    assert.equal(await resetCount(), 2);
    assert.equal(nativeDialogs, 0);
    await page.close();
  }
  // A stale asynchronous dialog must never reset a different connection or session.
  for (const change of ['disconnect', 'replace']) {
    const page = await openApp(browser, options('dark'));
    await page.locator('.message-body').waitFor();
    const composer = page.getByRole('textbox', { name: 'Message Assistant', exact: true });
    await composer.fill('/reset');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Reset this session?', exact: true });
    await modal.waitFor();
    await page.evaluate((change) => {
      if (change === 'disconnect') window.testEmitStatus({ state: 'disconnected' });
      else {
        window.testSessionRows.find((row) => row.key === 'main').sessionId = 'main-2';
        window.testEmitGatewayEvent({
          event: 'sessions.changed',
          payload: { key: 'agent:main:main' },
        });
      }
    }, change);
    await modal.waitFor({ state: 'detached' });
    assert.equal(
      await page.evaluate(
        () =>
          window.testRequests.filter(
            (r) => r.method === 'sessions.reset' || r.method === 'chat.send'
          ).length
      ),
      0
    );
    assert.equal(await composer.inputValue(), '/reset');
    await page.close();
  }
  console.log(
    'PASS: themed reset dialog, all reset entry points, Cancel/Enter/Escape, focus trapping, shortcut guards, stale-dialog cancellation, and both themes.'
  );
};
