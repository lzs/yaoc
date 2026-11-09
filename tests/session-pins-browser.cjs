const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
module.exports = async function testSessionPins(browser, openApp, root) {
  for (const theme of ['dark', 'light']) {
    const page = await openApp(browser, {
      theme,
      sessionRows: [
        { key: 'main', agentId: 'main', sessionId: 'main-id', label: 'Primary' },
        { key: 'project', agentId: 'main', sessionId: 'project-id', label: 'Project' },
        { key: 'research', agentId: 'main', label: 'Research', pinnedAt: 100 },
      ],
    });
    await page.locator('.message-body').waitFor();
    const rows = page.locator('.session-item');
    const names = () => rows.locator('.session-key').allTextContents();
    await page.waitForFunction(
      () => document.querySelector('.session-key')?.textContent === 'Research'
    );
    const selected = await page.locator('.session-item.active .session-key').textContent();
    const composer = page.getByRole('textbox', { name: 'Message Assistant', exact: true });
    await composer.fill('Keep draft while pinning');
    const menu = async (name) =>
      rows.filter({ hasText: name }).locator('.session-more-btn').click();
    await menu('Project');
    await page.getByRole('button', { name: 'Pin Session', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelectorAll('[aria-label="Pinned session"]').length === 2
    );
    assert.equal(await page.locator('.session-item.active .session-key').textContent(), selected);
    assert.equal(await composer.inputValue(), 'Keep draft while pinning');
    await page.waitForFunction(
      () => document.querySelector('.session-key')?.textContent === 'Project'
    );
    assert.deepEqual(await names(), ['Project', 'Research', 'Primary']);
    const request = await page.evaluate(() =>
      window.testRequests.find((r) => r.method === 'sessions.patch' && 'pinned' in r.params)
    );
    assert.deepEqual(request.params, {
      key: 'agent:main:project',
      pinned: true,
      expectedSessionId: 'project-id',
    });
    await menu('Project');
    await page.getByRole('button', { name: 'Unpin Session', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelectorAll('[aria-label="Pinned session"]').length === 1
    );
    assert.deepEqual(await names(), ['Research', 'Primary', 'Project']);
    // Simulate another client's pin, then an unpin tombstone and roster refresh.
    await page.evaluate(() => {
      window.testSessionRows.find((row) => row.key === 'project').pinnedAt = 200;
      delete window.testSessionRows.find((row) => row.key === 'project').pinned;
      window.testEmitGatewayEvent({
        event: 'sessions.changed',
        payload: { key: 'agent:main:project', pinnedAt: 200 },
      });
    });
    await page.waitForFunction(
      () => document.querySelectorAll('[aria-label="Pinned session"]').length === 2
    );
    const savedRows = await page.evaluate(() => window.testSessionRows);
    const fresh = await openApp(browser, { sessionRows: savedRows });
    await fresh.waitForFunction(
      () => document.querySelectorAll('[aria-label="Pinned session"]').length === 2
    );
    await fresh.close();
    await page.evaluate(() => {
      const project = window.testSessionRows.find((row) => row.key === 'project');
      delete project.pinnedAt;
      window.testEmitGatewayEvent({
        event: 'sessions.changed',
        payload: { key: 'agent:main:project', pinnedAt: null },
      });
    });
    await page.waitForFunction(
      () => document.querySelectorAll('[aria-label="Pinned session"]').length === 1
    );
    await page.getByTitle('Refresh Sessions from Gateway', { exact: true }).click();
    await page.waitForFunction(
      () => document.querySelectorAll('[aria-label="Pinned session"]').length === 1
    );
    await menu('Research');
    await page.getByRole('button', { name: 'Unpin Session', exact: true }).waitFor();
    const dir = path.join(root, '.local', 'pins-preview');
    await fs.mkdir(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, `${theme}.png`) });
    await page.close();
  }
  const failed = await openApp(browser, {
    rejectPins: 'Invalid params: unexpected property pinned',
    sessionRows: [{ key: 'main', agentId: 'main' }],
  });
  await failed.locator('.message-body').waitFor();
  await failed.locator('.session-more-btn').click();
  await failed.getByRole('button', { name: 'Pin Session', exact: true }).click();
  await failed
    .getByRole('alert')
    .filter({ hasText: 'This Gateway does not support session pins' })
    .waitFor();
  assert.equal(await failed.getByRole('img', { name: 'Pinned session', exact: true }).count(), 0);
  await failed.getByRole('button', { name: 'Dismiss pin error', exact: true }).click();
  await failed.locator('.session-pin-error').waitFor({ state: 'detached' });
  await failed.locator('.session-more-btn').click();
  await failed.evaluate(() => window.testEmitStatus({ state: 'disconnected' }));
  await failed.waitForFunction(() => document.querySelector('.session-popup-item').disabled);
  assert.equal(
    await failed.getByRole('button', { name: 'Pin Session', exact: true }).isDisabled(),
    true
  );
  await failed.close();
  const deferred = await openApp(browser, {
    deferPins: true,
    sessionRows: [{ key: 'main', agentId: 'main' }],
  });
  await deferred.locator('.message-body').waitFor();
  await deferred.locator('.session-more-btn').click();
  await deferred.getByRole('button', { name: 'Pin Session', exact: true }).click();
  const saving = deferred.getByRole('button', { name: 'Saving pin…', exact: true });
  await saving.waitFor();
  assert.equal(await saving.isDisabled(), true);
  assert.equal(await deferred.getByRole('img', { name: 'Pinned session', exact: true }).count(), 0);
  await saving.evaluate((el) => el.click());
  assert.equal(
    await deferred.evaluate(
      () =>
        window.testRequests.filter((r) => r.method === 'sessions.patch' && 'pinned' in r.params)
          .length
    ),
    1
  );
  await deferred.evaluate(() => window.testResolvePin());
  await deferred.getByRole('img', { name: 'Pinned session', exact: true }).waitFor();
  await deferred.close();
  console.log(
    'PASS: Gateway session pins, ordering, confirmed writes, remote changes, reopen/refresh, drafts, unsupported servers, and duplicate-click protection.'
  );
};
