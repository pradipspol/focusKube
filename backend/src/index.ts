import http from 'node:http';
import express from 'express';
import cors from 'cors';
import 'express-async-errors';
import { rateLimit } from 'express-rate-limit';
import { config } from './config.js';
import { HttpError } from './util/httpError.js';
import { contextsRouter } from './routes/contexts.js';
import { resourcesRouter } from './routes/resources.js';
import { workloadsRouter } from './routes/workloads.js';
import { helmRouter } from './routes/helm.js';
import { azureRouter } from './routes/azure.js';
import { awsRouter } from './routes/aws.js';
import { authRouter } from './routes/auth.js';
import { settingsRouter } from './routes/settings.js';
import { observabilityRouter, getRecordingLifecycle } from './routes/observability.js';
import { routeUpgrade } from './ws/streams.js';
import { attachUserSession } from './auth/session.js';
import { guardByMethod } from './auth/rbac.js';
import { logError, logInfo, logWarn } from './util/logger.js';
import { runWithLogContext, setLogContext } from './util/logger.js';
import { getRequestOperation, setRequestOperation } from './util/requestOp.js';


const app = express();


const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // max 100 requests per windowMs
  standardHeaders: 'draft-8',
  legacyHeaders: false
});

// apply rate limiter to all requests
app.use(limiter);


app.use(cors({
  origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(','),
  credentials: true,
}));
app.use(express.json({ limit: '5mb' }));
// The SAML ACS endpoint receives a form-encoded POST from the IdP.
app.use(express.urlencoded({ extended: false, limit: '5mb' }));

let nextRequestId = 1;
app.use((req, res, next) => {
  const reqId = `${Date.now()}-${nextRequestId++}`;
  const startedAt = Date.now();
  const startedHr = process.hrtime.bigint();
  const url = req.originalUrl || req.url;
  const timerMs = config.slowRequestWarnMs;
  runWithLogContext(
    {
      reqId,
      method: req.method,
      path: url,
      ip: req.ip,
      userAgent: req.get('user-agent') || null,
    },
    () => {
      req.logRequestId = reqId;
      res.setHeader('x-request-id', reqId);

      logInfo('http.request.start', {
        reqId,
        method: req.method,
        path: url,
        operation: getRequestOperation(req) ?? null,
        ip: req.ip,
        userAgent: req.get('user-agent') || null,
      });

      const slowTimer = setTimeout(() => {
        logWarn('http.request.slow', {
          reqId,
          method: req.method,
          path: url,
          operation: getRequestOperation(req) ?? null,
          elapsedMs: Date.now() - startedAt,
          thresholdMs: timerMs,
        });
      }, timerMs);

      slowTimer.unref();

      res.once('finish', () => {
        clearTimeout(slowTimer);
        const elapsedMs = Number(process.hrtime.bigint() - startedHr) / 1_000_000;
        logInfo('http.request.finish', {
          reqId,
          method: req.method,
          path: url,
          operation: getRequestOperation(req) ?? null,
          statusCode: res.statusCode,
          elapsedMs: Number(elapsedMs.toFixed(1)),
          bytesWritten: res.getHeader('content-length') ?? null,
        });
      });

      res.once('close', () => {
        if (res.writableEnded) return;
        clearTimeout(slowTimer);
        logWarn('http.request.aborted', {
          reqId,
          method: req.method,
          path: url,
          operation: getRequestOperation(req) ?? null,
          elapsedMs: Date.now() - startedAt,
        });
      });

      next();
    },
  );
});

app.use(attachUserSession);

app.use((req, _res, next) => {
  setLogContext({
    userId: req.authUser?.id ?? req.userSession?.userId ?? null,
    userEmail: req.authUser?.email ?? null,
    userRole: req.authUser?.role ?? null,
  });
  next();
});

app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use('/api/auth', authRouter);

// Per-session context & Azure operations are available to any authenticated
// user (needed even to view a cluster). Cluster-mutating routers enforce
// write/delete capability based on the HTTP method.
app.use('/api/contexts', contextsRouter);
app.use('/api/workloads', guardByMethod, workloadsRouter);
app.use('/api/resources', guardByMethod, resourcesRouter);
app.use('/api/helm', guardByMethod, helmRouter);
app.use('/api/azure', azureRouter);
app.use('/api/aws', awsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/observability', observabilityRouter);

// 404 for unknown API routes.
app.use('/api', (req, res) => {
  setRequestOperation(req, 'api.not_found');
  res.status(404).json({ error: 'Not found' });
});

// Central error handler.
app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof HttpError) {
    const statusCode =
      typeof err.status === 'number' && Number.isFinite(err.status) && err.status >= 400 && err.status <= 599
        ? err.status
        : 500;
    logError('http.error.http_error', {
      reqId: req.logRequestId ?? null,
      method: req.method,
      path: req.originalUrl || req.url,
      operation: getRequestOperation(req) ?? null,
      statusCode,
      message: err.message,
      details: err.details ?? null,
    });
    return res.status(statusCode).json({ error: err.message, details: err.details });
  }
  logError('http.error.unhandled', {
    reqId: req.logRequestId ?? null,
    method: req.method,
    path: req.originalUrl || req.url,
    operation: getRequestOperation(req) ?? null,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  const message = err instanceof Error ? err.message : 'Internal server error';
  return res.status(500).json({ error: message });
});

const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  routeUpgrade(req, socket, head).catch((err) => {
    logError('ws.upgrade.error', {
      path: req.url,
      error: err instanceof Error ? err.message : String(err),
    });
    socket.destroy();
  });
});

async function start(): Promise<void> {
  logInfo('backend.startup.begin', {
    host: config.host,
    port: config.port,
    slowRequestWarnMs: config.slowRequestWarnMs,
  });

  logInfo('backend.startup.desktop_mode');

  await new Promise<void>((resolve, reject) => {
    const listener = server.listen(config.port, config.host, () => {
      logInfo('backend.startup.listening', {
        url: `http://${config.host}:${config.port}`,
      });
      resolve();
    });

    listener.on('error', reject);
  });
}

function installGlobalGuards(): void {
  process.on('uncaughtException', (err) => {
    logError('backend.process.uncaught_exception', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  });

  process.on('unhandledRejection', (reason) => {
    logError('backend.process.unhandled_rejection', {
      error: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });

  process.on('SIGTERM', () => {
    logWarn('backend.process.sigterm', {});
    const lifecycle = getRecordingLifecycle();
    if (lifecycle) {
      void lifecycle.stopAllRecordings().then(() => {
        server.close(() => {
          logInfo('backend.process.shutdown_complete');
          process.exit(0);
        });
      });
    } else {
      server.close(() => {
        logInfo('backend.process.shutdown_complete');
        process.exit(0);
      });
    }
  });

  process.on('SIGINT', () => {
    logWarn('backend.process.sigint', {});
    const lifecycle = getRecordingLifecycle();
    if (lifecycle) {
      void lifecycle.stopAllRecordings().then(() => {
        server.close(() => {
          logInfo('backend.process.shutdown_complete');
          process.exit(0);
        });
      });
    } else {
      server.close(() => {
        logInfo('backend.process.shutdown_complete');
        process.exit(0);
      });
    }
  });
}

async function bootstrap(): Promise<void> {
  const retryDelayMs = 5000;
  installGlobalGuards();

  for (;;) {
    try {
      await start();
      return;
    } catch (err) {
      logError('backend.startup.failed', {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      logWarn('backend.startup.retrying', { retryDelayMs });
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

void bootstrap();
