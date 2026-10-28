'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Small standards-based DER encoder; no external process or certificate service.
function der(tag, ...parts) {
  const body = Buffer.concat(parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p)));
  let length = body.length;
  const size = [];
  do { size.unshift(length & 255); length >>>= 8; } while (length);
  return Buffer.concat([Buffer.from([tag]), body.length < 128 ? Buffer.from([body.length]) : Buffer.from([128 | size.length, ...size]), body]);
}
const seq = (...p) => der(0x30, ...p);
const oid = hex => der(6, Buffer.from(hex, 'hex'));
const algorithm = () => seq(oid('2a864886f70d01010b'), der(5, Buffer.alloc(0)));
const name = () => seq(der(0x31, seq(oid('550403'), der(12, Buffer.from('LocalSend Rebuilt')))));
const time = d => der(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));

function createCertificate() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const now = new Date(Date.now() - 86400000);
  const expires = new Date(); expires.setUTCFullYear(expires.getUTCFullYear() + 5);
  const serial = crypto.randomBytes(16); serial[0] &= 0x7f; serial[0] |= 1;
  const tbs = seq(der(0xa0, der(2, Buffer.from([2]))), der(2, serial), algorithm(), name(),
    seq(time(now), time(expires)), name(), publicKey.export({ type: 'spki', format: 'der' }));
  const signature = crypto.sign('RSA-SHA256', tbs, privateKey);
  const certificate = seq(tbs, algorithm(), der(3, Buffer.from([0]), signature));
  const cert = `-----BEGIN CERTIFICATE-----\n${certificate.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert };
}

function loadCertificate(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const certPath = path.join(dataDir, 'certificate.pem');
  const keyPath = path.join(dataDir, 'private-key.pem');
  let pair;
  try { pair = { cert: fs.readFileSync(certPath, 'utf8'), key: fs.readFileSync(keyPath, 'utf8') }; new crypto.X509Certificate(pair.cert); }
  catch { pair = createCertificate(); fs.writeFileSync(keyPath, pair.key, { mode: 0o600 }); fs.writeFileSync(certPath, pair.cert); }
  return { ...pair, fingerprint: new crypto.X509Certificate(pair.cert).fingerprint256.replaceAll(':', '') };
}

module.exports = { createCertificate, loadCertificate };
