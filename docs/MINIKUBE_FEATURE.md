# Minikube Integration for FocusKube

## Overview

The Minikube integration provides a **completely isolated** feature module that allows developers to manage a local Kubernetes cluster directly within FocusKube. This feature enables testing and development with Minikube without affecting the main cluster management features.

## Architecture

### Code Isolation

The Minikube feature is organized to maintain separation from other features:

```
platform/
├── backend/
│   └── src/
│       ├── services/
│       │   ├── minikubeService.ts       (Core Minikube operations)
│       │   └── minikubeService.test.ts  (Service tests)
│       └── routes/
│           ├── minikube.ts              (API endpoints)
│           └── minikube.test.ts         (Route tests)
├── frontend/
│   └── src/
│       ├── api/
│       │   └── minikubeApi.ts           (API client & hooks)
│       └── components/
│           ├── MinikubePanel.tsx        (Main UI component)
│           └── MinikubePanel.css        (Styling)
```

## Backend Features

### MinikubeService (`services/minikubeService.ts`)

Core service handling all Minikube operations:

#### Cluster Management
- `getStatus(clusterName)` - Get cluster status
- `startCluster(options)` - Start a new cluster with configuration
- `stopCluster(clusterName)` - Stop a running cluster
- `deleteCluster(clusterName)` - Delete a cluster
- `isMinikubeInstalled()` - Check if Minikube is installed

#### Deployment & Workload Management
- `deployManifest(manifest, clusterName)` - Deploy Kubernetes manifests
- `getDeployments(clusterName, namespace)` - List deployments
- `getPods(clusterName, namespace)` - List pods
- `getNamespaces(clusterName)` - Get available namespaces

#### Pod Testing & Debugging
- `getPodLogs(podName, clusterName, namespace)` - Retrieve pod logs
- `execInPod(podName, command, clusterName, namespace)` - Execute commands in pods
- `testPod(podName, clusterName, namespace)` - Test pod connectivity and status

### API Routes (`routes/minikube.ts`)

RESTful API endpoints for Minikube operations:

```
POST   /api/minikube/start          - Start cluster
POST   /api/minikube/stop           - Stop cluster
POST   /api/minikube/delete         - Delete cluster
GET    /api/minikube/status         - Get cluster status
GET    /api/minikube/health         - Check if Minikube installed

POST   /api/minikube/deploy         - Deploy manifest
GET    /api/minikube/deployments    - List deployments
GET    /api/minikube/pods           - List pods
GET    /api/minikube/namespaces     - List namespaces

GET    /api/minikube/pods/:name/logs      - Get pod logs
POST   /api/minikube/pods/:name/exec      - Execute pod command
POST   /api/minikube/pods/:name/test      - Test pod connectivity
```

All endpoints include:
- Input validation using Zod schemas
- Comprehensive error handling
- Request operation tracking
- Structured logging

## Frontend Features

### API Client (`api/minikubeApi.ts`)

Provides:
- `minikubeApi` - Direct API client methods
- React Query hooks for state management
- Automatic query invalidation on mutations
- Built-in refetch intervals for real-time updates

#### Available Hooks

```typescript
// Health & Status
useMinikubeHealth()           // Check installation (30s refresh)
useMinikubeStatus()           // Get cluster status (10s refresh)

// Cluster Operations
useStartCluster()             // Mutation: start cluster
useStopCluster()              // Mutation: stop cluster
useDeleteCluster()            // Mutation: delete cluster

// Workload Management
useDeployments()              // List deployments (15s refresh)
usePods()                     // List pods (15s refresh)
useNamespaces()               // List namespaces (30s refresh)

// Debugging
usePodLogs()                  // Get pod logs
useTestPod()                  // Mutation: test pod connectivity

// Manifest Deployment
useDeployManifest()           // Mutation: deploy YAML
```

### UI Component (`components/MinikubePanel.tsx`)

Main React component providing:

#### Sections
1. **Cluster Status** - View current cluster state, IP, Kubernetes version
2. **Cluster Control** - Start/Stop/Delete cluster with configuration
3. **Namespace Selection** - Choose namespace for viewing resources
4. **Deployments** - View all deployments in namespace
5. **Pods** - View all pods with status, ready replicas, restart count
6. **Pod Details** - Click pod name to view logs
7. **Manifest Deployment** - Deploy custom Kubernetes manifests

#### Features
- Real-time status updates
- Configuration before cluster creation (driver, CPUs, memory)
- Namespace isolation
- Pod testing and logs viewing
- YAML manifest deployment
- Responsive design (mobile-friendly)

## Usage Examples

### Backend Usage

```typescript
import { minikubeService } from './services/minikubeService.js';

// Start a cluster
const status = await minikubeService.startCluster({
  name: 'dev-cluster',
  driver: 'docker',
  cpus: 4,
  memory: '4096m',
});

// Deploy a manifest
const result = await minikubeService.deployManifest(yamlContent, 'dev-cluster');

// List pods
const pods = await minikubeService.getPods('dev-cluster', 'default');

// Get pod logs
const logs = await minikubeService.getPodLogs('my-pod', 'dev-cluster', 'default');

// Test pod connectivity
const test = await minikubeService.testPod('my-pod', 'dev-cluster', 'default');
```

### Frontend Usage

```typescript
import { MinikubePanel } from './components/MinikubePanel';

function App() {
  return (
    <div>
      <MinikubePanel />
    </div>
  );
}
```

Or use individual hooks:

