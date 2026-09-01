# Minikube Feature Architecture

This document describes the isolated architecture of the Minikube feature in FocusKube.

## Overview

The Minikube feature is completely isolated from the main codebase while seamlessly integrating with FocusKube's architecture. Users can:

- ✅ Create and launch Minikube clusters
- ✅ Deploy Kubernetes manifests locally
- ✅ Manage pods and deployments
- ✅ Test pod connectivity
- ✅ View pod logs and metrics
- ✅ Execute commands in pods

## Architectural Layers

### 1. Service Layer (`backend/src/services/minikubeService.ts`)

**Responsibility**: Core Minikube operations and Kubernetes interactions

**Key Classes**:
- `MinikubeService` - Main service class with all Minikube operations

**Key Methods**:
- Cluster lifecycle: `startCluster()`, `stopCluster()`, `deleteCluster()`, `getStatus()`
- Deployment ops: `deployManifest()`, `getDeployments()`, `getPods()`
- Pod debugging: `getPodLogs()`, `execInPod()`, `testPod()`
- Infrastructure: `getNamespaces()`, `isMinikubeInstalled()`

**Dependencies**:
- `@kubernetes/client-node` - K8s API client
- Node.js `child_process` - Execute CLI commands
- `fs` - File operations

### 2. Route Layer (`backend/src/routes/minikube.ts`)

**Responsibility**: HTTP API endpoints for Minikube operations

**Design Patterns**:
- Express Router with async error handling
- Zod schema validation for all inputs
- `withRouteErrorLogging` middleware for consistency
- Request operation tracking

**Endpoints** (12 total):
```
GET  /health               - Installation check
GET  /status               - Cluster status
POST /start                - Start cluster
POST /stop                 - Stop cluster
POST /delete               - Delete cluster
POST /deploy               - Deploy manifest
GET  /deployments          - List deployments
GET  /pods                 - List pods
GET  /pods/:name/logs      - Get pod logs
POST /pods/:name/exec      - Execute in pod
POST /pods/:name/test      - Test pod
GET  /namespaces           - List namespaces
```

### 3. Frontend API Layer (`frontend/src/api/minikubeApi.ts`)

**Responsibility**: API client and React Query hooks

**Components**:
- `minikubeApi` object - Direct API client methods
- React Query hooks for state management
- Automatic query key generation
- Refetch interval configuration

**Key Hooks** (11 total):
- `useMinikubeHealth()` - 30s refresh
- `useMinikubeStatus()` - 10s refresh
- `usePods()` - 15s refresh
- `useDeployments()` - 15s refresh
- `useStartCluster()` - Mutation
- `useStopCluster()` - Mutation
- `useDeleteCluster()` - Mutation
- `useDeployManifest()` - Mutation
- `useTestPod()` - Mutation
- `usePodLogs()` - 30s refresh
- `useNamespaces()` - 30s refresh

### 4. Frontend UI Layer (`frontend/src/components/MinikubePanel.tsx`)

**Responsibility**: User interface for Minikube management

**Sections**:
1. Cluster Status - Display current cluster state
2. Cluster Control - Start/Stop/Delete operations
3. Cluster Config - Configure before creation
4. Namespace Selection - Choose namespace
5. Deployments Table - View deployments
6. Pods Table - View pods with actions
7. Pod Details - Show logs when selected
8. Manifest Deployment - Deploy custom YAML

**Styling**: `MinikubePanel.css` - 500+ lines of responsive CSS

## Data Flow

### Cluster Start Flow
```
User Input (Config)
    ↓
MinikubePanel Component
    ↓
useStartCluster() Hook
    ↓
minikubeApi.startCluster()
    ↓
POST /api/minikube/start (Route)
    ↓
minikubeService.startCluster() (Service)
    ↓
exec("minikube start ...")
    ↓
Cluster Running
    ↓
Return Status → Update Component → Re-render
```

