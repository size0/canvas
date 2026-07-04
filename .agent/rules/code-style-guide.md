---
trigger: always_on
---

# TwitCanva Code Style Guide

## Core Principles

1. **Modularity**: Break large files into smaller, focused modules
2. **Clarity**: Use clear naming and comprehensive comments
3. **Maintainability**: Organize code for easy iteration and debugging
4. **Consistency**: Follow established patterns throughout the codebase

---

## File Organization

### Maximum File Size

- **Components**: 300 lines max
- **Utilities/Services**: 200 lines max
- **Main App**: 500 lines max

**When to split**: File exceeds limits, handles multiple responsibilities, or becomes hard to navigate.

### Directory Structure

Organize by **feature** and **type**:

**By Type** (current - good for small projects):
- `components/` - UI components
- `hooks/` - Custom React hooks  
- `services/` - API integrations
- `utils/` - Pure utility functions
- `types/` - TypeScript definitions

**By Feature** (better as project grows):
- `features/canvas/` - All canvas code (components, hooks, utils)
- `features/nodes/` - All node code
- `shared/` - Shared utilities

**Guidelines**: Group related files, max 3 levels deep, use index files for clean imports.

---

## Code Annotation

### File Headers

```typescript
/**
 * CanvasNode.tsx
 * 
 * Renders canvas nodes with drag, resize, and generation capabilities.
 * Handles pointer events, context menus, and connector actions.
 */
```

### Section Comments

```typescript
// ============================================================================
// STATE MANAGEMENT
// ============================================================================

const [nodes, setNodes] = useState<NodeData[]>([]);

// ============================================================================
// EVENT HANDLERS
// ============================================================================

const handleClick = () => { /* ... */ };
```

### Function Documentation

```typescript
/**
 * Extracts the last frame from a video as base64 image
 * 
 * @param videoUrl - Video URL to extract from
 * @returns Promise<string> - Base64 PNG image
 */
const extractVideoLastFrame = (videoUrl: string): Promise<string> => {
  // Implementation
};
```

### Inline Comments

Use for non-obvious logic, workarounds, and edge cases:

```typescript
// Convert screen coords to canvas space accounting for zoom/pan
const canvasX = (mouseX - viewport.x) / viewport.zoom;

// WORKAROUND: Some browsers don't seek until data loaded
if (video.duration) video.currentTime = video.duration;
```

---

## Component Structure

```typescript
/**
 * ComponentName.tsx
 * Brief description
 */

import React, { useState, useEffect } from 'react';

// ============================================================================
// TYPES
// ============================================================================

interface ComponentProps {
  data: SomeType;
  onAction: (id: string) => void;
}

// ============================================================================
// COMPONENT
// ============================================================================

export const ComponentName: React.FC<ComponentProps> = ({ data, onAction }) => {
  
  // --- State ---
  const [isActive, setIsActive] = useState(false);
  
  // --- Effects ---
  useEffect(() => {
    // Effect logic
  }, []);
  
  // --- Event Handlers ---
  const handleClick = () => {
    // Handler logic
  };
  
  // --- Render ---
  return (
    <div className="wrapper">
      {/* Content */}
    </div>
  );
};
```

---

## Naming Conventions

### Files
- **Components**: PascalCase (`CanvasNode.tsx`)
- **Utilities**: camelCase (`formatDate.ts`)
- **Hooks**: camelCase with `use` (`useViewport.ts`)
- **Types**: PascalCase (`NodeData.ts`)

### Variables & Functions

```typescript
// Booleans: is/has/should prefix
const isLoading = true;
const hasError = false;

// Event handlers: handle prefix
const handleClick = () => {};
const handleSubmit = () => {};

// Render functions: render prefix
const renderHeader = () => {};
```

---

## TypeScript

### Type Definitions

```typescript
// types/node.ts
export interface NodeData {
  id: string;
  type: NodeType;
  x: number;
  y: number;
}

export enum NodeType {
  TEXT = 'text',
  IMAGE = 'image',
  VIDEO = 'video'
}

export type NodeStatus = 'idle' | 'loading' | 'success' | 'error';
```

### Avoid `any`

```typescript
// ❌ Bad
const handleData = (data: any) => { };

// ✅ Good
interface ApiResponse {
  data: NodeData[];
  status: number;
}
const handleData = (response: ApiResponse) => { };
```

---

## React Patterns

### Custom Hooks - MANDATORY Separation

**CRITICAL RULE**: When adding new hook logic to `App.tsx`, **ALWAYS create a separate hook file** under `src/hooks/`. Never add complex hook logic directly in App.tsx.

**Why**: Keeps App.tsx maintainable, enables easier testing, and improves code navigation.

