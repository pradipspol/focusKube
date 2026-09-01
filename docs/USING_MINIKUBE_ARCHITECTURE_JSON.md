# Minikube Architecture JSON Reference

This JSON file (`minikube-architecture.json`) serves as a **machine-readable reference** for the Minikube feature architecture. It's designed to help with:

1. **Future Improvements** - Understand what exists before adding new features
2. **Automation** - Parse this JSON to generate code or documentation
3. **Quick Reference** - Find API endpoints, hooks, and methods instantly
4. **Consistency** - Maintain patterns when extending the feature

## How to Use This File

### For Development

When adding new features, reference the JSON to understand:

```json
// Find what endpoints already exist
"endpoints": [...]

// See all available service methods
"serviceMethods": [...]

// Check what React hooks are available
"hooks": [...]

// Review refetch intervals for performance tuning
"performance": { "refetchIntervals": {...} }
```

### File Location
```
docs/minikube-architecture.json
```

### Structure Overview

```
minikube-architecture.json
├── project (metadata)
├── fileStructure (all files created)
├── backend (Express, routes, services, types)
├── frontend (React, hooks, component)
├── dependencies (runtime deps)
├── integrationPoints (where it connects)
├── codeMetrics (lines of code stats)
├── features (implemented & future)
├── errorHandling (strategy)
├── performance (caching & intervals)
├── testing (test files & commands)
├── documentation (doc structure)
├── developmentWorkflow (how to add features)
├── securityConsiderations
└── maintenanceNotes
```

## Quick Reference Examples

### Find All API Endpoints
```json
backend.endpoints[*] → lists all 13 endpoints
- method, path, description, parameters
```

### Find Specific Hook Info
```json
frontend.hooks[?name=="usePods"]
→ Returns hook details, refetch interval, cache keys
```

### Check Service Methods by Category
```json
backend.serviceMethods[?category=="Pod Debugging"]
→ Lists all pod-related methods in service
```

### View Integration Points
```json
integrationPoints → shows where to add component
- Backend: src/index.ts registration
- Frontend: App.tsx usage
```

### See All Query Cache Keys
```json
performance.queryKeys → all React Query cache keys
→ Use for mutation invalidation
```

## Using for Code Generation

### Python Example - Parse and List Endpoints
```python
import json

with open('minikube-architecture.json') as f:
    arch = json.load(f)
    
for endpoint in arch['backend']['endpoints']:
    print(f"{endpoint['method']} {endpoint['path']}")
    print(f"  Service: {endpoint['serviceMethod']}")
    print()
```

### JavaScript Example - Get All React Hooks
```javascript
const arch = require('./minikube-architecture.json');
const hookNames = arch.frontend.hooks.map(h => h.name);
console.log(hookNames);
// Output: ["useMinikubeHealth", "useMinikubeStatus", ...]
```

## Adding New Features

When implementing a new feature:

1. **Update this JSON file first** with the new addition
2. **Then implement the code** following the documented pattern
3. **Run tests** using commands listed in `testing` section
4. **Update documentation** by referencing the JSON structure

### Example: Adding New Endpoint

```json
{
  "method": "GET",
  "path": "/volumes",
  "description": "List persistent volumes",
  "query": [
    { "name": "clusterName", "type": "string", "default": "minikube" }
  ],
  "response": { "volumes": ["VolumeInfo[]"] },
  "serviceMethod": "getVolumes(clusterName)"
}
```

Then:
1. Add method to `MinikubeService`
2. Add route to `minikube.ts`
3. Add hook to `minikubeApi.ts`
4. Update component

## Maintenance Checklist

When updating the feature:

- [ ] Update this JSON file first
- [ ] Update code files
- [ ] Update tests
- [ ] Update documentation
- [ ] Keep `codeMetrics` accurate
- [ ] Update `features.implemented` or `features.future`

## File Statistics in JSON

Check current state anytime:

```json
codeMetrics:
  - totalLines: 3200+
  - totalFiles: 11
  - backendLines: 852
  - frontendLines: 1140
  - typeScriptCoverage: "100%"
```

## API Endpoint Quick Reference

All endpoints under `/api/minikube/`:

