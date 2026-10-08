import http, { type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import { isIsolated, PEER_REQUEST_TIMEOUT_MS, versionHeaders } from './peers.js';

/*
 * Appends and votes between laptops travel over one WebSocket per other
 * laptop instead of an HTTP request each: a heartbeat every 150 ms then costs
 * its JSON, not a round of headers. Each message carries an id, so answers
 * find their request whatever the order. Requests behave as before: they
 * resolve with the answer, with null when the other laptop refuses them, and
 * reject when it cannot be reached in time.
 */

export const PEER_SOCKET_PATH = '/api/cluster/peer';
/** As much as an HTTP request between laptops could carry. */
const MAX_MESSAGE_BYTES = 20 * 1024 * 1024;
/**
 * A large message gets this much longer to be answered: a 4 MB batch of logos takes about 3.5 s
 * over a cable that fell back to 10 Mbit. Heartbeats and votes are small and keep the short timeout.
 */
const SLOWEST_LINK_BYTES_PER_MS = 1_000;
/** A socket nothing was sent over for this long is closed, so old addresses do not linger. */
const IDLE_CLOSE_MS = 30_000;

export type PeerRequestType = 'append' | 'vote';
export type PeerAnswer = { body: unknown } | { refused: { code: string; error: string } };

type Pending = {
  resolve(answer: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

type Link = {
  socket: WebSocket;
  pending: Map<number, Pending>;
  /** Sent once the socket opens. */
  queued: string[];
  /** Set when the other laptop answered the upgrade with an HTTP error, like an HTTP request it refused. */
  refused: boolean;
  lastHeardAt: number;
  idleTimer: NodeJS.Timeout;
};

const links = new Map<string, Link>();
let nextId = 0;

/** Sends a request to the laptop at `url`; resolves with its answer, or null when refused; rejects when unreachable. */
export function peerRequest(url: string, type: PeerRequestType, body: unknown): Promise<unknown> {
  if (isIsolated()) return Promise.reject(new Error('isolated for a test'));
  const known = links.get(url);
  const link = known && known.socket.readyState <= WebSocket.OPEN ? known : connect(url);
  link.idleTimer.refresh();
  const id = (nextId += 1);
  const message = JSON.stringify({ id, type, body });
  const timeoutMs = PEER_REQUEST_TIMEOUT_MS + Math.round(message.length / SLOWEST_LINK_BYTES_PER_MS);
  return new Promise((resolve, reject) => {
    const sentAt = performance.now();
    const timer = setTimeout(() => {
      link.pending.delete(id);
      reject(new Error(`no answer within ${timeoutMs} ms`));
      // Nothing heard since this request went out: the laptop is gone or asleep, so start over on a fresh socket.
      if (link.lastHeardAt < sentAt) link.socket.terminate();
    }, timeoutMs);
    timer.unref();
    link.pending.set(id, { resolve, reject, timer });
    if (link.socket.readyState === WebSocket.OPEN) link.socket.send(message);
    else link.queued.push(message);
  });
}

function connect(url: string): Link {
  const socket = new WebSocket(`${url.replace(/^http/, 'ws')}${PEER_SOCKET_PATH}`, {
    headers: versionHeaders(),
    handshakeTimeout: PEER_REQUEST_TIMEOUT_MS,
    maxPayload: MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
  });
  const idleTimer = setTimeout(() => socket.close(), IDLE_CLOSE_MS);
  idleTimer.unref();
  const link: Link = { socket, pending: new Map(), queued: [], refused: false, lastHeardAt: 0, idleTimer };
  links.set(url, link);

  socket.on('unexpected-response', (_request, response) => {
    link.refused = true;
    response.resume();
    socket.terminate();
  });
  socket.on('open', () => {
    for (const message of link.queued) socket.send(message);
    link.queued = [];
  });
  socket.on('message', (data) => {
    link.lastHeardAt = performance.now();
    const answer = parse(data) as { id?: unknown; body?: unknown; refused?: unknown } | null;
    const request = typeof answer?.id === 'number' ? link.pending.get(answer.id) : undefined;
    if (!request || !answer) return;
    link.pending.delete(answer.id as number);
    clearTimeout(request.timer);
    request.resolve(answer.refused ? null : answer.body);
  });
  // A 'close' always follows.
  socket.on('error', () => undefined);
  socket.on('close', () => {
    clearTimeout(idleTimer);
    if (links.get(url) === link) links.delete(url);
    for (const request of link.pending.values()) {
      clearTimeout(request.timer);
      if (link.refused) request.resolve(null);
      else request.reject(new Error('connection to the other laptop closed'));
    }
    link.pending.clear();
  });
  return link;
}

// The other side: answering the laptops that connect here.

const server = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });

/** Takes over an upgrade request from another laptop; `answer` handles each request it sends. */
export function acceptPeerSocket(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  answer: (type: unknown, body: unknown) => PeerAnswer
): void {
  server.handleUpgrade(req, socket, head, (peer) => {
    peer.on('message', (data) => {
      const request = parse(data) as { id?: unknown; type?: unknown; body?: unknown } | null;
      if (typeof request?.id !== 'number') return;
      let reply: PeerAnswer;
      try {
        reply = isIsolated() ? refusal('isolated', 'isolated') : answer(request.type, request.body);
      } catch (error) {
        // What an HTTP endpoint would answer with a 500.
        reply = refusal('internal', error instanceof Error ? error.message : String(error));
      }
      peer.send(JSON.stringify({ id: request.id, ...reply }));
    });
    peer.on('error', () => peer.terminate());
  });
}

export function refusal(code: string, error: string): PeerAnswer {
  return { refused: { code, error } };
}

/** Answers an upgrade request with an HTTP error, as the HTTP endpoints would. */
export function refuseUpgrade(socket: Duplex, status: number, code: string, error: string): void {
  const body = JSON.stringify({ ok: false, code, error });
  socket.once('finish', () => socket.destroy());
  socket.end(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\n` +
      'Connection: close\r\nContent-Type: application/json\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
  );
}

/** Drops every socket to and from other laptops, as a pulled cable or a shutdown does. */
export function closePeerSockets(): void {
  for (const link of links.values()) link.socket.terminate();
  for (const peer of server.clients) peer.terminate();
}

function parse(data: WebSocket.RawData): unknown {
  try {
    return JSON.parse(String(data));
  } catch {
    return null;
  }
}
