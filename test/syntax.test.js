// Every JavaScript file parses, and French and Arabic translate the same keys.
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const files = ['server.js', ...fs.readdirSync(path.join(root, 'public/js')).map((f) => `public/js/${f}`)];

for (const f of files) {
  test(`${f} parses`, () => { execFileSync(process.execPath, ['--check', path.join(root, f)]); });
}

test('French and Arabic translate the same keys', () => {
  const src = fs.readFileSync(path.join(root, 'public/js/i18n.js'), 'utf8');
  const [frPart, arPart] = src.split(/\n\s*const ar = \{/);
  assert.ok(arPart, 'i18n.js still has `const ar = {`');
  // keys are the quoted strings at the start of each dictionary line
  const keys = (part) => new Set([...part.matchAll(/^\s{4}(['"])((?:\\.|(?!\1).)*)\1\s*:/gm)]
    .map((m) => m[2].replace(/\\(['"])/g, '$1')));
  const fr = keys(frPart), ar = keys(arPart);
  assert.ok(fr.size > 300 && ar.size > 300, `found only ${fr.size} French and ${ar.size} Arabic keys`);
  assert.deepEqual([...fr].filter((k) => !ar.has(k)), [], 'keys missing in Arabic');
  assert.deepEqual([...ar].filter((k) => !fr.has(k)), [], 'keys missing in French');
});