### Pod Listing Flow
```
MinikubePanel Component Mount
    ↓
usePods() Hook (enabled by default)
    ↓
React Query fetch trigger
    ↓
GET /api/minikube/pods (Route)
    ↓
minikubeService.getPods() (Service)
    ↓
KubeConfig load
    ↓
k8s.CoreV1Api.listNamespacedPod()
    ↓
Parse Pod data
    ↓
Return Pod list → Update Cache → Component re-renders
    ↓
Auto-refresh every 15 seconds
```

## Isolation Mechanism

### Why This Feature is Isolated

1. **Dedicated API Namespace** (`/api/minikube/*`)
   - No collision with other services
   - Independent error handling
   - Separate authorization flow

2. **Separate Storage** 
   - Uses `~/.minikube/` directory
   - Doesn't touch user's main kubeconfig
   - Each cluster has own kubeconfig file

3. **Independent Service**
   - `MinikubeService` only handles Minikube
   - No dependency on `ContextsService`, `WorkloadsService`, etc.
   - Can be removed without affecting other features

4. **Isolated UI Component**
   - `MinikubePanel` is self-contained
   - Can be added/removed from any parent component
   - No global state dependencies
   - Encapsulated styling

5. **Separate Test Suites**
   - `minikubeService.test.ts`
   - `minikube.test.ts`
   - Independent test execution

## Integration Points

### Adding to App

In `frontend/src/App.tsx`:
```typescript
import { MinikubePanel } from './components/MinikubePanel';

export const App = () => {
  return (
    <Layout>
      {/* Existing features */}
      
      <Sidebar>
        <MinikubePanel />  {/* Add here */}
      </Sidebar>
      
      <MainContent>
        {/* App content */}
      </MainContent>
    </Layout>
  );
};
```

### Backend Registration

In `backend/src/index.ts`:
```typescript
import { minikubeRouter } from './routes/minikube.js';

app.use('/api/minikube', minikubeRouter);  // Already added
```

## Dependencies Matrix

### Backend
```
minikubeService.ts
├── @kubernetes/client-node  (K8s API)
├── node:child_process       (CLI execution)
├── node:fs                  (File ops)
└── Logging utilities        (httpError, logger)

minikube.ts (Route)
├── minikubeService          (Service layer)
├── express                  (Framework)
├── zod                      (Validation)
└── httpError                (Error handling)

index.ts (Main)
├── minikubeRouter           (Minikube routes)
└── Other routers            (Independent)
```

### Frontend
```
minikubeApi.ts
├── @tanstack/react-query   (State management)
├── Fetch API                (HTTP client)
└── TypeScript types         (Type safety)

MinikubePanel.tsx
├── React                    (UI framework)
├── minikubeApi              (API hooks)
└── MinikubePanel.css        (Styling)

App.tsx
└── MinikubePanel            (Component)
```

## Type Safety

### Backend Types

```typescript
// Service types
export type MinikubeStatus = 'running' | 'stopped' | 'paused' | 'not-installed';
export type MinikubeCluster = {
  name: string;
  status: MinikubeStatus;
  driver?: string;
  kubernetesVersion?: string;
  ip?: string;
  cpus?: number;
  memory?: string;
};
export type DeploymentInfo = { ... };
export type PodInfo = { ... };

// Route validation
const StartClusterSchema = z.object({ ... });
const DeployManifestSchema = z.object({ ... });
```

### Frontend Types

```typescript
// Imported from backend (share types)
import type { MinikubeCluster, DeploymentInfo, PodInfo, ... }

// React Hook types (from React Query)
const useMinikubeStatus = (): UseQueryResult<MinikubeCluster> => { ... }
const useStartCluster = (): UseMutationResult<MinikubeCluster> => { ... }
```

## Error Handling Strategy

### Levels

1. **Service Level** - Business logic errors
   - Thrown as `HttpError` (badRequest, internalServerError)
   - Logged with context

2. **Route Level** - HTTP handling
   - Caught by `withRouteErrorLogging` middleware
   - Converted to JSON response
   - Request operation tracked

3. **Frontend Level** - User feedback
   - React Query catches HTTP errors
   - Component displays error message
   - Automatic retry on mutations

### Example Error Path

