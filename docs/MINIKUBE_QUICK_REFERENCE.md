# Minikube Architecture JSON - Quick Navigation Guide

## Top-Level Keys

```
minikube-architecture.json
│
├── 📋 project
│   └── Metadata, status, isolation info
│
├── 📁 fileStructure
│   ├── backend (services, routes)
│   ├── frontend (api, components)
│   └── documentation (all docs)
│
├── 🔧 backend
│   ├── framework, language, basePath
│   ├── endpoints (13 REST endpoints)
│   ├── serviceMethods (18 methods organized by category)
│   └── types (TypeScript types)
│
├── ⚛️  frontend
│   ├── framework, language, stateManagement
│   ├── hooks (11 React Query hooks)
│   └── component (UI component details)
│
├── 📦 dependencies
│   ├── backend (runtime deps)
│   └── frontend (runtime deps)
│
├── 🔗 integrationPoints
│   ├── backend (registration in index.ts)
│   └── frontend (usage in App.tsx)
│
├── 📊 codeMetrics
│   └── lines, files, coverage stats
│
├── ✨ features
│   ├── implemented (10+ features)
│   └── future (8 planned features)
│
├── ⚠️  errorHandling
│   ├── layers (service, route, frontend)
│   └── httpStatusCodes
│
├── ⚡ performance
│   ├── caching strategy
│   ├── refetchIntervals (by operation)
│   └── queryKeys (React Query cache keys)
│
├── 🧪 testing
│   ├── backendTests
│   └── runCommands
│
├── 📚 documentation
│   └── structure (all docs)
│
├── 🛠️  developmentWorkflow
│   └── How to add new features (6 steps)
│
├── 🔒 securityConsiderations
│   └── 6 security points
│
└── 📝 maintenanceNotes
    └── Dependencies, testing, compatibility
```

## How to Query This JSON

### Find All REST Endpoints
```
backend.endpoints[*]
→ Returns array of 13 endpoints with method, path, params, response
```

### Find Specific Service Method
```
backend.serviceMethods[*].methods[?name=="getDeployments"]
→ Returns method details: params, return type, description
```

### Get All React Query Hooks
```
frontend.hooks[*]
→ Returns 11 hooks with refetch intervals, query keys, cache behavior
```

### Check Cluster Management Methods
```
backend.serviceMethods[?category=="Cluster Management"]
→ Returns 5 methods for starting, stopping, deleting clusters
```

### View Workload Operations
```
backend.serviceMethods[?category=="Workload Management"]
→ Returns 4 methods for deployments, pods, namespaces
```

### List Pod Debugging Tools
```
backend.serviceMethods[?category=="Pod Debugging"]
→ Returns 3 methods for logs, exec, testing
```

### Get All TypeScript Types
```
backend.types
→ Returns MinikubeStatus, MinikubeCluster, DeploymentInfo, PodInfo types
```

### Check Query Cache Keys
```
performance.queryKeys
→ All React Query cache key patterns
```

### View Refetch Intervals
```
performance.refetchIntervals
→ Auto-refresh intervals for each operation type
```

### Find Component Sections
```
frontend.component.sections[*]
→ 8 sections in MinikubePanel UI
```

### Get Hook Invalidation Rules
```
frontend.hooks[?invalidates]
→ Shows which cache keys are invalidated by mutations
```

## Common Queries

### "Where do I add a new API endpoint?"
```
integrationPoints.backend.file
→ backend/src/index.ts (register router)
→ backend/src/routes/minikube.ts (add endpoint)
```

### "What API methods exist?"
```
backend.endpoints[*] {path, method, description}
→ All 13 endpoints listed with details
```

### "What React hooks do I need?"
```
frontend.hooks[*] {name, returns, description}
→ 11 available hooks for all operations
```

### "How do I add a new feature?"
```
developmentWorkflow.addingNewFeature[*]
→ 6-step pattern for adding features
```

### "What test commands should I run?"
```
testing.runCommands
→ npm test, npm run test:coverage, etc.
```

### "What are the cache keys?"
```
performance.queryKeys
→ All React Query cache key patterns
```

### "How often does X refetch?"
```
performance.refetchIntervals
→ Refresh intervals: health 30s, status 10s, pods 15s, etc.
```

### "What endpoints exist?"
```
backend.endpoints[*] {path, method}
→ GET /status, POST /start, GET /pods, etc.
```

### "What types are defined?"
```
backend.types
→ MinikubeStatus, MinikubeCluster, DeploymentInfo, PodInfo
```

### "What hooks are available?"
```
frontend.hooks[*] {name}
→ useMinikubeStatus, usePods, useStartCluster, etc.
```

## File Structure Quick Reference

### Backend Files (with line counts)
- `services/minikubeService.ts` - 427 lines (core logic)
- `services/minikubeService.test.ts` - 70 lines (tests)
- `routes/minikube.ts` - 225 lines (endpoints)
- `routes/minikube.test.ts` - 130 lines (tests)

### Frontend Files (with line counts)
- `api/minikubeApi.ts` - 290 lines (hooks)
- `components/MinikubePanel.tsx` - 350 lines (component)
- `components/MinikubePanel.css` - 500 lines (styling)

### Documentation Files
- `MINIKUBE_FEATURE.md` - 500 lines
- `MINIKUBE_QUICKSTART.md` - 300 lines
- `MINIKUBE_ARCHITECTURE.md` - 400 lines
- `MINIKUBE_VISUAL_GUIDE.md` - 300 lines
- `minikube-architecture.json` - This machine-readable reference
- `USING_MINIKUBE_ARCHITECTURE_JSON.md` - How to use this file

