# Chat History Context Switching Bug - Fix Summary

## Problem Identified

When switching between cluster contexts in FocusKube, chat history was being lost or mixed up:

1. **Context Switching Issue**: When switching from Context A → Context B, the chat history for Context B might not load
2. **Data Overwrites**: When switching back to Context A, the history was lost because Context B had overwritten it in localStorage
3. **Root Cause**: localStorage keys were **context-agnostic** (hard-coded to `k8sExplorer.aiChatSessions` for all contexts)

## Root Cause Analysis

### Before Fix
```typescript
// Hard-coded keys - same for ALL cluster contexts!
const CHAT_SESSIONS_STORAGE_KEY = 'k8sExplorer.aiChatSessions';
const LEGACY_CHAT_HISTORY_STORAGE_KEY = 'k8sExplorer.aiChatHistory';
```

**Flow:**
1. Switch to Context A → History saved to `localStorage['k8sExplorer.aiChatSessions']`
2. Switch to Context B → History saved to SAME key (overwrites Context A's data)
3. Switch back to Context A → Only Context B's data exists in localStorage

### Why Backend Was Context-Aware But Frontend Wasn't
- **Backend API**: Properly uses `?context=` parameter to scope sessions per context ✅
- **Frontend localStorage**: Used hard-coded keys with no context awareness ❌
- **Mismatch**: This created a disconnect between the two storage layers

## Solution Implemented

### Changes Made to `platform/frontend/src/components/AiAssistantPanel.tsx`

#### 1. Context-Aware Storage Key Functions
```typescript
// Storage keys now include context to prevent overwrites
function getChatSessionsStorageKey(context: string): string {
  return `k8sExplorer.aiChatSessions:${context}`;
}

function getLegacyHistoryStorageKey(context: string): string {
  return `k8sExplorer.aiChatHistory:${context}`;
}
```

**Example localStorage keys after fix:**
- Context A: `k8sExplorer.aiChatSessions:cluster-a`
- Context B: `k8sExplorer.aiChatSessions:cluster-b`
- Default: `k8sExplorer.aiChatSessions:default`

#### 2. Updated Function Signatures
```typescript
// Before
function loadStoredSessions(): { sessions: ChatSession[]; activeSessionId: string }

// After - now accepts context parameter
function loadStoredSessions(context: string): { sessions: ChatSession[]; activeSessionId: string }
```

#### 3. Component Initialization
```typescript
// Now provides default context and passes to loadStoredSessions
const chatContext = scope.context ?? 'default';
const loaded = loadStoredSessions(chatContext);
```

#### 4. Cleanup After Backend Migration
```typescript
// When migrating from localStorage to backend, now clears context-specific keys
localStorage.removeItem(getChatSessionsStorageKey(chatContext));
localStorage.removeItem(getLegacyHistoryStorageKey(chatContext));
```

## How It Works Now

```
┌─────────────────────────────────────────────────────────┐
│ User switches cluster context (Context A → Context B)   │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│ 1. Load from backend API with context query parameter   │
│    GET /api/ai/sessions?context=cluster-b               │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│ 2. If not found, check localStorage with context key:   │
│    localStorage.getItem('k8sExplorer.aiChatSessions:cluster-b') │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│ 3. Each context's data is isolated and preserved        │
│    Context A data stays in: ...aiChatSessions:cluster-a │
│    Context B data stays in: ...aiChatSessions:cluster-b │
└─────────────────────────────────────────────────────────┘
```

## Testing & Validation

### Verification Steps
1. ✅ TypeScript compilation passes
2. ✅ ESLint/code style validation passes
3. ✅ No breaking changes to existing APIs

### Manual Testing Recommended
1. **Switch between contexts**:
   - Open Chat in Context A and send a message
   - Switch to Context B (verify: new chat or Context B's history loads)
   - Switch back to Context A (verify: Context A's history is preserved)

2. **Check localStorage**:
   ```javascript
   // In browser console
   Object.keys(localStorage).filter(k => k.includes('aiChat'))
   // Should show keys like:
   // ['k8sExplorer.aiChatSessions:cluster-a', 'k8sExplorer.aiChatSessions:cluster-b']
   ```

3. **New contexts**:
   - Switch to a previously unused context
   - Verify it starts with a fresh chat session
   - Send a message and verify it's saved independently

## Impact Summary

- **Before**: Chat history shared across all contexts (data loss risk)
- **After**: Each context has its own isolated chat history
- **Backward Compatibility**: Legacy localStorage keys are still migrated to backend
- **Performance**: No performance impact (same localStorage operations, just different keys)
- **Scope**: Frontend only (backend already had context awareness)

## Related Files

- Modified: `platform/frontend/src/components/AiAssistantPanel.tsx`
- API Client: `platform/frontend/src/api/aiAssistantApi.ts` (already context-aware)
- Backend Storage: `platform/backend/src/services/aiChatSessionStore.ts` (already context-aware)
