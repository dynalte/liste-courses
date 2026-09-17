/**
 * Réapplique les descriptions d'usage caméra/galerie dans Info.plist après `cap sync ios`
 * (la plateforme ios/ est régénérée et gitignorée).
 * Usage : node scripts/cap-ios-permissions.cjs
 */
const fs = require('fs');
const path = require('path');

const PLIST = path.join(__dirname, '..', 'ios', 'App', 'App', 'Info.plist');

const ENTRIES = {
  NSCameraUsageDescription: 'Prendre une photo du frigo ou scanner un code-barres produit.',
  NSPhotoLibraryUsageDescription: 'Choisir une photo du frigo depuis la galerie pour l\u2019analyser avec l\u2019IA.',
  NSPhotoLibraryAddUsageDescription: 'Enregistrer les photos si n\u00e9cessaire.',
  NSMicrophoneUsageDescription: 'Filmer le frigo : la capture vid\u00e9o iOS inclut le son, m\u00eame si seul l\u2019image est analys\u00e9e.',
};

function ensure(lines, key, value) {
  if (lines.some((l) => l.includes(`<string>${value}</string>`) || l.includes(key))) return lines;
  const idx = lines.findIndex((l) => l.includes('</dict>'));
  const block = [`\t<key>${key}</key>`, `\t<string>${value}</string>`];
  lines.splice(idx, 0, ...block);
  return lines;
}

try {
  if (!fs.existsSync(PLIST)) {
    console.log(`[cap-ios-permissions] ${PLIST} introuvable, ios/ non généré ?`);
    process.exit(0);
  }
  let lines = fs.readFileSync(PLIST, 'utf8').split('\n');
  for (const [k, v] of Object.entries(ENTRIES)) lines = ensure(lines, k, v);
  fs.writeFileSync(PLIST, lines.join('\n'));
  console.log('[cap-ios-permissions] Info.plist OK (caméra + galerie).');
} catch (e) {
  console.error(`[cap-ios-permissions] échec : ${e.message}`);
  process.exit(1);
}
