/**
 * Remonte la cible iOS mini à 16.0 (exigée par GoogleMLKit/BarcodeScanning).
 * À rejouer après `cap add ios` (plateforme régénérée et gitignorée).
 * Usage : node scripts/cap-ios-target.cjs
 */
const fs = require('fs');
const path = require('path');

const PODFILE = path.join(__dirname, '..', 'ios', 'App', 'Podfile');
const PBXPROJ = path.join(__dirname, '..', 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');

try {
  if (!fs.existsSync(PODFILE)) {
    console.log('[cap-ios-target] ios/ non généré, rien à faire.');
    process.exit(0);
  }
  let pod = fs.readFileSync(PODFILE, 'utf8');
  pod = pod.replace(/platform :ios, '[^']*'/, "platform :ios, '16.0'");
  fs.writeFileSync(PODFILE, pod);

  if (fs.existsSync(PBXPROJ)) {
    let pbx = fs.readFileSync(PBXPROJ, 'utf8');
    const before = pbx;
    pbx = pbx.replace(/IPHONEOS_DEPLOYMENT_TARGET = [0-9.]+;/g, 'IPHONEOS_DEPLOYMENT_TARGET = 16.0;');
    pbx = pbx.replace(/MARKETING_VERSION = [0-9.]+;/g, 'MARKETING_VERSION = 0.2.0;');
    pbx = pbx.replace(/CURRENT_PROJECT_VERSION = [0-9]+;/g, 'CURRENT_PROJECT_VERSION = 27;');
    if (pbx !== before) fs.writeFileSync(PBXPROJ, pbx);
  }
  console.log('[cap-ios-target] cible iOS mini = 16.0, version 0.2.0 (build 27).');
} catch (e) {
  console.error(`[cap-ios-target] échec : ${e.message}`);
  process.exit(1);
}
