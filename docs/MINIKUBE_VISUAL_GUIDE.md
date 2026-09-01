# Minikube Feature - Visual Architecture Overview

## System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                          FocusKube App                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    Frontend (React)                          │   │
│  ├──────────────────────────────────────────────────────────────┤   │
│  │                                                               │   │
│  │  ┌─────────────────────────────────────────────────────┐    │   │
│  │  │         MinikubePanel Component                      │    │   │
│  │  │  ┌──────────────────────────────────────────────┐   │    │   │
│  │  │  │  Cluster Status     │ Real-time Updates      │   │    │   │
│  │  │  │  Cluster Control    │ Pod Logs & Metrics     │   │    │   │
│  │  │  │  Config Form        │ Deployment Listing     │   │    │   │
│  │  │  │  Namespace Selector │ Pod Testing            │   │    │   │
│  │  │  │  Manifest Deployment│ Error Handling         │   │    │   │
│  │  │  └──────────────────────────────────────────────┘   │    │   │
│  │  └─────────────────────────────────────────────────────┘    │   │
│  │                         ↓                                     │   │
│  │  ┌─────────────────────────────────────────────────────┐    │   │
│  │  │      React Query Hooks (minikubeApi.ts)            │    │   │
│  │  │  • useMinikubeStatus()     • usePods()             │    │   │
│  │  │  • useStartCluster()       • usePodLogs()          │    │   │
│  │  │  • useStopCluster()        • useDeployments()      │    │   │
│  │  │  • useDeleteCluster()      • useNamespaces()       │    │   │
│  │  │  • useDeployManifest()     • useTestPod()          │    │   │
│  │  └─────────────────────────────────────────────────────┘    │   │
│  │                         ↓ HTTP                                │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                   Backend (Node.js)                          │   │
│  ├──────────────────────────────────────────────────────────────┤   │
│  │                                                               │   │
│  │  ┌─────────────────────────────────────────────────────┐    │   │
│  │  │        Express API Routes (minikube.ts)             │    │   │
│  │  │  /status          /pods              /deploy        │    │   │
│  │  │  /start           /pods/:name/logs   /deployments   │    │   │
│  │  │  /stop            /pods/:name/exec   /namespaces    │    │   │
│  │  │  /delete          /pods/:name/test   /health        │    │   │
│  │  └─────────────────────────────────────────────────────┘    │   │
│  │                         ↓                                     │   │
│  │  ┌─────────────────────────────────────────────────────┐    │   │
│  │  │    MinikubeService (minikubeService.ts)            │    │   │
│  │  │  ┌──────────────────────────────────────────────┐   │    │   │
│  │  │  │ Cluster Management                          │   │    │   │
│  │  │  │ • startCluster()      • getStatus()         │   │    │   │
│  │  │  │ • stopCluster()       • isMinikubeInstalled │   │    │   │
│  │  │  │ • deleteCluster()                           │   │    │   │
│  │  │  └──────────────────────────────────────────────┘   │    │   │
│  │  │  ┌──────────────────────────────────────────────┐   │    │   │
│  │  │  │ Workload Management                         │   │    │   │
│  │  │  │ • deployManifest()    • getPods()           │   │    │   │
│  │  │  │ • getDeployments()    • getNamespaces()     │   │    │   │
│  │  │  └──────────────────────────────────────────────┘   │    │   │
│  │  │  ┌──────────────────────────────────────────────┐   │    │   │
│  │  │  │ Pod Debugging & Testing                     │   │    │   │
│  │  │  │ • getPodLogs()        • testPod()           │   │    │   │
│  │  │  │ • execInPod()                               │   │    │   │
│  │  │  └──────────────────────────────────────────────┘   │    │   │
│  │  └─────────────────────────────────────────────────────┘    │   │
│  │                         ↓                                     │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
                                ↓
        ┌───────────────────────┴───────────────────────┐
        ↓                       ↓                       ↓
   ┌─────────┐         ┌────────────────┐         ┌──────────┐
   │ Minikube │         │ Kubernetes     │         │ Docker   │
   │ CLI      │         │ API Client     │         │ Daemon   │
   │ Commands │         │ (@k8s/client)  │         │          │
   └─────────┘         └────────────────┘         └──────────┘
        ↓                       ↓                       ↓
   ┌──────────────────────────────────────────────────────────┐
   │     ~/.minikube/kubeconfig                               │
   │     (Local Kubernetes Cluster)                           │
   └──────────────────────────────────────────────────────────┘
        ↓                       ↓                       ↓
   ┌─────────┐         ┌────────────────┐         ┌──────────┐
   │ Cluster │         │ Deployments    │         │ Pods     │
   │ Resources│         │ & Services     │         │ & Logs   │
   └─────────┘         └────────────────┘         └──────────┘
