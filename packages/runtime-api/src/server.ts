import { subjectUserId, type AuthenticatedSubject } from '@macros/domain-auth';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  HTTP_STATUS, appError, fromUnknown, toWireError,
  computeHealth, subjectRef, type AppError, type AuthSessionProvider,
  type RuntimeConfig, type StructuredLogger, type VersionManifest,
  subjectFromSession,
} from '@macros/runtime-config';
import { validateBody, type Schema } from './validation.js';

/**
 * THE SERVER API BOUNDARY.
 *
 * One modular monolith, not microservices. HTTP handlers do TRANSPORT ONLY:
 * parse, validate, authenticate, delegate, map errors. No business arithmetic
 * lives here — nutrition, energy and macros are computed by the domain engines
 * and reach this layer already decided.
 *
 * The tablet talks to this boundary over authenticated HTTP. It never holds a
 * database credential, so a compromised or disassembled appliance cannot reach
 * the data of any user other than the one signed into it.
 */

export interface RequestContext {
  readonly requestId: string;
  readonly userId: string;
  readonly body: Record<string, unknown>;
  /**
   * The ACTUAL subject minted from the verified session.
   *
   * Reducing authentication to a `userId` string destroys the unforgeable
   * capability that `withAuthenticatedDatabaseSubject` requires, and a handler
   * would then have to reconstruct one — which is exactly the impersonation
   * hole the branded type exists to close. Undefined only on public routes.
   */
  readonly subject?: AuthenticatedSubject;
}

export interface RouteHandler {
  (context: RequestContext): Promise<unknown>;
}

export interface Route {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly schema?: Schema;
  /**
   * Narrowly scoped decoder for STRUCTURED bodies. The flat `Schema` validator
   * cannot express a nested FoodLogItem, and bypassing validation to wire a
   * route would let unknown network JSON reach persistence.
   */
  readonly decode?: (body: Record<string, unknown>) => unknown | AppError;
  /** Public routes skip auth; everything else requires a verified session. */
  readonly public?: boolean;
  readonly handler: RouteHandler;
}

export interface ApiDependencies {
  readonly config: RuntimeConfig;
  readonly auth: AuthSessionProvider;
  readonly logger: StructuredLogger;
  readonly versions: VersionManifest;
  readonly now: () => string;
  readonly health: () => { databaseReachable: 'ready' | 'degraded' | 'unavailable'; migrationsApplied: boolean; configValid: boolean };
  readonly newRequestId: () => string;
}

const isAppError = (v: unknown): v is AppError =>
  typeof v === 'object' && v !== null && 'kind' in v && 'code' in v && 'message' in v;

export class MacrosApi {
  private readonly routes: Route[] = [];

  constructor(private readonly deps: ApiDependencies) {}

  route(route: Route): this {
    this.routes.push(route);
    return this;
  }

  /** Built-in operational routes. */
  withSystemRoutes(): this {
    this.route({
      method: 'GET', path: '/health', public: true,
      handler: () => {
        const h = this.deps.health();
        // Free of secrets and of config values by construction.
        return Promise.resolve(computeHealth(h));
      },
    });
    this.route({
      method: 'GET', path: '/version', public: true,
      handler: () => Promise.resolve(this.deps.versions),
    });
    return this;
  }

