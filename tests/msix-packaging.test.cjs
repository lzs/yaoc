const test = require('node:test');
const assert = require('node:assert/strict');
const { configuration, manifest } = require('../scripts/package-msix.cjs');
test('MSIX development versions preserve Beta timestamps within numeric limits', () => {
  const config = configuration('2026.1.0-dev01020003', {});
  assert.equal(config.version, '2026.102.3.0');
  assert.equal(config.name, 'io.github.lzs.yaoc.dev');
  assert.equal(config.developmentIdentity, true);
});
test('Store identity requires complete values and an explicit valid package version', () => {
  assert.throws(() => configuration('2026.1.0', { YAOC_MSIX_NAME: 'Example.YAOC' }), /all three/);
  const env = {
    YAOC_MSIX_NAME: 'Example.YAOC',
    YAOC_MSIX_PUBLISHER: 'CN=00000000-0000-0000-0000-000000000000',
    YAOC_MSIX_PUBLISHER_DISPLAY_NAME: 'Example & Company',
  };
  assert.throws(() => configuration('2026.1.0', env), /explicitly/);
  for (const version of ['1.2.3.4', '1.2.65536.0', '0.1.0.0', '1.02.3.0', '1.2.3', '../bad']) {
    assert.throws(
      () => configuration('2026.1.0', { ...env, YAOC_MSIX_VERSION: version }),
      /four integers/
    );
  }
  const config = configuration('2026.1.0', { ...env, YAOC_MSIX_VERSION: '2026.1.0.0' });
  assert.equal(config.developmentIdentity, false);
  const xml = manifest(config, 'arm64');
  assert.match(xml, /Example &amp; Company/);
  assert.match(xml, /ProcessorArchitecture="arm64"/);
  assert.doesNotMatch(xml, /FileSystemWriteVirtualization/);
  assert.doesNotMatch(xml, /unvirtualizedResources/);
  assert.match(xml, /Name="runFullTrust"/);
  assert.match(xml, /EntryPoint="Windows.FullTrustApplication"/);
  assert.throws(() => manifest(config, 'x86'), /Unsupported/);
});
