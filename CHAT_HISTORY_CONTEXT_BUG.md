# Chat History Lost When Switching Cluster Contexts - Bug Fix

## Problem Description

When switching between cluster contexts in FocusKube's AI Assistant:
- **Expected**: Chat history for each context is preserved and restored when switching back
- **Actual**: Chat history is lost, appearing as a "new chat" when switching contexts

## Root Cause

The issue occurred because `scope.context` could be `undefined` at certain initialization points:

```typescript
// BEFORE FIX - Problematic code
const chatContext = scope.context;  // Could be undefined!

// When chatContext is undefined:
const res = await fetch(`/api/ai/sessions${contextQuery(chatContext)}`);
// Becomes: GET /api/ai/sessions (NO QUERY PARAMETER)

// Backend then falls back to wrong value:
function chatContext(req: Request): string {
  const requested = req.query.context;
  // requested is undefined, so falls back to:
  return (req as any).userSession?.activeContext || 'default';
}
```

### The Problem Flow

1. User opens AI Assistant, context might be `undefined`
2. Frontend calls API without context parameter: `GET /api/ai/sessions`
3. Backend can't find `?context=` query param, falls back to `userSession?.activeContext`
4. User switches to "cluster-a", chat saved under "cluster-a"
5. User switches to "cluster-b", API called with `?context=cluster-b`
6. Backend retrieves sessions for "cluster-b" (empty, because they were saved under "cluster-a")
7. User sees "new chat" instead of "cluster-a" history

### Why Backend-Only Context Filtering Wasn't Enough

Even though the backend properly filters by `userId + context`, it depends on:
- Receiving explicit context from the frontend
- Or having correct fallback values in `userSession?.activeContext`

If the frontend sometimes sent requests with no context parameter, the backend's fallback mechanism couldn't reliably recover the original context.

## Solution

Ensure the frontend **always** provides a valid context value to both:
1. **REST API calls** - for session retrieval/storage
2. **WebSocket connection** - for the AI chat stream

### Changes Made

File: `platform/frontend/src/components/AiAssistantPanel.tsx`

**Line 1196 - Initialize with fallback:**
```typescript
// AFTER FIX - Always provide a context value
const chatContext = scope.context ?? 'default';
```

**Line 1393 - Use consistent value for WebSocket:**
```typescript
// BEFORE
const ws = openAiChatSocket(scope.context);

// AFTER - Use the same guaranteed-valid chatContext
const ws = openAiChatSocket(chatContext);
```

## How It Works Now

### Frontend Behavior
```typescript
const chatContext = scope.context ?? 'default';

// REST API calls ALWAYS include context:
GET /api/ai/sessions?context=cluster-a  // Guaranteed to have value
GET /api/ai/sessions?context=default    // Falls back to 'default'

// WebSocket ALWAYS includes context:
ws://localhost:5173/ws/ai?context=cluster-a
```

### Backend Behavior
```typescript
function chatContext(req: Request): string {
  const requested = req.query.context;
  // Now guaranteed to have a value (frontend always sends it)
  return typeof requested === 'string' && requested ? requested : 'default';
}
```

## Session Isolation Guarantee

Each cluster context now has completely isolated chat history:

| Context | Sessions | API Request | Backend Filter |
|---------|----------|-------------|-----------------|
| cluster-a | [Session1, Session2] | `?context=cluster-a` | `userId + 'cluster-a'` |
| cluster-b | [Session3] | `?context=cluster-b` | `userId + 'cluster-b'` |
| default | [Session4] | `?context=default` | `userId + 'default'` |

Switching between contexts retrieves the correct isolated session set.

## Testing

### Manual Test Steps

1. **In Cluster A**:
   - Open AI Assistant
   - Send message: "Tell me about cluster A"
   - Verify it shows

2. **Switch to Cluster B**:
   - Navigate to Cluster B in the main UI
   - Open AI Assistant
   - Expected: New chat (Cluster B hasn't been used yet)
   - Send message: "Tell me about cluster B"

3. **Switch Back to Cluster A**:
   - Navigate back to Cluster A
   - Open AI Assistant
   - **Expected Result**: Previous message "Tell me about cluster A" is still visible ✅
   - Cluster B's message is NOT visible ✅

### Browser Developer Tools Check
```javascript
// In browser console, check API calls:
// When switching contexts, you should see:
// GET /api/ai/sessions?context=cluster-a
// GET /api/ai/sessions?context=cluster-b
// (with proper context parameter EVERY time)
```

## Files Modified

- `platform/frontend/src/components/AiAssistantPanel.tsx`
  - Line 1196: Added fallback to `'default'` for `chatContext`
  - Line 1393: Changed `scope.context` to `chatContext` for WebSocket

## Verification

- ✅ TypeScript compilation passes
- ✅ ESLint code style validation passes
- ✅ No breaking changes
- ✅ Backward compatible with existing sessions

## Architecture Notes

### Frontend Layer
- REST API: `aiAssistantApi.getChatSessions(context?: string)` → includes `?context=` parameter
- WebSocket: `openAiChatSocket(context?: string)` → includes context in URL
- Component: Always provides valid context value (defaulting to 'default')

### Backend Layer
- REST handlers: Filter by `chatContext(req)` which reads `?context=` parameter
- WebSocket handler: Reads `aiChatParams(req).context` from URL query params
- Storage: All sessions keyed by `userId + context` for isolation

### Storage Layer
- `aiChatSessionStore.list(userId, context)` - Returns only sessions for specific context
- `aiChatSessionStore.get(userId, id, context)` - Gets session scoped to context
- `aiChatSessionStore.saveTranscript(userId, context, id, ...)` - Saves to context-specific set

## Future Improvements

1. **Add defensive logging** - Log when context falls back to 'default' for debugging
2. **UI indicator** - Show user which context's chat they're viewing
3. **Context validation** - Verify context value matches active cluster context at runtime
4. **Migration helper** - Provide script to migrate sessions that were accidentally saved under wrong context

## Summary

The fix ensures **complete separation of chat history per cluster context** by:
1. Always providing an explicit context value from the frontend
2. Backend consistently filtering by the provided context
3. No ambiguity or fallback scenarios that could mix contexts

This eliminates the "lost history" issue while maintaining backward compatibility.
