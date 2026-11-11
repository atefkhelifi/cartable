// Web Push without extra packages: VAPID signing (RFC 8292) and aes128gcm payload encryption (RFC 8291).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

// The server's VAPID key pair: from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY, or made once and kept in DATA_DIR.
function loadKeys(dataDir) {
  let pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    const f = path.join(dataDir, 'vapid.json');
    try { ({ pub, priv } = JSON.parse(fs.readFileSync(f, 'utf8'))); } catch {
      const ecdh = crypto.createECDH('prime256v1');
      ecdh.generateKeys();
      pub = b64u(ecdh.getPublicKey());
      priv = b64u(ecdh.getPrivateKey());
      fs.writeFileSync(f, JSON.stringify({ pub, priv }), { mode: 0o600 });
    }
  }
  const raw = unb64u(pub);
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('VAPID_PUBLIC_KEY is not a P-256 public key');
  const key = crypto.createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33)), d: String(priv) },
  });
  return { publicKey: pub, key };
}

// "Authorization: vapid t=<JWT>, k=<public key>" for one push service.
function vapidHeader(keys, endpoint, subject) {
  const aud = new URL(endpoint).origin;
  const data = `${b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))}.${b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }))}`;
  const sig = crypto.sign('sha256', Buffer.from(data), { key: keys.key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${data}.${b64u(sig)}, k=${keys.publicKey}`;
}

// Encrypt a payload for one browser subscription (a single aes128gcm record).
function encrypt(sub, payload) {
  const uaPublic = unb64u(sub.p256dh), authSecret = unb64u(sub.auth);
  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head, 0);
  head.writeUInt32BE(4096, 16);
  head[20] = asPublic.length;
  return Buffer.concat([head, asPublic, body]);
}

// Send one notification. Resolves to 'ok', 'gone' (the subscription is dead: forget it) or 'error'.
async function send(keys, subject, sub, message, ttl = 3600) {
  try {
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        authorization: vapidHeader(keys, sub.endpoint, subject),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(ttl),
        urgency: 'high',
      },
      body: encrypt(sub, JSON.stringify(message)),
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
    if (res.status === 404 || res.status === 410) return 'gone';
    return res.ok ? 'ok' : 'error';
  } catch { return 'error'; }
}

// Only real push services get our requests (a subscription is just a URL a browser sent us).
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/, /\.push\.apple\.com$/, /\.notify\.windows\.com$/];
function allowedEndpoint(endpoint, allowLocal) {
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  if (allowLocal && u.protocol === 'http:' && u.hostname === '127.0.0.1') return true;
  return u.protocol === 'https:' && !u.port && PUSH_HOSTS.some((re) => re.test(u.hostname));
}

module.exports = { loadKeys, send, encrypt, allowedEndpoint };