## API Endpoints by Category

### Cluster Management (5 endpoints)
- `GET /health` - Installation check
- `GET /status` - Get cluster status
- `POST /start` - Start cluster
- `POST /stop` - Stop cluster
- `POST /delete` - Delete cluster

### Workload Management (4 endpoints)
- `POST /deploy` - Deploy manifest
- `GET /deployments` - List deployments
- `GET /pods` - List pods
- `GET /namespaces` - List namespaces

### Pod Operations (4 endpoints)
- `GET /pods/:name/logs` - Get pod logs
- `POST /pods/:name/exec` - Execute command
- `POST /pods/:name/test` - Test connectivity

## Service Methods by Category

### Cluster Management (5 methods)
- `startCluster(options)` - Start cluster with config
- `stopCluster(clusterName)` - Stop cluster
- `deleteCluster(clusterName)` - Delete cluster
- `getStatus(clusterName)` - Get current status
- `isMinikubeInstalled()` - Check installation

### Workload Management (4 methods)
- `deployManifest(manifest, clusterName)` - Deploy YAML
- `getDeployments(clusterName, namespace)` - List deployments
- `getPods(clusterName, namespace)` - List pods
- `getNamespaces(clusterName)` - List namespaces

### Pod Debugging (3 methods)
- `getPodLogs(podName, clusterName, namespace)` - Get logs
- `execInPod(podName, command, clusterName, namespace)` - Execute command
- `testPod(podName, clusterName, namespace)` - Test pod

## React Query Hooks by Purpose

### Status Monitoring (6 hooks)
- `useMinikubeHealth()` → Installed? (30s)
- `useMinikubeStatus()` → Cluster status (10s)
- `usePods()` → Pod list (15s)
- `useDeployments()` → Deployment list (15s)
- `useNamespaces()` → Namespace list (30s)
- `usePodLogs()` → Pod logs (on-demand)

### Operations (5 mutations)
- `useStartCluster()` → Start cluster
- `useStopCluster()` → Stop cluster
- `useDeleteCluster()` → Delete cluster
- `useDeployManifest()` → Deploy YAML
- `useTestPod()` → Test pod connectivity

## Performance Tuning Points

### Refetch Intervals (in milliseconds)
```
health: 30000 (30 seconds) - Check installation
status: 10000 (10 seconds) - Critical for UI
pods: 15000 (15 seconds) - Balanced
deployments: 15000 (15 seconds) - Balanced
namespaces: 30000 (30 seconds) - Rarely changes
podLogs: on-demand - No auto-refresh
```

### Cache Keys
```
health: ["minikube", "health"]
status: ["minikube", "status", clusterName]
pods: ["minikube", "pods", clusterName, namespace]
deployments: ["minikube", "deployments", clusterName, namespace]
namespaces: ["minikube", "namespaces", clusterName]
podLogs: ["minikube", "pod-logs", podName, clusterName, namespace]
```

## Extension Pattern

When adding new features, follow this pattern:

```
1. Add Service Method → minikubeService.ts
2. Add Route Handler → minikube.ts
3. Add React Hook → minikubeApi.ts
4. Update Component → MinikubePanel.tsx
5. Add Tests → *.test.ts
6. Update Docs → MINIKUBE_FEATURE.md
7. Update JSON → minikube-architecture.json
```

## Key Statistics

- **Total Lines**: 3200+ lines of code
- **Total Files**: 11 files
- **API Endpoints**: 13 endpoints
- **React Hooks**: 11 hooks
- **Service Methods**: 18 methods
- **TypeScript Coverage**: 100%
- **Test Files**: 2 (service + routes)

## Documentation Map

```
docs/
├── MINIKUBE_FEATURE.md ..................... Full reference guide
├── MINIKUBE_QUICKSTART.md ................. Getting started
├── MINIKUBE_ARCHITECTURE.md .............. Technical deep dive
├── MINIKUBE_VISUAL_GUIDE.md .............. Diagrams & flows
├── minikube-architecture.json ............ Machine-readable
├── USING_MINIKUBE_ARCHITECTURE_JSON.md .. How to use JSON
└── MINIKUBE_QUICK_REFERENCE.md .......... This file
```

## How to Update JSON for New Features

1. Edit `minikube-architecture.json`
2. Add entry to appropriate section:
   - New endpoint? → `backend.endpoints[]`
   - New method? → `backend.serviceMethods[].methods[]`
   - New hook? → `frontend.hooks[]`
   - New section? → `frontend.component.sections[]`
3. Update `codeMetrics` if lines changed
4. Update `features.implemented` if new feature
5. Commit with feature implementation

## Quick Integration Checklist

- [ ] Backend service method added → `minikubeService.ts`
- [ ] Route handler added → `minikube.ts`
- [ ] React hook added → `minikubeApi.ts`
- [ ] Component updated → `MinikubePanel.tsx`
- [ ] Tests added → `*.test.ts`
- [ ] JSON updated → `minikube-architecture.json`
- [ ] Docs updated → `MINIKUBE_FEATURE.md`

---

**Format**: JSON (machine-readable)  
**Size**: ~1000 lines  
**Purpose**: Architecture reference for development and automation  
**Location**: `docs/minikube-architecture.json`  
**Update Frequency**: With every feature addition