### Cluster Operations
- `GET /health` - Installation check
- `GET /status` - Cluster status
- `POST /start` - Start cluster
- `POST /stop` - Stop cluster
- `POST /delete` - Delete cluster

### Workload Operations
- `POST /deploy` - Deploy manifest
- `GET /deployments` - List deployments
- `GET /pods` - List pods
- `GET /namespaces` - List namespaces

### Pod Operations
- `GET /pods/:name/logs` - Get logs
- `POST /pods/:name/exec` - Execute command
- `POST /pods/:name/test` - Test connectivity

## React Hooks Quick Reference

All in `minikubeApi.ts`:

### Query Hooks (auto-refresh)
- `useMinikubeHealth()` → 30s
- `useMinikubeStatus()` → 10s
- `usePods()` → 15s
- `useDeployments()` → 15s
- `useNamespaces()` → 30s
- `usePodLogs()` → on-demand

### Mutation Hooks
- `useStartCluster()`
- `useStopCluster()`
- `useDeleteCluster()`
- `useDeployManifest()`
- `useTestPod()`

## Extending Features

### Pattern: Service → Route → Hook → Component

1. **Service Method** (business logic)
   ```typescript
   async myMethod(param: Type): Promise<Result>
   ```

2. **Route Handler** (HTTP endpoint)
   ```typescript
   app.get('/path', async (req, res) => {
     const result = await service.myMethod(...);
     res.json(result);
   });
   ```

3. **React Hook** (client hook)
   ```typescript
   export const useMyMethod = () => {
     return useQuery({
       queryKey: ['minikube', 'my-method'],
       queryFn: () => fetch('/api/minikube/path')
     });
   };
   ```

4. **Component Usage**
   ```typescript
   const { data } = useMyMethod();
   return <div>{data?.result}</div>;
   ```

## Performance Tuning

Adjust refetch intervals in `minikubeApi.ts`:

```typescript
refetchInterval: 15000  // milliseconds
// Higher = fewer API calls but slower updates
// Lower = more API calls but faster updates
```

Reference in JSON: `performance.refetchIntervals`

## Testing Commands

```bash
# From docs/minikube-architecture.json
testing.runCommands:
  - "npm test src/services/minikubeService.test.ts"
  - "npm test src/routes/minikube.test.ts"
  - "npm test"
  - "npm run test:coverage"
```

## Documentation Map

See `documentation.structure` in JSON for all docs:

1. **MINIKUBE_FEATURE.md** - Comprehensive reference
2. **MINIKUBE_QUICKSTART.md** - Getting started
3. **MINIKUBE_ARCHITECTURE.md** - Technical deep dive
4. **MINIKUBE_VISUAL_GUIDE.md** - Diagrams and flows
5. **minikube-architecture.json** - This machine-readable reference

## Questions to Ask When Extending

1. Is there already an endpoint for this? (Check `backend.endpoints`)
2. What cache key should I use? (Check `performance.queryKeys`)
3. What refetch interval is appropriate? (Check `performance.refetchIntervals`)
4. What errors might occur? (Check `errorHandling`)
5. Where does it integrate? (Check `integrationPoints`)

## Version Control

Keep this JSON updated in:
- Every commit that changes the feature
- Branch: main (alongside feature code)
- Path: `docs/minikube-architecture.json`

## Future Enhancement Ideas

Ideas from `features.future` in JSON:

- [ ] Helm chart management
- [ ] Service URL and port forwarding
- [ ] Volume management
- [ ] Network policies
- [ ] Resource monitoring
- [ ] Metrics dashboard
- [ ] Multi-cluster comparison
- [ ] Backup/restore

## Support & Automation

This JSON can be used for:

- ✅ Generating API documentation
- ✅ Creating OpenAPI/Swagger specs
- ✅ Generating TypeScript types
- ✅ Building CLI reference
- ✅ Automating tests
- ✅ Building dashboards
- ✅ IDE intellisense
- ✅ Code generators

## Next Steps

1. Use this JSON for future improvements
2. Update it before implementing new features
3. Reference it when adding extensions
4. Keep it in sync with actual code
5. Consider building automation tools around it

---

**Last Updated**: 2026-08-31  
**Status**: Production Ready  
**Usage**: Reference for development and future improvements
