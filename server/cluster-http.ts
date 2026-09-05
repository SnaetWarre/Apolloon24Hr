const MAXIMUM_CLUSTER_RESPONSE_BYTES = 50 * 1_024 ** 2;

export async function readClusterResponseText(
  response: Response,
  maximumBytes = MAXIMUM_CLUSTER_RESPONSE_BYTES
): Promise<string> {
  if (Number(response.headers.get('content-length')) > maximumBytes) {
    await response.body?.cancel();
    throw new Error('cluster response exceeds the byte limit');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      receivedBytes += chunk.value.byteLength;
      if (receivedBytes > maximumBytes) {
        await reader.cancel();
        throw new Error('cluster response exceeds the byte limit');
      }
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks, receivedBytes).toString('utf8');
  } finally {
    reader.releaseLock();
  }
}

export async function readClusterResponseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await readClusterResponseText(response)) as T;
}
