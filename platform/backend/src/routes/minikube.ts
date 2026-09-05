import { Router } from 'express';
import { z } from 'zod';
import { minikubeService } from '../services/minikubeService.js';
import { badRequest } from '../util/httpError.js';
import { withFileLock, writeFileAtomic } from '../util/fileLock.js';
import { setRequestOperation } from '../util/requestOp.js';
import { logInfo } from '../util/logger.js';
import { withRouteErrorLogging } from '../util/httpError.js';

export const minikubeRouter = Router();

// Request validation schemas
const StartClusterSchema = z.object({
  name: z.string().optional(),
  driver: z.string().optional(),
  cpus: z.number().optional(),
  memory: z.string().optional(),
  kubernetesVersion: z.string().optional(),
});

const ClusterSchema = z.object({
  clusterName: z.string().default('minikube'),
});

// Health check endpoint
minikubeRouter.get(
  '/health',
  withRouteErrorLogging('minikube', 'GET /health', async (req, res) => {
    setRequestOperation(req, 'minikubeHealth');
    const installed = await minikubeService.isMinikubeInstalled();
    res.json({ installed });
  }),
);

minikubeRouter.post(
  '/connect',
  withRouteErrorLogging('minikube', 'POST /connect', async (req, res) => {
    setRequestOperation(req, 'minikubeConnect');
    if (!req.userSession) throw badRequest('Session not found');
    const { clusterName, kubeconfig } = await minikubeService.exportKubeconfig('minikube');
    const minikubeKubeconfigPath = req.userSession.minikubeKubeconfigPath;
    await withFileLock(minikubeKubeconfigPath, () => writeFileAtomic(minikubeKubeconfigPath, kubeconfig));
    req.userSession.activeContext = clusterName;
    req.userSession.activeContextSource = 'minikube';
    res.json({ contextName: clusterName });
  }),
);

// Get cluster status
minikubeRouter.get(
  '/status',
  withRouteErrorLogging('minikube', 'GET /status', async (req, res) => {
    setRequestOperation(req, 'minikubeStatus');
    const { clusterName } = ClusterSchema.parse(req.query);
    const status = await minikubeService.getStatus(clusterName);
    res.json(status);
  }),
);

minikubeRouter.get(
  '/kubeconfig',
  withRouteErrorLogging('minikube', 'GET /kubeconfig', async (req, res) => {
    setRequestOperation(req, 'minikubeExportKubeconfig');
    const { clusterName } = ClusterSchema.parse(req.query);
    res.json(await minikubeService.exportKubeconfig(clusterName));
  }),
);

minikubeRouter.get(
  '/setup-scripts',
  withRouteErrorLogging('minikube', 'GET /setup-scripts', async (_req, res) => {
    setRequestOperation(_req, 'minikubeSetupScripts');
    const scripts = await minikubeService.getSetupScripts();
    res.json({ scripts });
  }),
);

// Start cluster
minikubeRouter.post(
  '/start',
  withRouteErrorLogging('minikube', 'POST /start', async (req, res) => {
    setRequestOperation(req, 'minikubeStart');
    const options = StartClusterSchema.parse(req.body);
    logInfo(`Starting minikube cluster: ${options.name || 'minikube'}`);
    const result = await minikubeService.startCluster(options);
    res.json(result);
  }),
);

// Stop cluster
minikubeRouter.post(
  '/stop',
  withRouteErrorLogging('minikube', 'POST /stop', async (req, res) => {
    setRequestOperation(req, 'minikubeStop');
    const { clusterName } = ClusterSchema.parse(req.body);
    logInfo(`Stopping minikube cluster: ${clusterName}`);
    const result = await minikubeService.stopCluster(clusterName);
    res.json(result);
  }),
);

// Delete cluster
minikubeRouter.post(
  '/delete',
  withRouteErrorLogging('minikube', 'POST /delete', async (req, res) => {
    setRequestOperation(req, 'minikubeDelete');
    const { clusterName } = ClusterSchema.parse(req.body);
    logInfo(`Deleting minikube cluster: ${clusterName}`);
    const result = await minikubeService.deleteCluster(clusterName);
    res.json(result);
  }),
);

// Note: pod/deployment/namespace browsing, logs, exec, and manifest apply for a connected
// Minikube cluster go through the generic Resource Explorer (ws-watch backed, session-scoped
// kubeconfig) via `POST /connect`, not through dedicated Minikube routes — see
// `openMinikubeResourceExplorer` in the frontend.