```

## Data Flow Diagrams

### Cluster Start Flow
```
┌─────────────────┐
│ User Clicks     │
│ "Start" Button  │
└────────┬────────┘
         ↓
┌─────────────────────────────────────┐
│ MinikubePanel.tsx                    │
│ • handleStartCluster()               │
└────────┬────────────────────────────┘
         ↓
┌─────────────────────────────────────┐
│ useStartCluster() Hook               │
│ • Sends mutation                     │
└────────┬────────────────────────────┘
         ↓
┌─────────────────────────────────────┐
│ minikubeApi.startCluster()           │
│ • Makes POST /api/minikube/start     │
└────────┬────────────────────────────┘
         ↓ HTTP POST
┌─────────────────────────────────────┐
│ Express Route Handler                │
│ • Validates input (Zod)              │
│ • Logs operation                     │
└────────┬────────────────────────────┘
         ↓
┌─────────────────────────────────────┐
│ minikubeService.startCluster()       │
│ • Executes: minikube start ...       │
│ • Waits for completion               │
│ • Returns cluster status             │
└────────┬────────────────────────────┘
         ↓
┌─────────────────────────────────────┐
│ Route returns JSON response          │
│ {status: "running", ...}             │
└────────┬────────────────────────────┘
         ↓ HTTP Response
┌─────────────────────────────────────┐
│ React Query Cache Updated            │
│ • Invalidates related queries        │
│ • Background refetch triggered       │
└────────┬────────────────────────────┘
         ↓
┌─────────────────────────────────────┐
│ MinikubePanel Component Re-renders   │
│ • Displays new status                │
│ • Shows cluster IP, k8s version      │
│ • Enables pod/deployment viewing     │
└─────────────────────────────────────┘
```

### Pod Listing Flow
```
┌─────────────────────────────┐
│ Component Mounts            │
│ usePods() Hook Executed     │
└────────┬────────────────────┘
         ↓
┌─────────────────────────────┐
│ React Query Detects New Key │
│ ['minikube', 'pods',...]    │
└────────┬────────────────────┘
         ↓
┌─────────────────────────────┐
│ minikubeApi.getPods()       │
│ • HTTP GET /pods            │
│ • Includes namespace query   │
└────────┬────────────────────┘
         ↓ HTTP GET
┌─────────────────────────────┐
│ Express Route Handler       │
│ • Parse query params        │
│ • Validate inputs           │
└────────┬────────────────────┘
         ↓
┌─────────────────────────────┐
│ minikubeService.getPods()   │
│ • Load kubeconfig           │
│ • Create k8s API client     │
│ • List pods via k8s API     │
│ • Parse pod data            │
│ • Return pod list           │
└────────┬────────────────────┘
         ↓
┌─────────────────────────────┐
│ Route returns JSON          │
│ { pods: [...] }             │
└────────┬────────────────────┘
         ↓ HTTP Response
┌─────────────────────────────┐
│ React Query Caches Result   │
│ Stores with TTL             │
└────────┬────────────────────┘
         ↓
┌─────────────────────────────┐
│ Component Re-renders        │
│ Displays pods table         │
└────────┬────────────────────┘
         ↓
┌─────────────────────────────┐
│ Auto-Refetch Scheduled      │
│ Every 15 seconds            │
│ (configurable)              │
└─────────────────────────────┘
```

## Component Hierarchy

```
App.tsx
└── MinikubePanel.tsx (Main Component)
    ├── useMinikubeHealth()          → Display installation status
    ├── useMinikubeStatus()          → Display cluster status
    ├── useNamespaces()              → Namespace selector
    ├── useDeployments()             → Deployments table
    ├── usePods()                    → Pods table
    ├── usePodLogs()                 → Pod logs display
    ├── useStartCluster() (Mutation) → Start button
    ├── useStopCluster() (Mutation)  → Stop button
    ├── useDeleteCluster() (Mutation)→ Delete button
    ├── useDeployManifest() (Mut.)   → Deploy button
    └── useTestPod() (Mutation)      → Test pod button
