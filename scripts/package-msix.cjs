// Package already-built Windows payloads. MSIX signing is separate from Tauri updater signing.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const sharp = require('sharp');
const root = path.resolve(__dirname, '..');
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const xml = (text) =>
  String(text).replace(
    /[<>&"']/g,
    (c) =>
      ({
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        '"': '&quot;',
        "'": '&apos;',
      })[c]
  );
function configuration(version, env = process.env) {
  const identityKeys = [
    'YAOC_MSIX_NAME',
    'YAOC_MSIX_PUBLISHER',
    'YAOC_MSIX_PUBLISHER_DISPLAY_NAME',
  ];
  const custom = identityKeys.some((key) => env[key]);
  if (custom && identityKeys.some((key) => !env[key]?.trim()))
    throw new Error('Supply all three YAOC_MSIX identity values together.');
  if (custom && !env.YAOC_MSIX_VERSION)
    throw new Error('Set YAOC_MSIX_VERSION explicitly for your Store identity.');
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-dev(\d{4})(\d{4}))?$/.exec(version);
  if (!match) throw new Error('Unsupported application version: ' + version);
  const numeric =
    env.YAOC_MSIX_VERSION ||
    (match[4]
      ? [match[1], Number(match[4]), Number(match[5]), 0].join('.')
      : [match[1], match[2], match[3], 0].join('.'));
  const parts = numeric.split('.');
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^(0|[1-9]\d*)$/.test(part) || Number(part) > 65535) ||
    Number(parts[0]) === 0 ||
    parts[3] !== '0'
  )
    throw new Error(
      'MSIX version must be four integers in range, with nonzero major and final component 0.'
    );
  const name = env.YAOC_MSIX_NAME?.trim() || 'io.github.lzs.yaoc.dev';
  if (!/^[A-Za-z0-9.-]{3,50}$/.test(name)) throw new Error('Invalid MSIX identity name.');
  return {
    name,
    publisher: env.YAOC_MSIX_PUBLISHER?.trim() || 'CN=YAOC Development',
    publisherDisplayName: env.YAOC_MSIX_PUBLISHER_DISPLAY_NAME?.trim() || 'Lai Zit Seng',
    displayName: custom ? 'YAOC' : 'YAOC Beta',
    version: numeric,
    developmentIdentity: !custom,
  };
}
function manifest(config, arch) {
  if (!['x64', 'arm64'].includes(arch)) throw new Error('Unsupported MSIX architecture.');
  return `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
 xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
 xmlns:desktop6="http://schemas.microsoft.com/appx/manifest/desktop/windows10/6"
 xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
 IgnorableNamespaces="uap desktop6 rescap">
 <Identity Name="${xml(config.name)}" Publisher="${xml(config.publisher)}" Version="${config.version}" ProcessorArchitecture="${arch}"/>
 <Properties>
  <DisplayName>${xml(config.displayName)}</DisplayName>
  <PublisherDisplayName>${xml(config.publisherDisplayName)}</PublisherDisplayName>
  <Logo>Assets\\StoreLogo.png</Logo>
  <desktop6:FileSystemWriteVirtualization>disabled</desktop6:FileSystemWriteVirtualization>
 </Properties>
 <Resources><Resource Language="en-us"/></Resources>
 <Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26100.0"/></Dependencies>
 <Applications>
  <Application Id="YAOC" Executable="yaoc.exe" EntryPoint="Windows.FullTrustApplication">
   <uap:VisualElements DisplayName="${xml(config.displayName)}" Description="OpenClaw Gateway Chat and Workspace Client"
    BackgroundColor="transparent" Square150x150Logo="Assets\\Square150x150Logo.png" Square44x44Logo="Assets\\Square44x44Logo.png">
    <uap:DefaultTile Wide310x150Logo="Assets\\Wide310x150Logo.png"/>
   </uap:VisualElements>
  </Application>
 </Applications>
 <Capabilities>
  <rescap:Capability Name="runFullTrust"/>
  <rescap:Capability Name="unvirtualizedResources"/>
 </Capabilities>
</Package>
`;
}
function makeAppx(env = process.env) {
  if (env.YAOC_MAKEAPPX) return env.YAOC_MAKEAPPX;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const bases = [
    path.join(root, '.local/msix-tools/sdk/bin'),
    path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits/10/bin'),
  ];
  for (const base of bases) {
    if (!fs.existsSync(base)) continue;
    for (const name of fs
      .readdirSync(base)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
      const candidate = path.join(base, name, arch, 'makeappx.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error(
    'MakeAppx.exe not found. Set YAOC_MAKEAPPX or install Windows SDK build tools locally; see docs/BUILD.md.'
  );
}
function run(tool, args, options = {}) {
  const result = cp.spawnSync(tool, args, {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(path.basename(tool) + ' failed (' + result.status + ')');
}
async function main() {
  if (process.platform !== 'win32') throw new Error('MSIX packaging requires Windows.');
  const version = require('../package.json').version;
  const identityPath = path.join(root, 'src-tauri/windows/msix-store.json');
  const store =
    /^\d+\.\d+\.\d+$/.test(version) && fs.existsSync(identityPath)
      ? JSON.parse(fs.readFileSync(identityPath, 'utf8'))
      : null;
  const config = configuration(
    version,
    store
      ? {
          YAOC_MSIX_NAME: store.name,
          YAOC_MSIX_PUBLISHER: store.publisher,
          YAOC_MSIX_PUBLISHER_DISPLAY_NAME: store.publisherDisplayName,
          YAOC_MSIX_VERSION: version + '.0',
          ...process.env,
        }
      : process.env
  );
  const tool = makeAppx();
  const output = path.join(root, 'release/msix');
  const work = path.join(root, '.local/msix-staging');
  fs.mkdirSync(work, { recursive: true });
  const stage = fs.mkdtempSync(path.join(work, 'package-'));
  const packages = path.join(stage, 'packages');
  fs.mkdirSync(packages);
  fs.mkdirSync(output, { recursive: true });
  const artifacts = [];
  for (const arch of ['x64', 'arm64']) {
    const exe = path.join(root, 'release', 'yaoc-' + arch + '.exe');
    const check = cp.spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-Item -LiteralPath $env:YAOC_MSIX_EXE).VersionInfo.ProductVersion',
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, YAOC_MSIX_EXE: exe },
      }
    );
    if (check.status !== 0 || check.stdout.trim() !== version)
      throw new Error(
        'Rebuild both Beta architectures first; stale or missing ' + arch + ' payload.'
      );
    const layout = path.join(stage, arch);
    const assets = path.join(layout, 'Assets');
    fs.mkdirSync(assets, { recursive: true });
    fs.copyFileSync(exe, path.join(layout, 'yaoc.exe'));
    for (const name of ['LICENSE', 'THIRD_PARTY_LICENSES.txt'])
      fs.copyFileSync(path.join(root, name), path.join(layout, name));
    for (const [name, width, height] of [
      ['StoreLogo.png', 50, 50],
      ['Square44x44Logo.png', 44, 44],
      ['Square150x150Logo.png', 150, 150],
      ['Wide310x150Logo.png', 310, 150],
    ]) {
      await sharp(path.join(root, 'src/assets/yaoc.svg'))
        .resize(width, height, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toFile(path.join(assets, name));
    }
    fs.writeFileSync(path.join(layout, 'AppxManifest.xml'), manifest(config, arch));
    const name = 'yaoc-' + arch + '.msix';
    run(tool, ['pack', '/o', '/h', 'SHA256', '/d', layout, '/p', path.join(packages, name)]);
    artifacts.push(name);
  }
  run(tool, [
    'bundle',
    '/o',
    '/bv',
    config.version,
    '/d',
    packages,
    '/p',
    path.join(stage, 'yaoc.msixbundle'),
  ]);
  for (const name of artifacts) fs.copyFileSync(path.join(packages, name), path.join(output, name));
  fs.copyFileSync(path.join(stage, 'yaoc.msixbundle'), path.join(output, 'yaoc.msixbundle'));
  artifacts.push('yaoc.msixbundle');
  fs.writeFileSync(
    path.join(output, 'SHA256SUMS.txt'),
    artifacts.map((name) => hash(path.join(output, name)) + '  ' + name).join('\n') + '\n'
  );
  fs.writeFileSync(
    path.join(output, 'build-info.json'),
    JSON.stringify(
      {
        applicationVersion: version,
        ...config,
        signed: false,
        minimumWindowsVersion: '10.0.19041.0',
        webview2: 'Requires installed Microsoft Edge WebView2 Runtime; the loader is embedded.',
        payloads: Object.fromEntries(
          ['x64', 'arm64'].map((arch) => [
            arch,
            hash(path.join(root, 'release/yaoc-' + arch + '.exe')),
          ])
        ),
      },
      null,
      2
    ) + '\n'
  );
  fs.writeFileSync(
    path.join(output, 'README.txt'),
    [
      'YAOC MSIX packages — application ' + version + ', package ' + config.version,
      config.developmentIdentity
        ? 'DEVELOPMENT IDENTITY: not ready for Microsoft Store submission.'
        : 'Custom identity: verify exact Partner Center values before Store submission.',
      'UNSIGNED: direct installation requires signing with a certificate trusted on the target computer.',
      'Microsoft Store signs approved submissions. Tauri updater keys cannot sign MSIX.',
      'Packages support Windows 10 2004+ and require Microsoft Edge WebView2 Runtime.',
      'MSIX updates are managed by the Store or MSIX distribution source, never the NSIS updater.',
      'Shared AppData is preserved using unvirtualizedResources; explain this restricted capability in Store submission.',
      'See docs/BUILD.md for identity, versioning, validation, and signing details.',
    ].join('\r\n') + '\r\n'
  );
  console.log(
    'Unsigned ' +
      (config.developmentIdentity ? 'development' : 'custom-identity') +
      ' MSIX packages: ' +
      output
  );
}
module.exports = { configuration, manifest };
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