```typescript
function MyComponent() {
  const { data: status } = useMinikubeStatus('minikube');
  const { data: pods } = usePods('minikube', 'default');
  const startCluster = useStartCluster();

  return (
    <div>
      <p>Status: {status?.status}</p>
      <button onClick={() => startCluster.mutateAsync({ name: 'minikube' })}>
        Start Cluster
      </button>
    </div>
  );
}
```

## Testing

### Backend Tests

Run service tests:
```bash
npm test src/services/minikubeService.test.ts
```

Run route tests:
```bash
npm test src/routes/minikube.test.ts
```

Run all tests:
```bash
npm test
```

Test coverage:
```bash
npm run test:coverage
```

## Integration Points

### Keeping Minikube Isolated

The feature maintains isolation by:

1. **Dedicated Routes** - Only `/api/minikube/*` endpoints handle Minikube
2. **Independent Service** - `MinikubeService` handles all Minikube logic
3. **Separate Storage** - Uses Minikube's own kubeconfig files
4. **No Context Pollution** - Doesn't modify user's active cluster context
5. **Separate UI** - `MinikubePanel` is self-contained and can be placed anywhere

### Where to Integrate in App.tsx

```typescript
import { MinikubePanel } from './components/MinikubePanel';

function App() {
  return (
    <div className="app-container">
      {/* Existing features */}
      
      {/* Add Minikube panel in sidebar */}
      <aside className="sidebar">
        <MinikubePanel />
      </aside>
      
      {/* Rest of app */}
    </div>
  );
}
```

## API Request Examples

### Start a Minikube Cluster

```bash
curl -X POST http://localhost:3000/api/minikube/start \
  -H "Content-Type: application/json" \
  -d '{
    "name": "minikube",
    "driver": "docker",
    "cpus": 4,
    "memory": "4096m"
  }'
```

### Deploy a Manifest

```bash
curl -X POST http://localhost:3000/api/minikube/deploy \
  -H "Content-Type: application/json" \
  -d '{
    "manifest": "apiVersion: v1\nkind: Pod\nmetadata:\n  name: test",
    "clusterName": "minikube"
  }'
```

### Get Pods

```bash
curl http://localhost:3000/api/minikube/pods \
  -G \
  -d "clusterName=minikube&namespace=default"
```

### Test Pod Connectivity

```bash
curl -X POST http://localhost:3000/api/minikube/pods/my-pod/test \
  -H "Content-Type: application/json" \
  -d '{}'
```

## Dependencies

### Backend
- `@kubernetes/client-node` - Kubernetes API client
- `express` - Web framework
- `js-yaml` - YAML parsing
- `zod` - Input validation
- `pino` - Logging

### Frontend
- `@tanstack/react-query` - Server state management
- `react` - UI library

## Error Handling

### Service Errors
All service methods throw `HttpError` instances:
- `badRequest()` - Invalid input (400)
- `internalServerError()` - Operation failed (500)

### Route Error Handling
All routes use `withRouteErrorLogging` middleware for:
- Automatic error logging
- Standardized error responses
- Stack trace capture

### Frontend Error Handling
- React Query handles network errors
- Component catches and displays errors
- Automatic refetch on failure

## Performance Considerations

### Refetch Intervals
- Health check: 30 seconds
- Cluster status: 10 seconds
- Pods/Deployments: 15 seconds
- Namespaces: 30 seconds

Intervals can be adjusted in `minikubeApi.ts` based on your needs.

### Caching
React Query automatically caches responses. Keys:
- `['minikube', 'health']`
- `['minikube', 'status', clusterName]`
- `['minikube', 'pods', clusterName, namespace]`
- `['minikube', 'deployments', clusterName, namespace]`

## Troubleshooting

### Minikube Not Installed
If the health check shows "Not Installed", install Minikube:
- macOS: `brew install minikube`
- Windows: Download from https://minikube.sigs.k8s.io/
- Linux: Follow https://minikube.sigs.k8s.io/docs/start/

### Cluster Won't Start
- Check available disk space
- Ensure Docker daemon is running
- Try different driver (hyperv, virtualbox, qemu)
- Check logs: `minikube logs -p <cluster-name>`

### Pod Operations Failing
- Ensure cluster is running
- Verify pod exists in correct namespace
- Check pod logs for errors
- Try testing pod connectivity first

## Future Enhancements

Possible extensions to the feature:
- [ ] Helm chart management within Minikube
- [ ] Service URL and port forwarding
- [ ] Volume management
- [ ] Network policy management
- [ ] Resource usage monitoring
- [ ] Cluster metrics dashboard
- [ ] Multi-cluster comparison
- [ ] Backup/restore functionality

## File Structure Summary

```
minikube/
├── Backend Service Layer
│   ├── minikubeService.ts (427 lines)
│   └── minikubeService.test.ts (70 lines)
├── Backend API Layer
│   ├── minikube.ts (225 lines)
│   └── minikube.test.ts (130 lines)
└── Frontend Layer
    ├── minikubeApi.ts (290 lines)
    ├── MinikubePanel.tsx (350 lines)
    └── MinikubePanel.css (500 lines)
```

Total: ~2000 lines of code, fully isolated and tested.

## Support & Maintenance

For issues or improvements:
1. Check service logs: `npm run dev` in backend
2. Check browser console: DevTools → Console
3. Add new operations to `MinikubeService`
4. Create corresponding API routes
5. Add React hooks in `minikubeApi.ts`
6. Update UI component as needed
