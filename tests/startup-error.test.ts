import assert from 'node:assert/strict';
import test from 'node:test';
import { describeStartupFailure, describeUnexpectedStartupError, StartupError } from '../electron/startup-error.ts';

const LOG = 'C:\\Users\\leerkracht\\AppData\\Roaming\\Apolloon Telsysteem\\server.log';
const exited = (errorOutput: string, exitCode: number | null = 1) =>
  describeStartupFailure({ kind: 'server-exited', exitCode, errorOutput, port: 5173 }, LOG);

test('a port taken by another program is named, with the port', () => {
  const { message, detail } = exited(
    'Error: listen EADDRINUSE: address already in use :::5173\n    at Server.setupListenHandle'
  );
  assert.equal(message, 'Poort 5173 is al in gebruik.');
  assert.match(detail, /server\.log/);
});

test('common database and disk problems get their own explanation', () => {
  assert.match(exited('Error: database or disk is full').message, /schijf .* vol/);
  assert.match(exited('Error: EACCES: permission denied, open app.db').message, /niet .* schrijven/);
  assert.match(exited('Error: database is locked').message, /in gebruik/);
  assert.match(exited('Error: file is not a database').message, /beschadigd/);
});

test('anything else says the server stopped and quotes the error', () => {
  const { message, detail } = exited('TypeError: Cannot read properties of undefined\n    at initDb', 7);
  assert.equal(message, 'De lokale server stopte tijdens het opstarten.');
  assert.match(detail, /Foutmelding: TypeError: Cannot read properties of undefined \(code 7\)/);
  assert.match(detail, new RegExp(LOG.replaceAll('\\', '\\\\')));
});

test('a slow server, an empty screen and unexpected errors are explained in Dutch', () => {
  assert.equal(
    describeStartupFailure({ kind: 'server-timeout', seconds: 20, port: 5173 }, LOG).message,
    'De lokale server reageerde niet binnen 20 seconden.'
  );
  const screen = new StartupError({ kind: 'screen', detail: 'De pagina bleef leeg.' });
  assert.equal(describeUnexpectedStartupError(screen, LOG).message, 'Het scherm van Apolloon kon niet worden geladen.');
  const other = describeUnexpectedStartupError(new Error('boom'), LOG);
  assert.equal(other.message, 'Apolloon kon niet starten.');
  assert.match(other.detail, /Foutmelding: boom/);
});