  createServer(): Server {
    return createServer((req, res) => { void this.handle(req, res); });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = this.deps.newRequestId();
    const started = Date.now();
    const path = (req.url ?? '/').split('?')[0]!;
    const method = (req.method ?? 'GET') as 'GET' | 'POST';

    let subject: string | undefined;
    try {
      const route = this.routes.find((r) => r.path === path && r.method === method);
      if (route === undefined) {
        this.fail(res, appError('not_found', 'no_such_route', 'Not found.'), requestId);
        return;
      }

      const raw = await this.readBody(req);
      if (isAppError(raw)) { this.fail(res, raw, requestId); return; }

      let body: Record<string, unknown> = {};
      if (route.schema !== undefined) {
        const parsed = this.parseJson(raw);
        if (isAppError(parsed)) { this.fail(res, parsed, requestId); return; }
        const validated = validateBody(parsed, route.schema);
        if (!validated.ok) { this.fail(res, validated.error, requestId); return; }
        body = validated.value;
      }

      let userId = '';
      let authenticated: AuthenticatedSubject | undefined;
      if (route.public !== true) {
        const bound = await this.authenticate(req, body);
        if (isAppError(bound)) { this.fail(res, bound, requestId); return; }
        // The SUBJECT is carried forward, not a string derived from it.
        authenticated = bound;
        userId = subjectUserId(bound);
        subject = subjectRef(userId);
      }

      if (route.decode !== undefined) {
        const decoded = route.decode(body);
        if (isAppError(decoded)) { this.fail(res, decoded, requestId, subject); return; }
        body = { ...body, decoded };
      }

      const result = await route.handler({
        requestId, userId, body,
        ...(authenticated !== undefined ? { subject: authenticated } : {}),
      });
      if (isAppError(result)) { this.fail(res, result, requestId, subject); return; }

      this.deps.logger.log({
        level: 'info', component: 'api', event: `${method} ${path}`,
        requestId, result: 'ok', durationMs: Date.now() - started,
        ...(subject !== undefined ? { subjectRef: subject } : {}),
      });
      this.send(res, 200, { ...(result as object), requestId });
    } catch (thrown) {
      // Never leak a stack or a driver message to a client.
      this.fail(res, fromUnknown(thrown), requestId, subject);
    }
  }

  /**
   * Identity comes from the verified session ONLY.
   *
   * A body-supplied userId is treated as a claim to be checked, never as a
   * source of identity, so a client cannot select another profile.
   */
  private async authenticate(
    req: IncomingMessage,
    body: Record<string, unknown>,
  ): Promise<AuthenticatedSubject | AppError> {
    const header = req.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      return appError('authentication', 'missing_credential', 'Not signed in.');
    }
    const session = await this.deps.auth.verify(header.slice('Bearer '.length));
    if (isAppError(session)) return session;

    const claimed = typeof body['userId'] === 'string' ? (body['userId'] as string) : undefined;
    // subjectFromSession already refuses a claimed userId that differs from the
    // session subject, so a body userId is at most a claim to check.
    return subjectFromSession(session, this.deps.now(), claimed);
  }

  private parseJson(raw: string): unknown | AppError {
    if (raw.trim().length === 0) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return appError('validation', 'malformed_json', 'Request body is not valid JSON.');
    }
  }

  /** Bounded read: an unbounded body is a trivial memory exhaustion vector. */
  private readBody(req: IncomingMessage): Promise<string | AppError> {
    const limit = this.deps.config.limits.maxRequestBytes;
    return new Promise((resolve) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) {
          // PAUSE rather than destroy: tearing the socket down here would reset
          // the connection before the 400 could flush, so the client would see
          // a network failure instead of a clear refusal. Reading simply stops.
          req.pause();
          resolve(appError('validation', 'payload_too_large', 'Request body is too large.'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')); });
      req.on('error', () => { resolve(appError('validation', 'read_failed', 'Could not read request.')); });
    });
  }

  private fail(res: ServerResponse, error: AppError, requestId: string, subject?: string): void {
    this.deps.logger.log({
      level: error.kind === 'internal' ? 'error' : 'warn',
      component: 'api', event: 'request_failed', requestId,
      result: error.kind === 'internal' ? 'error' : 'refused',
      errorCode: error.code,
      ...(subject !== undefined ? { subjectRef: subject } : {}),
      // internalDetail is logged server-side, never serialized to the client.
      ...(error.internalDetail !== undefined ? { fields: { detail: error.internalDetail } } : {}),
    });
    this.send(res, HTTP_STATUS[error.kind], toWireError(error, requestId));
  }

  private send(res: ServerResponse, status: number, payload: unknown): void {
    const text = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });
    res.end(text);
  }
}