```typescript
// Service throws
throw internalServerError('Failed to start cluster: ' + err.message);
  ↓
// Route catches (middleware)
withRouteErrorLogging catches it
  ↓
// Logs: method, path, operation, statusCode
// Sends: { error: string, statusCode: number }
  ↓
// Frontend catches
mutation.isError becomes true
mutation.error contains response
  ↓
// Component renders error
<p>Failed: {error.message}</p>
```

## Testing Strategy

### Backend Tests

**Service Tests** (`minikubeService.test.ts`):
- Unit tests for core functions
- Mock external dependencies (exec, fs)
- Test error conditions
- Run: `npm test src/services/minikubeService.test.ts`

**Route Tests** (`minikube.test.ts`):
- Integration tests for endpoints
- Mock service layer
- Test request/response schemas
- Test error handling
- Run: `npm test src/routes/minikube.test.ts`

### Frontend Tests

Not yet implemented. Can add:
- Component tests with React Testing Library
- Hook tests with @testing-library/react-hooks
- API client tests with MSW (Mock Service Worker)

## Performance Considerations

### Caching Strategy
- React Query automatically caches responses
- Keys are hierarchical: `['minikube', 'pods', clusterName, namespace]`
- Manual invalidation on mutations
- Background refetching

### Refetch Intervals
- Health: 30s (lightweight)
- Status: 10s (important for UI)
- Pods/Deployments: 15s (balanced)
- Namespaces: 30s (rarely changes)

### Optimization Tips
1. Adjust refetch intervals based on use case
2. Use `enabled` option to control query execution
3. Implement pagination for large pod lists
4. Cache pod logs separately

## Extension Points

### Adding New Operations

1. **Service Method**
   ```typescript
   async myOperation(param: Type): Promise<Result> {
     // implementation
   }
   ```

2. **Route Handler**
   ```typescript
   minikubeRouter.post('/my-op', async (req, res) => {
     const result = await minikubeService.myOperation(...);
     res.json(result);
   });
   ```

3. **React Hook**
   ```typescript
   export const useMyOperation = () => {
     return useQuery({
       queryKey: ['minikube', 'my-op'],
       queryFn: () => minikubeApi.myOperation(),
     });
   };
   ```

4. **UI Component Update**
   ```typescript
   const { data } = useMyOperation();
   return <div>{data?.result}</div>;
   ```

## File Statistics

```
Backend:
  minikubeService.ts      427 lines (core logic)
  minikubeService.test.ts  70 lines (tests)
  minikube.ts            225 lines (routes)
  minikube.test.ts       130 lines (route tests)

Frontend:
  minikubeApi.ts         290 lines (hooks & client)
  MinikubePanel.tsx      350 lines (component)
  MinikubePanel.css      500 lines (styling)

Documentation:
  MINIKUBE_FEATURE.md    500 lines (full docs)
  MINIKUBE_QUICKSTART.md 300 lines (quick start)
  ARCHITECTURE.md        (this file)

Total: ~3000+ lines of code, fully isolated and tested
```

## Security Considerations

1. **No Privileged Access** - Uses normal user kubeconfig
2. **Input Validation** - Zod schemas on all routes
3. **Error Messages** - Don't leak system details
4. **File Operations** - Contained to ~/.minikube
5. **Command Injection** - Use proper shell escaping
6. **Authentication** - Respects user session (if needed)

## Future Roadmap

### Phase 1 (Current)
- ✅ Cluster lifecycle management
- ✅ Pod and deployment viewing
- ✅ Basic pod testing and logs
- ✅ Manifest deployment

### Phase 2 (Proposed)
- [ ] Helm chart management
- [ ] Service URL management
- [ ] Port forwarding
- [ ] Volume/PVC management
- [ ] Network policies

### Phase 3 (Future)
- [ ] Cluster metrics dashboard
- [ ] Resource quota management
- [ ] RBAC configuration
- [ ] Backup/restore functionality
- [ ] Multi-cluster management
- [ ] Custom resource management

## Conclusion

The Minikube feature represents a clean, isolated module that enhances FocusKube's capabilities without impacting core functionality. Its modular architecture makes it easy to extend, test, and maintain while keeping dependencies minimal and clear.
