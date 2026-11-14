const assert = require('node:assert/strict');

module.exports = async function testTranscriptExport(browser, openApp) {
  const historyMessages = [
    { id: 'u1', role: 'user', content: 'Show me the script', timestamp: 1763100000000 },
    {
      id: 'a1',
      role: 'assistant',
      timestamp: 1763100060000,
      content:
        'Here it is:\n\n```js\nconsole.log(1)\n```\n\n<script>window.injected=true</script> [docs](https://example.com) [bad](javascript:alert(1))',
    },
  ];
  const page = await openApp(browser, {
    historyMessages,
    sessionRows: [{ key: 'main', agentId: 'main', label: 'Primary', sessionId: 'main-1' }],
  });
  await page.locator('.message-body').first().waitFor();
  const exportButton = page.getByRole('button', {
    name: 'Export conversation (Markdown or HTML)',
    exact: true,
  });
  await exportButton.click();
  await page.getByRole('status').filter({ hasText: 'Exported to C:/Exports/' }).waitFor();
  const [exported] = await page.evaluate(() => window.testExports);
  assert.match(exported.fileName, /^Primary \d{4}-\d{2}-\d{2}$/);

  assert.match(exported.markdown, /^# Primary\n/);
  assert.match(exported.markdown, /## You · .+\n\nShow me the script/);
  assert.match(exported.markdown, /```js\nconsole\.log\(1\)\n```/);

  const html = exported.html;
  assert.match(html, /class="md-code-block"/, 'Message Markdown is rendered like the chat');
  assert.doesNotMatch(html, /<button/, 'Copy buttons are removed from the export');
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.match(html, /href="https:\/\/example\.com"/);
  assert.match(html, /default-src 'none'/);
  assert.equal(await page.evaluate(() => window.injected), undefined);

  await page.locator('.chat-export-status-close').click();
  assert.equal(await page.locator('.chat-export-status').count(), 0);
  await page.close();

  const failing = await openApp(browser, { historyMessages, exportError: true });
  await failing.locator('.message-body').first().waitFor();
  await failing
    .getByRole('button', { name: 'Export conversation (Markdown or HTML)', exact: true })
    .click();
  await failing.getByRole('alert').filter({ hasText: 'Could not export: Disk is full' }).waitFor();
  await failing.close();

  const empty = await openApp(browser, { historyMessages: [] });
  await empty.waitForTimeout(300);
  assert.equal(
    await empty
      .getByRole('button', { name: 'Export conversation (Markdown or HTML)', exact: true })
      .isDisabled(),
    true,
    'Export is disabled when there is nothing to export'
  );
  await empty.close();
  console.log(
    'PASS: conversation export (Markdown and rendered HTML, no copy buttons or scripts, success/error status, disabled when empty).'
  );
};