```

## API Endpoint Tree

```
/api/minikube/
├── GET    /health                              (Health check)
├── GET    /status                              (Cluster status)
├── POST   /start                               (Start cluster)
├── POST   /stop                                (Stop cluster)
├── POST   /delete                              (Delete cluster)
├── GET    /namespaces                          (List namespaces)
├── GET    /deployments                         (List deployments)
├── GET    /pods                                (List pods)
├── POST   /deploy                              (Deploy manifest)
├── /pods
│   └── :podName
│       ├── GET  /logs                          (Get pod logs)
│       ├── POST /exec                          (Execute command)
│       └── POST /test                          (Test pod)
```

## State Management Flow (React Query)

```
User Action
    ↓
React Hook Called (useStartCluster, usePods, etc.)
    ↓
┌─────────────────────────────────────┐
│ React Query Mutation/Query           │
│ • Checks cache (TTL)                 │
│ • Checks stale status                │
└────────┬────────────────────────────┘
         ↓
    Is Cached & Fresh?
    /            \
   YES           NO
   ↓             ↓
Return Cached  Fetch Fresh
Data           Data from API
   ↓             ↓
   └──────┬──────┘
          ↓
    Update Query Cache
    with New Data
          ↓
    Component Re-renders
    with New Data
          ↓
    Background Refetch
    Scheduled for Next Interval
```

## Error Handling Flow

```
API Call Made
     ↓
┌─────────────────────────────────────┐
│ Route Handler (withRouteErrorLogging)│
└────────┬────────────────────────────┘
         ↓
    Error Thrown?
    /            \
   NO            YES
   ↓             ↓
Return         Error Caught
200 OK         by Middleware
   ↓             ↓
React Query   Error Logged
Updates Cache │ Stack trace
   ↓          │ Context data
Component     ↓
Re-renders    HTTP Error Response
              (400/500)
              ↓
              React Query
              Catches Error
              ↓
              Stores in
              mutation.error
              ↓
              Component
              Displays Error
              Message
```

## File Organization

```
focusKube/
├── platform/
│   ├── backend/
│   │   └── src/
│   │       ├── services/
│   │       │   ├── minikubeService.ts (↑ Core Logic)
│   │       │   └── minikubeService.test.ts
│   │       ├── routes/
│   │       │   ├── minikube.ts (↑ API Endpoints)
│   │       │   └── minikube.test.ts
│   │       └── index.ts (↑ Router Registration)
│   │
│   └── frontend/
│       └── src/
│           ├── api/
│           │   └── minikubeApi.ts (↑ React Hooks)
│           └── components/
│               ├── MinikubePanel.tsx (↑ React Component)
│               └── MinikubePanel.css (↑ Styling)
│
└── docs/
    ├── MINIKUBE_FEATURE.md (↑ Full Reference)
    ├── MINIKUBE_QUICKSTART.md (↑ Getting Started)
    ├── MINIKUBE_ARCHITECTURE.md (↑ Deep Dive)
    └── MINIKUBE_IMPLEMENTATION.md (↑ Summary)
```

## Key Design Principles

### 1. Isolation
- ✅ Dedicated API namespace (`/api/minikube/`)
- ✅ Independent service (no dependencies)
- ✅ Self-contained UI component
- ✅ Separate kubeconfig storage

### 2. Separation of Concerns
- ✅ Service Layer (Business Logic)
- ✅ Route Layer (HTTP Handling)
- ✅ API Layer (React Hooks)
- ✅ Component Layer (UI Rendering)

### 3. Type Safety
- ✅ TypeScript throughout
- ✅ Zod validation on routes
- ✅ React Query type hints
- ✅ Export types for reuse

### 4. Error Handling
- ✅ Try-catch at service level
- ✅ Error logging middleware
- ✅ User-friendly messages
- ✅ Proper HTTP status codes

### 5. Performance
- ✅ React Query caching
- ✅ Configurable refetch intervals
- ✅ Background updates
- ✅ Optimistic mutations

## Integration Checklist

- ✅ Backend service created
- ✅ API routes registered
- ✅ Frontend hooks implemented
- ✅ UI component built
- ✅ Styling complete
- ✅ Tests written
- ✅ Documentation created
- ✅ Error handling included
- ✅ Type safety verified
- ✅ Ready for production

## Next Phase: Extending the Feature

To add new operations:

1. **Add Service Method** → `minikubeService.ts`
2. **Add Route Handler** → `minikube.ts`
3. **Add React Hook** → `minikubeApi.ts`
4. **Update Component** → `MinikubePanel.tsx`
5. **Add Tests** → `*.test.ts`
6. **Update Docs** → `MINIKUBE_FEATURE.md`

This pattern can be repeated for all future enhancements!
