const assert = require('node:assert/strict');

module.exports = async function testWorkspaceWindow(browser, openApp) {
  const page = await openApp(browser);
  await page.locator('.message-body').first().waitFor();
  await page.setViewportSize({ width: 1360, height: 860 });
  const drawer = page.locator('.workspace-pane');
  const last = () => page.evaluate(() => window.testExpansions.at(-1));
  const waitForLast = (change, width) =>
    page.waitForFunction(
      ([c, w]) => {
        const e = window.testExpansions.at(-1);
        return e && e.change === c && (w === undefined || e.width === w);
      },
      [change, width]
    );
  const drawerWidth = () => drawer.evaluate((el) => Math.round(el.getBoundingClientRect().width));
  const chatWidth = () =>
    page.evaluate(() => {
      const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
      const pane = document.querySelector('.workspace-pane');
      const right = pane ? pane.getBoundingClientRect().left : innerWidth;
      return Math.round(right - sidebar.right);
    });

  assert.equal(await drawer.count(), 0);
  assert.equal((await last()).change, 'close', 'A closed workspace never widens the window');

  // Ctrl+Shift+E opens the drawer and asks to widen the window by it plus its drag handle.
  await page.keyboard.press('Control+Shift+E');
  await drawer.waitFor();
  const opened = await drawerWidth();
  assert.equal(opened, 800, 'The drawer opens at the 800 px default');
  await waitForLast('open', opened + 5);

  // Resizing the window resizes the drawer, not the chat.
  await page.waitForTimeout(200);
  const chatBefore = await chatWidth();
  await page.setViewportSize({ width: 1260, height: 860 });
  await page.waitForFunction((w) => {
    const pane = document.querySelector('.workspace-pane');
    return pane && Math.round(pane.getBoundingClientRect().width) === w;
  }, opened - 100);
  assert.equal(await chatWidth(), chatBefore, 'The chat keeps its width');
  await waitForLast('resize', opened - 100 + 5);
  // Past the drawer's minimum, the chat gives way.
  await page.setViewportSize({ width: 800, height: 860 });
  await page.waitForTimeout(200);
  assert.equal(await drawerWidth(), 300);
  // Growing back restores the same split.
  await page.setViewportSize({ width: 1360, height: 860 });
  await page.waitForFunction((w) => {
    const pane = document.querySelector('.workspace-pane');
    return pane && Math.round(pane.getBoundingClientRect().width) === w;
  }, opened);
  assert.equal(await chatWidth(), chatBefore);

  await page.keyboard.press('Control+Shift+E');
  await drawer.waitFor({ state: 'detached' });
  await waitForLast('close');

  // The title-bar button does the same.
  const button = page.getByTitle('Show or hide the agent workspace (Ctrl+Shift+E)', {
    exact: true,
  });
  assert.equal(await button.getAttribute('aria-keyshortcuts'), 'Control+Shift+E');
  await button.click();
  await drawer.waitFor();
  await waitForLast('open', opened + 5);

  // Turning the setting off while the workspace is open gives the width back.
  await page.keyboard.press('Control+,');
  const setting = page.getByRole('checkbox', {
    name: 'Widen the window when the workspace opens',
    exact: true,
  });
  assert.equal(await setting.isChecked(), true);
  await setting.uncheck();
  await waitForLast('close');

  // The shortcut is ignored while Settings is open.
  const before = await page.evaluate(() => window.testExpansions.length);
  await page.keyboard.press('Control+Shift+E');
  await page.waitForTimeout(150);
  assert.equal(await drawer.count(), 1, 'Ctrl+Shift+E does nothing while Settings is open');
  assert.equal(await page.evaluate(() => window.testExpansions.length), before);
  await page.keyboard.press('Escape');

  // With the setting off, the window is never widened.
  await page.keyboard.press('Control+Shift+E');
  await drawer.waitFor({ state: 'detached' });
  await page.keyboard.press('Control+Shift+E');
  await drawer.waitFor();
  await page.waitForTimeout(150);
  assert.ok(
    (await page.evaluate(() => window.testExpansions.slice(-2))).every((e) => e.change === 'close'),
    'No widening while the setting is off'
  );
  await page.close();
  console.log(
    'PASS: workspace window (800 px default, Ctrl+Shift+E, window resizes go to the drawer, setting on/off, ignored in Settings).'
  );
};
