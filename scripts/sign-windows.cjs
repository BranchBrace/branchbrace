// electron-builder custom signer (win.signtoolOptions.sign).
// electron-builder calls it for every Windows binary it produces: the app executable,
// the NSIS uninstaller and the installer itself. Signing goes through jsign, a Java
// Authenticode signer that runs on Linux, because the Windows build happens in the
// Wine container (ADR 0003) where signtool.exe and the Azure PowerShell module are absent.
// Default backend: Azure Artifact Signing (ADR 0004). Timestamping is automatic there.
const { execFileSync } = require('node:child_process');

function signingConfig(env = process.env) {
  const keystore = env.WINDOWS_SIGNING_KEYSTORE;
  if (!keystore) {
    if (env.WINDOWS_SIGNING_REQUIRED === '1') {
      throw new Error('Signing is required but WINDOWS_SIGNING_KEYSTORE is not set.');
    }
    return null;
  }
  if (!env.WINDOWS_SIGNING_ALIAS) throw new Error('WINDOWS_SIGNING_ALIAS is required (<account>/<certificate profile>).');
  if (!env.JSIGN_JAR) throw new Error('JSIGN_JAR is required (path to the pinned jsign jar).');
  return {
    jar: env.JSIGN_JAR,
    storetype: env.WINDOWS_SIGNING_STORETYPE || 'TRUSTEDSIGNING',
    keystore,
    alias: env.WINDOWS_SIGNING_ALIAS,
    storepass: env.WINDOWS_SIGNING_STOREPASS || null,
  };
}

function jsignArgs(file, config) {
  const args = ['-jar', config.jar, '--storetype', config.storetype, '--keystore', config.keystore, '--alias', config.alias];
  if (config.storepass) args.push('--storepass', config.storepass);
  args.push(file);
  return args;
}

async function sign(configuration) {
  const config = signingConfig();
  if (!config) {
    console.log(`  • unsigned (WINDOWS_SIGNING_KEYSTORE not set): ${configuration.path}`);
    return;
  }
  console.log(`  • signing with jsign (${config.storetype}): ${configuration.path}`);
  // The token travels as an argument to the child process only; it is never logged.
  execFileSync('java', jsignArgs(configuration.path, config), { stdio: ['ignore', 'inherit', 'inherit'] });
}

module.exports = sign;
module.exports.default = sign;
module.exports.signingConfig = signingConfig;
module.exports.jsignArgs = jsignArgs;
