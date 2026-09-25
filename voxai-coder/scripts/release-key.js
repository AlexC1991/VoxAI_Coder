/**
 * Make the release signing key, once.
 *
 *   npm run release-key
 *
 * The private half goes OUTSIDE the project (it must never be saved to CodeRook):
 *   %APPDATA%\voxai-coder-release\update-key.pem   (or $VOX_RELEASE_KEY)
 * The public half goes in resources/update-key.pem and ships inside the app, which
 * refuses any update not signed by the private half.
 *
 * Refuses to replace an existing key: installed copies trust only the key they
 * shipped with, so a new key means every user reinstalls by hand once.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const PRIV = process.env.VOX_RELEASE_KEY
  || path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'voxai-coder-release', 'update-key.pem');
const PUB = path.join(ROOT, 'resources', 'update-key.pem');

if (fs.existsSync(PRIV)) {
  console.error('A release key already exists at ' + PRIV + '\nNot replacing it: installed copies only trust the key they shipped with.');
  process.exit(1);
}
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.mkdirSync(path.dirname(PRIV), { recursive: true });
fs.writeFileSync(PRIV, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
fs.writeFileSync(PUB, publicKey.export({ type: 'spki', format: 'pem' }));
console.log('Private key: ' + PRIV + '  (keep a backup somewhere safe; never commit it)');
console.log('Public key:  ' + PUB + '  (ships in the app)');
