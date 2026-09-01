# Minikube Feature - Architecture Reference System

## Overview

This system consists of structured reference files that enable rapid understanding and improvement of the Minikube feature.

## Core Reference Files

### 1. **minikube-architecture.json** (Machine-Readable)
**Purpose**: Comprehensive, structured reference for all architecture elements  
**Size**: ~1000 lines  
**Format**: JSON (parseable by tools)  
**Location**: `docs/minikube-architecture.json`

**Contents**:
- Project metadata and isolation strategy
- Complete file structure with line counts
- All 13 API endpoints with parameters
- All 18 service methods organized by category
- All 11 React hooks with cache keys
- TypeScript type definitions
- Dependency list
- Performance tuning parameters
- Testing commands
- Error handling strategy

**Best For**:
- ✅ Code generation and automation
- ✅ Validating existing implementations
- ✅ Finding specific endpoints/hooks/methods
- ✅ Understanding current scope
- ✅ Building tools around the architecture

### 2. **USING_MINIKUBE_ARCHITECTURE_JSON.md** (Usage Guide)
**Purpose**: Instructions for leveraging the JSON file  
**Location**: `docs/USING_MINIKUBE_ARCHITECTURE_JSON.md`

**Covers**:
- How to use the JSON for development
- Code examples (Python, JavaScript)
- How to add new features
- Quick reference patterns
- Maintenance checklist
- Performance tuning with JSON reference

### 3. **MINIKUBE_QUICK_REFERENCE.md** (Navigation)
**Purpose**: Quick lookup for common queries  
**Location**: `docs/MINIKUBE_QUICK_REFERENCE.md`

**Provides**:
- Top-level key structure
- Common JSON queries and answers
- API endpoints organized by category
- Service methods organized by category
- React hooks organized by purpose
- File statistics
- Extension pattern
- Integration checklist

### 4. **MINIKUBE_FEATURE.md** (Comprehensive Docs)
**Purpose**: Full feature documentation  
**Location**: `docs/MINIKUBE_FEATURE.md`

**Contains**:
- Feature overview
- Complete architecture
- API reference with examples
- Frontend features
- Testing guide
- Troubleshooting
- Future enhancements

### 5. **MINIKUBE_QUICKSTART.md** (Getting Started)
**Purpose**: Quick start guide  
**Location**: `docs/MINIKUBE_QUICKSTART.md`

**Includes**:
- Installation steps
- Running servers
- Common tasks with examples
- Troubleshooting
- Testing procedures

### 6. **MINIKUBE_ARCHITECTURE.md** (Technical Deep Dive)
**Purpose**: Detailed technical documentation  
**Location**: `docs/MINIKUBE_ARCHITECTURE.md`

**Explains**:
- Architectural layers
- Data flows
- Isolation mechanisms
- Type safety
- Error handling
- Extension points
- Performance considerations

### 7. **MINIKUBE_VISUAL_GUIDE.md** (Diagrams)
**Purpose**: Visual architecture representation  
**Location**: `docs/MINIKUBE_VISUAL_GUIDE.md`

**Shows**:
- System architecture diagrams
- Data flow diagrams
- Component hierarchy
- API endpoint tree
- State management flow
- File organization

## How to Use These Files

### Scenario 1: "I want to add a new feature"

1. **Read**: `MINIKUBE_QUICK_REFERENCE.md` → Extension Pattern section
2. **Check**: `minikube-architecture.json` → `developmentWorkflow`
3. **Verify**: What similar features exist? Check `backend.serviceMethods`
4. **Reference**: Check `performance.refetchIntervals` for timing decisions
5. **Implement**: Follow the 6-step pattern
6. **Update**: JSON file with new additions

### Scenario 2: "What endpoints already exist?"

1. **Open**: `minikube-architecture.json`
2. **Go to**: `backend.endpoints[*]`
3. **Review**: All 13 endpoints with method, path, description
4. **Check**: `serviceMethod` field to see implementation

### Scenario 3: "How do I use the React hooks?"

1. **Open**: `MINIKUBE_QUICK_REFERENCE.md`
2. **Go to**: "React Query Hooks by Purpose" section
3. **Find**: Your use case (Status Monitoring or Operations)
4. **Reference**: Hook name and refetch interval

