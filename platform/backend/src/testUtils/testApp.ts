import express, { type Express } from 'express';
import 'express-async-errors';
import type { UserSessionState } from '../auth/session.js';
import { HttpError } from '../util/httpError.js';

/** Builds a minimal UserSessionState for tests, with sane path/scope defaults. */
export function makeTestSession(overrides: Partial<UserSessionState> = {}): UserSessionState {
  return {
    userId: 'test-user',
    activeContext: 'ctx-active',
    activeContextSource: 'azure',
    localKubeconfigPath: '/tmp/local-kubeconfig',
    minikubeKubeconfigPath: '/tmp/minikube-kubeconfig',
    localAzureConfigDir: '/tmp/local-azure',
    cloudKubeconfigPath: '/tmp/cloud-kubeconfig',
    cloudAzureConfigDir: '/tmp/cloud-azure',
    awsKubeconfigPath: '/tmp/aws-kubeconfig',
    azureLogin: {} as any,
    azureLoginCloud: {} as any,
    azureLoginLocal: {} as any,
    contextSourceHints: {},
    awsConfigFile: '/tmp/aws-config',
    awsCredentialsFile: '/tmp/aws-credentials',
    awsProfile: 'default',
    awsLogin: {} as any,
    ...overrides,
  };
}

export interface TestAuthUser {
  id: string;
  email: string;
  role: 'admin' | 'editor' | 'rwonly' | 'viewer';
}

export function makeTestAuthUser(overrides: Partial<TestAuthUser> = {}): TestAuthUser {
  return { id: 'test-user', email: 'test@example.com', role: 'admin', ...overrides };
}

export interface TestAppOptions {
  session?: UserSessionState | null;
  authUser: TestAuthUser | null;
}

/**
 * Mounts `router` at `basePath` on a fresh express app with a fake session/auth
 * middleware and the same JSON-error-handling contract as the real server
 * (see src/index.ts), so route tests can assert on real HTTP status/JSON shape.
 */
export function buildTestApp(basePath: string, router: express.Router, options: TestAppOptions): Express {
  const app = express();
  app.use(express.json());

  app.use((req, _res, next) => {
    req.logRequestId = 'test-req-id';
    (req as any).userSession = options.session === undefined ? makeTestSession() : options.session;
    (req as any).authUser = options.authUser ?? undefined;
    next();
  });

  app.use(basePath, router);

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof HttpError) {
      const statusCode =
        typeof err.status === 'number' && Number.isFinite(err.status) && err.status >= 400 && err.status <= 599
          ? err.status
          : 500;
      res.status(statusCode).json({ error: err.message, details: err.details });
      return;
    }
    const message = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ error: message });
  });

  return app;
}