**How to apply**:
1. Create new file: `src/hooks/useFeatureName.ts`
2. Move all related state, effects, and handlers into the hook
3. Return only what App.tsx needs to consume
4. Import and destructure in App.tsx

```typescript
// ❌ Bad: Adding hook logic directly in App.tsx
function App() {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(false);
  
  useEffect(() => {
    // 50+ lines of complex logic
  }, []);
  
  const handleAction = () => { /* complex logic */ };
  // ... App.tsx grows to 800+ lines
}

// ✅ Good: Extract to src/hooks/useDataManagement.ts
// --- src/hooks/useDataManagement.ts ---
import { useState, useEffect } from 'react';

export const useDataManagement = () => {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(false);
  
  useEffect(() => { /* logic */ }, []);
  const handleAction = () => { /* logic */ };
  
  return { data, loading, handleAction };
};

// --- App.tsx ---
import { useDataManagement } from './hooks/useDataManagement';

function App() {
  const { data, loading, handleAction } = useDataManagement();
  // App.tsx stays lean
}
```

### Component Composition

```typescript
// ❌ Bad: One large component
const Dashboard = () => {
  // 500+ lines
};

// ✅ Good: Composed
const Dashboard = () => (
  <>
    <DashboardHeader />
    <DashboardContent />
    <DashboardFooter />
  </>
);
```

---

## State Management

```typescript
// Group related state
const [nodes, setNodes] = useState<NodeData[]>([]);
const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

// Use objects for complex state
const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 });

// Use refs for non-render values
const dragNodeRef = useRef<{ id: string } | null>(null);

// Functional updates when depending on previous state
setNodes(prev => prev.map(n => 
  n.id === nodeId ? { ...n, status: 'loading' } : n
));
```

---

## Error Handling

```typescript
const handleGenerate = async (id: string) => {
  const node = nodes.find(n => n.id === id);
  if (!node?.prompt) return;
  
  handleUpdateNode(id, { status: 'loading' });
  
  try {
    const result = await generateImage({
      prompt: node.prompt,
      aspectRatio: node.aspectRatio
    });
    handleUpdateNode(id, { status: 'success', resultUrl: result });
  } catch (error: any) {
    const msg = error.toString().toLowerCase();
    if (msg.includes('permission_denied')) {
      handleUpdateNode(id, { status: 'error', errorMessage: 'Permission denied.' });
    } else {
      handleUpdateNode(id, { status: 'error', errorMessage: error.message });
    }
    console.error('Generation failed:', error);
  }
};
```

---

## Performance

### Memoization

```typescript
// Memoize expensive calculations
const expensiveValue = useMemo(() => {
  return nodes.reduce((acc, node) => acc, initialValue);
}, [nodes]);

// Memoize callbacks
const handleUpdate = useCallback((id: string, updates: Partial<NodeData>) => {
  setNodes(prev => prev.map(n => n.id === id ? { ...n, ...updates } : n));
}, []);
```

### Avoid Inline Functions

```typescript
// ❌ Bad: New function every render
<button onClick={() => handleClick(id)}>Click</button>

// ✅ Good: Memoized
const handleButtonClick = useCallback(() => handleClick(id), [id]);
<button onClick={handleButtonClick}>Click</button>
```

---

## Styling

### Tailwind Class Order

Layout → Spacing → Sizing → Typography → Colors → Effects

```typescript
<div className="
  flex items-center justify-between
  p-4 gap-3
  w-full h-12
  text-sm font-medium
  bg-neutral-900 text-white border border-neutral-700
  rounded-lg shadow-lg
  hover:bg-neutral-800 transition-colors
">
```

---

## Git Commits

### Format

```
<type>(<scope>): <subject>

<body>
```

### Types

- `feat`: New feature
- `fix`: Bug fix
- `refactor`: Code refactoring
- `docs`: Documentation
- `style`: Formatting
- `chore`: Maintenance

---

## Code Review Checklist

Before submitting:

- [ ] Functions have appropriate comments
- [ ] Complex logic explained with inline comments
- [ ] No file exceeds line limits
- [ ] **New hooks are in separate files under `src/hooks/`**
- [ ] TypeScript types properly defined (no `any`)
- [ ] Error handling implemented
- [ ] Console logs removed
- [ ] Naming conventions followed

---

## Key Takeaways

1. **Keep files small** - Split when exceeding line limits
2. **Always extract hooks** - New hook logic goes to `src/hooks/`, never inline in App.tsx
3. **Comment generously** - Explain the "why", not just the "what"
4. **Type everything** - Avoid `any`, use proper TypeScript
5. **Handle errors** - Always catch and provide meaningful messages
6. **Optimize wisely** - Use memoization for expensive operations
7. **Stay consistent** - Follow established patterns

**Remember**: This is a living document. Update as the project evolves.
