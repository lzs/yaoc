// Keep packaging's verification key aligned with the key compiled into updater.rs.
function installerConfig(env = process.env) {
  return {
    bundle: { createUpdaterArtifacts: !!env.TAURI_SIGNING_PRIVATE_KEY, windows: {} },
    plugins: { updater: { pubkey: env.YAOC_UPDATER_PUBLIC_KEY?.trim() || '' } },
  };
}
module.exports = { installerConfig };
