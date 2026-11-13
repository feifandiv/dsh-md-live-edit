/**
 * Host half of the Markdown live-edit bundle.
 *
 * The browser half renders an editable Markdown body in the right-sidebar
 * preview and needs exactly one capability: writing the edited text back to
 * the workspace file. `workspaceFiles` exposes no mutation, so this entry
 * offers a small authenticated HTTP endpoint that resolves the Session
 * workspace (the same header lookup the workspace-files service performs)
 * and writes through the composed `fs`, keeping its sandbox enforcement.
 */

export const inject = ['webServer', 'connection', 'fs'];

const ROUTE = '/dsh-md-live-edit/api/write';
const MAX_BODY_BYTES = 32 * 1024 * 1024;

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function errorMessage(error) {
  return String(error?.message || error);
}

function errorCode(error) {
  const code = error?.code ?? error?.failure?.code;
  return typeof code === 'string' ? code : 'write-failed';
}

export function apply(ctx) {
  /**
   * Resolve the Session's workspace root the way the workspace-files service
   * does: live header first, then the persistence header-only stat, with the
   * sandbox workspace root as the no-cwd fallback.
   * @param sessionId - Session named by the file address.
   * @returns the effective workspace root path.
   */
  async function workspaceRootOf(sessionId) {
    const sessions = ctx.get('sessions');
    const live = sessions?.get(sessionId)?.header;
    let header = live;
    if (header === undefined) {
      const persistence = ctx.get('sessionPersistence');
      const stored = await persistence?.stat(sessionId);
      header = stored?.header;
    }
    const sandbox = ctx.get('sandboxPolicy');
    return header?.cwd ?? sandbox?.workspaceRoot;
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: async (req, res) => {
      if (!ctx.connection.authorizeIndex(req, res)) return;
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST required' }); return; }
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
        sendJson(res, 415, { ok: false, error: 'application/json required' }); return;
      }
      let request;
      try { request = await readBody(req); }
      catch (error) { sendJson(res, 400, { ok: false, code: 'bad-request', error: errorMessage(error) }); return; }

      const sessionId = request.sessionId;
      const path = request.path;
      const content = request.content;
      if (typeof sessionId !== 'string' || sessionId.length === 0 ||
          typeof path !== 'string' || path.length === 0 ||
          typeof content !== 'string') {
        sendJson(res, 400, { ok: false, code: 'bad-request', error: 'sessionId, path and content strings are required' });
        return;
      }

      try {
        const cwd = await workspaceRootOf(sessionId);
        const target = await ctx.fs.resolve(path, { cwd });
        const expected = typeof request.expectedVersion === 'string'
          ? { version: request.expectedVersion }
          : undefined;
        const outcome = await ctx.fs.writeText(target, content, expected);
        sendJson(res, 200, {
          ok: true,
          operation: outcome?.operation,
          version: outcome?.version,
        });
      } catch (error) {
        sendJson(res, 200, { ok: false, code: errorCode(error), error: errorMessage(error) });
      }
    },
  }));
}
