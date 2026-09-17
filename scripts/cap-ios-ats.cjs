/**
 * Exception ATS (App Transport Security) pour l'API PHP perso.
 *
 * L'API tourne en HTTP clair sur photos2.dynaspirit.com:8080. Sans exception,
 * iOS bloque tout HTTP (le fetch échoue avec "Load failed" à la connexion).
 * `server.cleartext` de Capacitor ne couvre qu'Android : ce script injecte
 * NSExceptionDomains dans ios/App/App/Info.plist (idempotent, préservé par
 * `cap sync` mais pas par `cap add` -> d'où son exécution après chaque sync).
 * Même pattern que download-manager-ionic/scripts/cap-ios-ats.cjs.
 */
const fs = require('fs');
const path = require('path');

const PLIST = path.join(__dirname, '..', 'ios', 'App', 'App', 'Info.plist');
const DOMAIN = 'photos2.dynaspirit.com';

const ATS_BLOCK = [
  '\t<key>NSAppTransportSecurity</key>',
  '\t<dict>',
  '\t\t<key>NSExceptionDomains</key>',
  '\t\t<dict>',
  `\t\t\t<key>${DOMAIN}</key>`,
  '\t\t\t<dict>',
  '\t\t\t\t<key>NSExceptionAllowsInsecureHTTPLoads</key>',
  '\t\t\t\t<true/>',
  '\t\t\t\t<key>NSIncludesSubdomains</key>',
  '\t\t\t\t<true/>',
  '\t\t\t</dict>',
  '\t\t</dict>',
  '\t</dict>',
].join('\n');

function main() {
  if (!fs.existsSync(PLIST)) {
    console.log(`[ats] ${PLIST} introuvable (plateforme iOS non ajoutée ?) : rien à faire.`);
    return;
  }
  const src = fs.readFileSync(PLIST, 'utf8');
  if (src.includes('NSAppTransportSecurity') && src.includes(DOMAIN)) {
    console.log('[ats] Exceptions ATS déjà présentes.');
    return;
  }
  if (src.includes('NSAppTransportSecurity')) {
    console.error('[ats] NSAppTransportSecurity existe déjà sans le domaine : édition manuelle requise.');
    process.exit(1);
  }
  const idx = src.lastIndexOf('</dict>');
  if (idx === -1) {
    console.error('[ats] Info.plist invalide (pas de </dict>).');
    process.exit(1);
  }
  const out = `${src.slice(0, idx)}${ATS_BLOCK}\n${src.slice(idx)}`;
  fs.writeFileSync(PLIST, out);
  console.log(`[ats] Exception ATS ajoutée pour ${DOMAIN}.`);
}

main();
