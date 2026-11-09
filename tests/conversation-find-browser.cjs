const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function testConversationFind(browser, openApp, root) {
  for (const theme of ['dark', 'light']) {
    const page = await openApp(browser, {
      theme,
      sessionRows: [
        { key: 'main', agentId: 'main' },
        { key: 'other', agentId: 'main' },
      ],
      historyMessages: [
        {
          id: 'find-first',
          role: 'user',
          content: 'Alpha alpha [literal]. café CAFÉ 例子\nA new line.',
        },
        {
          id: 'find-markdown',
          role: 'assistant',
          content:
            'An **alpha** example.\n\nCross **inline** text.\n\n```js\nconst alpha = "<script>safe</script>";\n```',
        },
        ...Array.from({ length: 20 }, (_, i) => ({
          id: `filler-${i}`,
          role: 'assistant',
          content: `Filler paragraph ${i}. ` + 'A longer conversation for scrolling. '.repeat(8),
        })),
        { id: 'find-last', role: 'assistant', content: 'Last ALPHA match.' },
      ],
    });
    await page.locator('.message-body').last().waitFor();
    const composer = page.getByRole('textbox', { name: 'Message Assistant', exact: true });
    await composer.fill('Keep this draft');
    const originalBodies = await page.locator('.message-body').allTextContents();
    await page.keyboard.press('Control+f');
    const input = page.getByRole('textbox', { name: 'Find in conversation', exact: true });
    const count = page.locator('.conversation-find-count');
    await input.waitFor();
    assert.equal(await input.evaluate((el) => el === document.activeElement), true);
    await input.fill('alpha');
    await page.waitForFunction(
      () => document.querySelector('.conversation-find-count')?.textContent === '1 of 5'
    );
    assert.equal(await page.evaluate(() => CSS.highlights.get('yaoc-find').size), 5);
    assert.equal(
      await page.evaluate(() =>
        CSS.highlights.get('yaoc-find-current').values().next().value.toString()
      ),
      'Alpha'
    );
    await input.press('Enter');
    assert.equal(await count.textContent(), '2 of 5');
    await input.press('Shift+Enter');
    assert.equal(await count.textContent(), '1 of 5');
    await page.getByRole('button', { name: 'Previous match', exact: true }).click();
    assert.equal(await count.textContent(), '5 of 5');
    await page.keyboard.press('F3');
    assert.equal(await count.textContent(), '1 of 5');
    await page.keyboard.press('Shift+F3');
    assert.equal(await count.textContent(), '5 of 5');
    const lastTop = await page.locator('.messages-container').evaluate((el) => el.scrollTop);
    await page.getByRole('button', { name: 'Next match', exact: true }).click();
    assert.equal(await count.textContent(), '1 of 5');
    assert((await page.locator('.messages-container').evaluate((el) => el.scrollTop)) < lastTop);
    assert.deepEqual(await page.locator('.message-body').allTextContents(), originalBodies);
    await page.keyboard.press('Control+f');
    assert.equal(
      await input.evaluate((el) => el.selectionStart === 0 && el.selectionEnd === el.value.length),
      true
    );
    await input.fill('cross inline text');
    await page.waitForFunction(
      () => document.querySelector('.conversation-find-count')?.textContent === '1 of 1'
    );
    assert.equal(
      await page.evaluate(() =>
        CSS.highlights.get('yaoc-find-current').values().next().value.toString()
      ),
      'Cross inline text'
    );
    await input.fill('[literal]');
    await page.waitForFunction(
      () => document.querySelector('.conversation-find-count')?.textContent === '1 of 1'
    );
    await input.fill('café');
    await page.waitForFunction(
      () => document.querySelector('.conversation-find-count')?.textContent === '1 of 2'
    );
    await input.fill('例子');
    await page.waitForFunction(
      () => document.querySelector('.conversation-find-count')?.textContent === '1 of 1'
    );
    await input.fill('Copy code block');
    await page.waitForFunction(
      () => document.querySelector('.conversation-find-count')?.textContent === 'No matches'
    );
    assert.equal(
      await page.getByRole('button', { name: 'Next match', exact: true }).isDisabled(),
      true
    );
    await input.fill('**alpha**');
    await page.waitForFunction(
      () => document.querySelector('.conversation-find-count')?.textContent === 'No matches'
    );
    await page.getByRole('button', { name: 'Raw', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector('.conversation-find-count')?.textContent === '1 of 1'
    );
    await page.getByRole('button', { name: 'Markdown', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector('.conversation-find-count')?.textContent === 'No matches'
    );
    await input.fill('alpha');
    await page.waitForFunction(
      () => document.querySelector('.conversation-find-count')?.textContent === '1 of 5'
    );
    // A new stream refreshes counts without taking the reader back to the bottom.
    const beforeStream = await page.locator('.messages-container').evaluate((el) => el.scrollTop);
    await page.evaluate(() =>
      window.testEmitGatewayEvent({
        event: 'chat',
        payload: {
          sessionKey: 'main',
          runId: 'find-stream',
          state: 'delta',
          delta: 'Another alpha arrives.',
        },
      })
    );
    await page.waitForFunction(
      () => document.querySelector('.conversation-find-count')?.textContent === '1 of 6'
    );
    assert(
      Math.abs(
        (await page.locator('.messages-container').evaluate((el) => el.scrollTop)) - beforeStream
      ) < 5
    );
    // Keep the active occurrence when React replaces a streaming text node's data.
    await page.getByRole('button', { name: 'Previous match', exact: true }).click();
    assert.equal(await count.textContent(), '6 of 6');
    await page.evaluate(() =>
      window.testEmitGatewayEvent({
        event: 'chat',
        payload: {
          sessionKey: 'main',
          runId: 'find-stream',
          state: 'delta',
          delta: ' A second alpha appears.',
        },
      })
    );
    await page.waitForFunction(() =>
      document.querySelector('.conversation-find-count')?.textContent.endsWith('of 7')
    );
    assert.equal(await count.textContent(), '6 of 7');
    await input.fill('');
    await input.fill('alpha');
    await page.waitForFunction(
      () => document.querySelector('.conversation-find-count')?.textContent === '1 of 7'
    );
    // Settings takes precedence over find shortcuts.
    await page.keyboard.press('Control+,');
    await page.keyboard.press('Control+f');
    await page.keyboard.press('Escape');
    assert.equal(await input.isVisible(), true);
    await page.getByRole('button', { name: 'Active Agent', exact: true }).click();
    await page.keyboard.press('Control+f');
    await page.keyboard.press('F3');
    assert.equal(await count.textContent(), '1 of 7');
    assert.equal(await input.evaluate((el) => el === document.activeElement), false);
    await page.keyboard.press('Escape');
    assert.equal(await input.isVisible(), true);
    await input.press('Escape');
    await input.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => CSS.highlights.has('yaoc-find')), false);
    assert.equal(await composer.inputValue(), 'Keep this draft');
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('aria-label') === 'Message Assistant'
    );
    await page.getByRole('button', { name: 'Find in conversation (Ctrl+F)', exact: true }).click();
    await input.fill('alpha');
    await page.waitForFunction(
      () => document.querySelector('.conversation-find-count')?.textContent === '1 of 7'
    );
    // Capture the real feature in both themes and a compact chat pane.
    await page.setViewportSize({ width: 900, height: 760 });
    const toolbar = await page.getByRole('search', { name: 'Find in conversation' }).boundingBox();
    const panel = await page.locator('.chat-pane').boundingBox();
    assert(toolbar.x >= panel.x && toolbar.x + toolbar.width <= panel.x + panel.width + 1);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false
    );
    const directory = path.join(root, '.local', 'find-preview');
    await fs.mkdir(directory, { recursive: true });
    await page.screenshot({ path: path.join(directory, `${theme}.png`) });
    await page.locator('.session-item').filter({ hasText: 'other' }).click();
    await input.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => CSS.highlights.has('yaoc-find')), false);
    await page.close();
  }
  console.log(
    'PASS: conversation find, literal/Unicode/inline/code matching, wrap navigation, streaming, focus, modal guards, session cleanup, and both themes.'
  );
};
