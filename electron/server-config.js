/** @returns {Record<string, string>} */
export function parseEnvText(content) {
  /** @type {Record<string, string>} */
  const values = {};
  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (key) values[key] = value;
  }
  return values;
}

export function resolveServerAddress(environment) {
  const port = readPort(environment.PORT, 5173);
  const publicPort = readPort(environment.PUBLIC_APP_PORT, port);
  return {
    port,
    publicPort,
    url: `http://127.0.0.1:${port}`,
  };
}

function readPort(value, fallback) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
}
