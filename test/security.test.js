// Security headers, self-hosted fonts, and test-only features staying off outside tests.
const { describe, it, before, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, assert } = require('./helpers');

describe('security headers and fonts', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(() => srv?.stop());

  it('sends a content security policy and other protections', async () => {
    const r = await srv.api('/');
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self' https:\/\/cdn\.jsdelivr\.net https:\/\/cdnjs\.cloudflare\.com(;|$)/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.match(r.headers.get('permissions-policy'), /camera=\(self\)/);
  });

  it('pages have no inline scripts, and load no Google fonts', () => {
    for (const page of ['index.html', 'privacy.html']) {
      const html = fs.readFileSync(path.join(__dirname, '..', 'public', page), 'utf8');
      assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), `${page} has an inline script`);
      assert.ok(!/\son[a-z]+=/i.test(html), `${page} has an inline event handler`);
      assert.ok(!/fonts\.(googleapis|gstatic)\.com/.test(html), `${page} loads Google Fonts`);
    }
  });

  it('serves every font file named in fonts.css', async () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'fonts.css'), 'utf8');
    const urls = [...new Set([...css.matchAll(/url\((\/fonts\/[^)]+\.woff2)\)/g)].map((m) => m[1]))];
    assert.ok(urls.length >= 10);
    for (const u of urls) {
      const r = await srv.api(u);
      assert.equal(r.status, 200, u);
    }
  });
});

describe('outside tests', () => {
  let srv;
  before(async () => { srv = await startServer({ env: { NODE_ENV: 'development' } }); });
  after(() => srv?.stop());

  it('has no test-only reminder route, and refuses local push addresses', async () => {
    assert.equal((await srv.post('/api/test/reminders', {})).status, 404);
    const tok = await srv.signup('amel');
    const sub = { endpoint: 'http://127.0.0.1:9/x', keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16).toString('base64url') } };
    assert.equal((await srv.post('/api/push/subscribe', { subscription: sub }, tok)).status, 400);
  });
});
