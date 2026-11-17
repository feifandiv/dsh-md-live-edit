/**
 * Host-half tests: the write route must apply the same Host/Origin fence and
 * browser authentication that every other authenticated Host route asks
 * `connection` for, and must do nothing else when that gate rejects it.
 *
 * Run with: node --test test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { apply, inject } from '../index.js';

const SESSION_ID = 'session-test';
const CWD = '/work';
const DEPLOYMENT_ROOT = '/deployment-root';
const LIVE_SESSION = { header: { cwd: CWD } };

/**
 * Build a plugin context and run apply(), capturing the registered route.
 * @param {object} options - rejection value returned by requestRejection, and fs overrides.
 * @returns the captured handler plus spies for every side effect we forbid on rejection.
 */
function mount({ rejection, writeImpl, resolveImpl, withoutFence = false, live = true, resolvePolicy } = {}) {
  const state = {
    handler: undefined,
    rejections: 0,
    resolved: [],
    written: [],
    policyRequests: [],
  };
  const ctx = {
    get(name) {
      if (name === 'agents') {
        return live ? { get: () => ({ session: LIVE_SESSION }) } : undefined;
      }
      if (name === 'sandboxPolicy') {
        return {
          workspaceRoot: DEPLOYMENT_ROOT,
          resolve(request) {
            state.policyRequests.push(request);
            return resolvePolicy
              ? resolvePolicy(request)
              : { mode: 'workspace-write', workspaceRoot: CWD };
          },
        };
      }
      return undefined;
    },
    fs: {
      async resolve(path, opts) {
        state.resolved.push({ path, opts });
        if (resolveImpl) return resolveImpl(path, opts);
        return { displayPath: path, targetKey: path };
      },
      async writeText(target, content, expected, signal, policy) {
        state.written.push({ target, content, policy });
        if (writeImpl) return writeImpl(target, content, policy);
        return { operation: 'update', version: 'v2' };
      },
    },
    connection: withoutFence ? {} : {
      requestRejection() {
        state.rejections += 1;
        return rejection;
      },
    },
    webServer: {
      register(route) {
        state.handler = route.handler;
        state.route = route;
        return () => {};
      },
    },
    effect(fn) {
      const disposer = fn();
      return typeof disposer === 'function' ? disposer : () => {};
    },
  };
  apply(ctx);
  assert.equal(typeof state.handler, 'function', 'route handler must be registered');
  return { state, handler: state.handler };
}

/**
 * Minimal IncomingMessage stand-in that records whether its body was pulled.
 * @param {object} options - method, headers, and body chunks.
 * @returns the request plus a flags object proving whether the body was read.
 */
function makeRequest({ method = 'POST', headers = { 'content-type': 'application/json' }, body } = {}) {
  const flags = { bodyRead: false };
  const req = {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      flags.bodyRead = true;
      if (body !== undefined) {
        yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      }
    },
  };
  return { req, flags };
}

/** Minimal ServerResponse stand-in that records status, headers, and payload. */
function makeResponse() {
  return {
    status: undefined,
    headers: undefined,
    payload: undefined,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      return this;
    },
    end(payload) {
      this.payload = payload;
    },
  };
}

const validBody = { sessionId: SESSION_ID, path: 'notes.md', content: '# Edited\n' };

test('declares the connection service it gates on', () => {
  assert.ok(inject.includes('connection'));
  assert.ok(inject.includes('webServer'));
  assert.ok(inject.includes('fs'));
});

test('403 rejection: returns before reading the body and never touches the filesystem', async () => {
  const { state, handler } = mount({ rejection: 403 });
  const { req, flags } = makeRequest({ body: validBody });
  const res = makeResponse();

  await handler(req, res);

  assert.equal(state.rejections, 1, 'the fence must be consulted exactly once');
  assert.equal(res.status, 403);
  assert.equal(res.payload, 'Forbidden');
  assert.equal(flags.bodyRead, false, 'a rejected request must not have its body consumed');
  assert.deepEqual(state.resolved, [], 'fs.resolve must not run for a rejected request');
  assert.deepEqual(state.written, [], 'fs.writeText must not run for a rejected request');
  assert.deepEqual(state.policyRequests, [], 'a rejected request must not resolve a sandbox policy');
});

test('401 rejection: returns Unauthorized without reading the body or writing', async () => {
  const { state, handler } = mount({ rejection: 401 });
  const { req, flags } = makeRequest({ body: validBody });
  const res = makeResponse();

  await handler(req, res);

  assert.equal(res.status, 401);
  assert.equal(res.payload, 'Unauthorized');
  assert.equal(flags.bodyRead, false);
  assert.deepEqual(state.resolved, []);
  assert.deepEqual(state.written, []);
});

