'use strict';
// macOS only. Apple Silicon refuses to open a downloaded app that has no signature at all and says it is "damaged".
// Signing it ad hoc (no Apple account, no certificate) gives it a valid signature, so macOS shows the normal
// "Apple could not verify..." prompt instead, and the app can be allowed in System Settings > Privacy & Security > Open Anyway.
// Runs after electron-builder packs the app and before the .dmg is made.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function adHocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  console.log(`  • ad-hoc signing ${appPath}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
};