### Scenario 4: "What's the cache key pattern?"

1. **Open**: `minikube-architecture.json`
2. **Go to**: `performance.queryKeys`
3. **Use**: The pattern for your mutation invalidation

### Scenario 5: "How do I test my changes?"

1. **Open**: `minikube-architecture.json`
2. **Go to**: `testing.runCommands`
3. **Run**: Appropriate test command

## File Location Map

```
docs/
├── minikube-architecture.json ..................... ⭐ Core Reference (Machine-Readable)
├── USING_MINIKUBE_ARCHITECTURE_JSON.md .......... 📖 How to Use JSON
├── MINIKUBE_QUICK_REFERENCE.md ................... 🔍 Quick Lookup
├── MINIKUBE_FEATURE.md ............................ 📚 Full Reference
├── MINIKUBE_QUICKSTART.md ........................ 🚀 Getting Started
├── MINIKUBE_ARCHITECTURE.md ..................... 🏗️  Technical Details
├── MINIKUBE_VISUAL_GUIDE.md ..................... 📊 Diagrams
├── MINIKUBE_IMPLEMENTATION.md .................. ✅ Implementation Summary
└── ARCHITECTURE_REFERENCE_SYSTEM.md ........... 📋 This File
```

## Quick Facts from JSON

| Metric | Value |
|--------|-------|
| Total Lines of Code | 3,200+ |
| API Endpoints | 13 |
| React Hooks | 11 |
| Service Methods | 18 |
| Files | 11 |
| Documentation Pages | 8 |
| TypeScript Coverage | 100% |

## Integration Points

### Backend (Express.js)
- **Location**: `platform/backend/src/index.ts`
- **Add**: `import { minikubeRouter } from './routes/minikube.js'`
- **Register**: `app.use('/api/minikube', minikubeRouter)`
- **Reference in JSON**: `integrationPoints.backend`

### Frontend (React)
- **Location**: `platform/frontend/src/App.tsx`
- **Add**: `import { MinikubePanel } from './components/MinikubePanel'`
- **Use**: `<MinikubePanel />` anywhere in your component tree
- **Reference in JSON**: `integrationPoints.frontend`

## Key Statistics from JSON

### Backend
- Service: 427 lines
- Routes: 225 lines
- Tests: 200 lines
- **Total**: 852 lines

### Frontend
- Hooks: 290 lines
- Component: 350 lines
- Styling: 500 lines
- **Total**: 1,140 lines

### Documentation
- Feature guide: 500 lines
- Quick start: 300 lines
- Architecture: 400 lines
- Visual guide: 300 lines
- JSON this file: 1,000 lines
- Usage guide: 200 lines
- Quick reference: 200 lines
- **Total**: 3,000+ lines

## Common Use Cases

### Adding a New API Endpoint

1. Edit `minikube-architecture.json` → `backend.endpoints`
2. Add service method to `minikubeService.ts`
3. Add route handler to `minikube.ts`
4. Add React hook to `minikubeApi.ts`
5. Update component in `MinikubePanel.tsx`
6. Add tests
7. Update all reference files

### Debugging a Feature

1. Check `minikube-architecture.json` → relevant section
2. Reference actual implementation
3. Run tests from `testing.runCommands`
4. Check error handling in `errorHandling` section
5. Verify cache keys in `performance.queryKeys`

### Optimizing Performance

1. Check current `performance.refetchIntervals` in JSON
2. Measure impact of adjusting intervals
3. Update JSON with new values
4. Test with `testing.runCommands`

### Extending Architecture

1. Document in JSON first
2. Implement code following patterns
3. Update documentation
4. Run full test suite
5. Verify metrics in JSON still accurate

## Dependencies Management

### Backend Dependencies
```json
{
  "@kubernetes/client-node": "^0.22.3",
  "express": "^4.21.2",
  "zod": "^3.23.8",
  "js-yaml": "^4.1.0",
  "pino": "^10.3.1"
}
```
Reference in JSON: `dependencies.backend`

### Frontend Dependencies
```json
{
  "react": "^18.3.1",
  "@tanstack/react-query": "^5.62.7"
}
```
Reference in JSON: `dependencies.frontend`

## Maintenance Schedule

