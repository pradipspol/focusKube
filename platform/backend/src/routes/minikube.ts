import { Router } from 'express';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { minikubeService } from '../services/minikubeService.js';
import { badRequest } from '../util/httpError.js';
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

const DeployManifestSchema = z.object({
  manifest: z.string().min(1),
  clusterName: z.string().default('minikube'),
});

const ClusterSchema = z.object({
  clusterName: z.string().default('minikube'),
});

const NamespaceSchema = z.object({
  clusterName: z.string().default('minikube'),
  namespace: z.string().default('default'),
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
    await fs.writeFile(req.userSession.minikubeKubeconfigPath, kubeconfig, 'utf8');
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

// Deploy manifest
minikubeRouter.post(
  '/deploy',
  withRouteErrorLogging('minikube', 'POST /deploy', async (req, res) => {
    setRequestOperation(req, 'minikubeDeploy');
    const body = DeployManifestSchema.safeParse(req.body);
    if (!body.success) throw badRequest('Manifest is required');
    const { manifest, clusterName } = body.data;
    logInfo(`Deploying manifest to ${clusterName}`);
    const result = await minikubeService.deployManifest(manifest, clusterName);
    res.json(result);
  }),
);

// Get deployments
minikubeRouter.get(
  '/deployments',
  withRouteErrorLogging('minikube', 'GET /deployments', async (req, res) => {
    setRequestOperation(req, 'minikubeGetDeployments');
    const { clusterName, namespace } = NamespaceSchema.parse(req.query);
    const deployments = await minikubeService.getDeployments(clusterName, namespace);
    res.json({ deployments });
  }),
);

// Get pods
minikubeRouter.get(
  '/pods',
  withRouteErrorLogging('minikube', 'GET /pods', async (req, res) => {
    setRequestOperation(req, 'minikubeGetPods');
    const { clusterName, namespace } = NamespaceSchema.parse(req.query);
    const pods = await minikubeService.getPods(clusterName, namespace);
    res.json({ pods });
  }),
);

// Get pod logs
minikubeRouter.get(
  '/pods/:podName/logs',
  withRouteErrorLogging('minikube', 'GET /pods/:podName/logs', async (req, res) => {
    setRequestOperation(req, 'minikubeGetPodLogs');
    const { podName } = req.params;
    const { clusterName, namespace } = NamespaceSchema.parse(req.query);

    if (!podName) {
      throw badRequest('Pod name is required');
    }

    const logs = await minikubeService.getPodLogs(podName, clusterName, namespace);
    res.json({ logs });
  }),
);

// Execute command in pod
minikubeRouter.post(
  '/pods/:podName/exec',
  withRouteErrorLogging('minikube', 'POST /pods/:podName/exec', async (req, res) => {
    setRequestOperation(req, 'minikubeExecPod');
    const { podName } = req.params;
    const { command, clusterName, namespace } = z
      .object({
        command: z.array(z.string()),
        clusterName: z.string().default('minikube'),
        namespace: z.string().default('default'),
      })
      .parse({ ...req.body, clusterName: req.query.clusterName, namespace: req.query.namespace });

    if (!podName) {
      throw badRequest('Pod name is required');
    }

    if (!command || command.length === 0) {
      throw badRequest('Command is required');
    }

    const output = await minikubeService.execInPod(podName, command, clusterName, namespace);
    res.json({ output });
  }),
);

// Test pod
minikubeRouter.post(
  '/pods/:podName/test',
  withRouteErrorLogging('minikube', 'POST /pods/:podName/test', async (req, res) => {
    setRequestOperation(req, 'minikubeTestPod');
    const { podName } = req.params;
    const { clusterName, namespace } = z
      .object({
        clusterName: z.string().default('minikube'),
        namespace: z.string().default('default'),
      })
      .parse({ ...req.body, clusterName: req.query.clusterName, namespace: req.query.namespace });

    if (!podName) {
      throw badRequest('Pod name is required');
    }

    const result = await minikubeService.testPod(podName, clusterName, namespace);
    res.json(result);
  }),
);

// Get namespaces
minikubeRouter.get(
  '/namespaces',
  withRouteErrorLogging('minikube', 'GET /namespaces', async (req, res) => {
    setRequestOperation(req, 'minikubeGetNamespaces');
    const { clusterName } = ClusterSchema.parse(req.query);
    const namespaces = await minikubeService.getNamespaces(clusterName);
    res.json({ namespaces });
  }),
);
