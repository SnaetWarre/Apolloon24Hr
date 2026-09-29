import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEnvText, resolveServerAddress } from '../electron/server-config.js';

test('Electron server configuration follows PORT and preserves values containing equals signs', () => {
  const fileEnvironment = parseEnvText(`
    # Local packaged configuration
    PORT=6123
    TOKEN="part=one=part=two"
  `);
  const address = resolveServerAddress(fileEnvironment);

  assert.equal(fileEnvironment.TOKEN, 'part=one=part=two');
  assert.deepEqual(address, {
    port: 6123,
    publicPort: 6123,
    url: 'http://127.0.0.1:6123',
  });
});

test('Electron can advertise a different public port without opening its window on that port', () => {
  assert.deepEqual(resolveServerAddress({ PORT: '5173', PUBLIC_APP_PORT: '80' }), {
    port: 5173,
    publicPort: 80,
    url: 'http://127.0.0.1:5173',
  });
});