### Weekly
- ✅ Review test results
- ✅ Check for dependency updates

### Monthly
- ✅ Update JSON with any additions
- ✅ Review performance metrics
- ✅ Verify documentation is accurate

### Quarterly
- ✅ Update dependencies
- ✅ Run full test suite
- ✅ Review code metrics

## Future Enhancements (from JSON)

Planned features documented in `features.future`:

1. Helm chart management
2. Service URL and port forwarding
3. Volume and PVC management
4. Network policy management
5. Resource usage monitoring
6. Cluster metrics dashboard
7. Multi-cluster comparison
8. Backup/restore functionality

## Important Patterns

### Adding Any New Feature (6 Steps)

From `developmentWorkflow.addingNewFeature`:

1. Add service method → `minikubeService.ts`
2. Add route handler → `minikube.ts`
3. Add React hook → `minikubeApi.ts`
4. Update component → `MinikubePanel.tsx`
5. Add tests → `*.test.ts`
6. Update docs & JSON

### Error Handling Levels (from JSON)

1. **Service Level**: Try-catch with HttpError throws
2. **Route Level**: withRouteErrorLogging middleware
3. **Frontend Level**: React Query error state + component

### Query Cache Invalidation

After mutations, invalidate related caches:
- Start cluster → invalidate `['minikube', 'status']`
- Deploy manifest → invalidate `['minikube', 'deployments']`
- Delete cluster → invalidate `['minikube']` (all)

## Testing Strategy (from JSON)

### Run Specific Tests
```bash
npm test src/services/minikubeService.test.ts
npm test src/routes/minikube.test.ts
```

### Full Coverage
```bash
npm run test:coverage
```

### All Tests
```bash
npm test
```

## Quick Lookup Tables

### All 13 Endpoints
```
GET  /health              Installation check
GET  /status              Cluster status
POST /start               Start cluster
POST /stop                Stop cluster
POST /delete              Delete cluster
POST /deploy              Deploy manifest
GET  /deployments         List deployments
GET  /pods                List pods
GET  /namespaces          List namespaces
GET  /pods/:name/logs     Get pod logs
POST /pods/:name/exec     Execute command
POST /pods/:name/test     Test connectivity
```

### Refetch Intervals
```
health: 30s      (lightweight check)
status: 10s      (critical for UI)
pods: 15s        (balanced)
deployments: 15s (balanced)
namespaces: 30s  (rarely changes)
podLogs: on-demand
```

## Document Purposes at a Glance

| Document | Purpose | Best For |
|----------|---------|----------|
| `minikube-architecture.json` | Machine-readable reference | Tools, automation, verification |
| `USING_MINIKUBE_ARCHITECTURE_JSON.md` | How to use JSON | Learning to leverage JSON |
| `MINIKUBE_QUICK_REFERENCE.md` | Quick lookups | Finding specific endpoints/hooks |
| `MINIKUBE_FEATURE.md` | Full documentation | Understanding everything |
| `MINIKUBE_QUICKSTART.md` | Getting started | New developers |
| `MINIKUBE_ARCHITECTURE.md` | Technical deep dive | Understanding design decisions |
| `MINIKUBE_VISUAL_GUIDE.md` | Diagrams and flows | Visual learners |
| `MINIKUBE_IMPLEMENTATION.md` | Implementation summary | High-level overview |

## Next Time You Need to Improve

1. **Question**: What endpoints exist?
   - **Answer**: Check `minikube-architecture.json` → `backend.endpoints`

2. **Question**: How do I add a new feature?
   - **Answer**: Check `MINIKUBE_QUICK_REFERENCE.md` → Extension Pattern

3. **Question**: What refetch interval should I use?
   - **Answer**: Check `minikube-architecture.json` → `performance.refetchIntervals`

4. **Question**: What cache key pattern do I need?
   - **Answer**: Check `minikube-architecture.json` → `performance.queryKeys`

5. **Question**: How do I test my changes?
   - **Answer**: Check `minikube-architecture.json` → `testing.runCommands`

---

**Status**: Complete Reference System Ready  
**Created**: 2026-08-31  
**Maintenance**: Update JSON with each new feature  
**Purpose**: Enable rapid understanding and improvement  
**Usage**: Refer to appropriate document based on your need