test('rejection wins over method and content-type checks', async () => {
  const { state, handler } = mount({ rejection: 403 });
  const { req, flags } = makeRequest({ method: 'GET', headers: {} });
  const res = makeResponse();

  await handler(req, res);

  assert.equal(res.status, 403, 'the fence must be applied first');
  assert.equal(flags.bodyRead, false);
  assert.deepEqual(state.written, []);
});

test('a Host without requestRejection fails closed instead of serving the route', async () => {
  const { handler } = mount({ rejection: undefined, withoutFence: true });
  const { req, flags } = makeRequest({ body: validBody });
  const res = makeResponse();

  await handler(req, res);

  assert.equal(res.status, 401);
  assert.equal(res.payload, 'Unauthorized');
  assert.equal(flags.bodyRead, false);
});

test('allowed request writes the file and reports the outcome', async () => {
  const { state, handler } = mount();
  const { req, flags } = makeRequest({ body: validBody });
  const res = makeResponse();

  await handler(req, res);

  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.payload), { ok: true, operation: 'update', version: 'v2' });
  assert.equal(flags.bodyRead, true);
  assert.deepEqual(state.resolved, [{ path: 'notes.md', opts: { cwd: CWD } }]);
  assert.equal(state.written.length, 1);
  assert.deepEqual(state.written[0].target, { displayPath: 'notes.md', targetKey: 'notes.md' });
  assert.equal(state.written[0].content, '# Edited\n');
  assert.deepEqual(state.policyRequests, [{ session: LIVE_SESSION }],
    'writes must resolve the policy for this Session');
  assert.deepEqual(state.written[0].policy, { mode: 'workspace-write', workspaceRoot: CWD },
    'the session workspace root, not the deployment fallback, bounds the write');
});

test('a session without a live agent falls back to the deployment policy', async () => {
  const { state, handler } = mount({ live: false, resolvePolicy: () => ({ mode: 'workspace-write', workspaceRoot: DEPLOYMENT_ROOT }) });
  const { req } = makeRequest({ body: validBody });
  const res = makeResponse();

  await handler(req, res);

  assert.equal(res.status, 200);
  assert.deepEqual(state.policyRequests, [{}], 'no session is handed to resolve()');
  assert.equal(state.written[0].policy.workspaceRoot, DEPLOYMENT_ROOT);
});

test('a read-only session policy is passed through, not widened', async () => {
  const { state, handler } = mount({ resolvePolicy: () => ({ mode: 'read-only', workspaceRoot: CWD }) });
  const { req } = makeRequest({ body: validBody });
  const res = makeResponse();

  await handler(req, res);

  assert.equal(state.written[0].policy.mode, 'read-only', 'the enforcing fs must still deny the write');
});

test('allowed but non-POST is rejected with 405 before touching the filesystem', async () => {
  const { state, handler } = mount();
  const { req, flags } = makeRequest({ method: 'GET' });
  const res = makeResponse();

  await handler(req, res);

  assert.equal(res.status, 405);
  assert.equal(flags.bodyRead, false);
  assert.deepEqual(state.written, []);
});

test('allowed but non-JSON content type is rejected with 415 before reading the body', async () => {
  const { state, handler } = mount();
  const { req, flags } = makeRequest({ headers: { 'content-type': 'text/plain' }, body: 'x' });
  const res = makeResponse();

  await handler(req, res);

  assert.equal(res.status, 415);
  assert.equal(flags.bodyRead, false);
  assert.deepEqual(state.written, []);
});

test('malformed JSON is rejected with 400 and no write', async () => {
  const { state, handler } = mount();
  const { req } = makeRequest({ body: '{not json' });
  const res = makeResponse();

  await handler(req, res);

  assert.equal(res.status, 400);
  assert.deepEqual(state.written, []);
});

test('missing fields are rejected with 400 and no write', async () => {
  const { state, handler } = mount();
  const { req } = makeRequest({ body: { sessionId: SESSION_ID } });
  const res = makeResponse();

  await handler(req, res);

  assert.equal(res.status, 400);
  assert.deepEqual(state.written, []);
});

test('a sandbox denial surfaces as an explicit failure, not a thrown handler', async () => {
  const denied = Object.assign(
    new Error('cannot write "notes.md": file access denied under read-only mode'),
    { code: 'FS_SANDBOX_DENIED' },
  );
  const { handler } = mount({ writeImpl: () => { throw denied; } });
  const { req } = makeRequest({ body: validBody });
  const res = makeResponse();

  await handler(req, res);

  assert.equal(res.status, 200);
  const payload = JSON.parse(res.payload);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'FS_SANDBOX_DENIED');
  assert.match(payload.error, /denied under read-only mode/);
});
