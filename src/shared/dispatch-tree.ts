// The dispatch tree, as a shape to ask questions of — separated from the state
// machine it reads (Task 01 split, 2026-09-26).
//
// This is the store's ONE walk of the parent/child shape, and it is a READ: it
// mutates nothing, holds no lifecycle rule, and its only invariant is that it
// terminates. Two different questions are asked of the same shape — what should
// the fleet view show (`tools/read.ts`), and what should a subtree stop reach
// (`tools/interrupt.ts`) — and the reason they live together is that they must
// not be able to disagree about what a descendant is.
//
// It was moved out of `task-state.ts` because that file is the choke point for
// lifecycle MUTATION, and a read-only recursive walk is a second hazard wearing
// the same trench coat. The split was forced by a gate, not preferred for
// tidiness: the 1000-line rule left 32 lines of headroom, and the next field
// added to a task record breached the build.

//jscpd:ignore-start
import type { SessionId } from "./ids.js";
import type { TaskRecord, TaskStore } from "./task-state.js";

//jscpd:ignore-end
// One task in the dispatch tree, with the place it holds in it.
export interface DispatchNode {
  task: TaskRecord;
  depth: number;
  // Whether the parent that spawned this task is itself tracked here. False
  // means the link is severed — pruned history, a record lost across a restart
  // — and a view that presents such a task flush would read it as a ROOT,
  // which is a task whose parent nobody has stopped above.
  parentTracked: boolean;
  children: DispatchNode[];
}

// The store's dispatch tree, as a forest of nested DispatchNodes. This is the
// ONE walk: the subtree stop and the fleet read are two different questions
// about the same shape, so they cannot each grow their own idea of it.
//
// Edges are `parentSessionId`, NOT `lineage` — lineage holds agent NAMES (the
// delegation policy's input), so it cannot answer "is this task below that
// one". Both maps are walked, so a finished task still holds its place as the
// parent of something running. The `path` guard makes the walk terminate on a
// cycle that admission cannot produce but a hand-edited record file could.
export function dispatchForest(store: TaskStore): DispatchNode[] {
  const records = new Map<string, TaskRecord>();
  for (const [id, task] of store.retainedTasks) records.set(id, task);
  for (const [id, task] of store.activeTasks) records.set(id, task);

  const childrenOf = new Map<string, string[]>();
  for (const [id, task] of records) {
    const siblings = childrenOf.get(task.parentSessionId);
    if (siblings) siblings.push(id);
    else childrenOf.set(task.parentSessionId, [id]);
  }

  const placed = new Set<string>();
  const grow = (task: TaskRecord, depth: number, parentTracked: boolean, path: ReadonlySet<string>): DispatchNode => {
    const node: DispatchNode = { children: [], depth, parentTracked, task };
    placed.add(task.childSessionId);
    const next = new Set(path).add(task.childSessionId);
    for (const childId of childrenOf.get(task.childSessionId) ?? []) {
      const child = records.get(childId);
      if (child === undefined || next.has(childId)) continue;
      node.children.push(grow(child, depth + 1, true, next));
    }
    return node;
  };

  const forest: DispatchNode[] = [];
  // One root-finding pass, stated once: the two passes differ only in what they
  // call a root. The first is the honest one — a task whose parent is tracked
  // belongs under it. The second exists because a record set whose parent links
  // form a cycle has no root to be reached from, and an unreached record would
  // go missing from the view; it becomes a root of its own rather than vanish.
  const pushRoots = (isRoot: (task: TaskRecord) => boolean): void => {
    for (const task of records.values()) {
      if (isRoot(task)) forest.push(grow(task, 0, false, new Set()));
    }
  };
  pushRoots((task) => !records.has(task.parentSessionId));
  pushRoots((task) => !placed.has(task.childSessionId));
  return forest;
}

function findDispatchNode(nodes: DispatchNode[], sessionId: string): DispatchNode | undefined {
  for (const node of nodes) {
    if (node.task.childSessionId === sessionId) return node;
    const found = findDispatchNode(node.children, sessionId);
    if (found !== undefined) return found;
  }
  return undefined;
}

const descendDispatch = (node: DispatchNode): SessionId[] => [
  node.task.childSessionId,
  ...node.children.flatMap(descendDispatch),
];

// The task tree under `rootSessionId`, root first, through SETTLED records: a
// finished child is not a wall, and the grandchild it left running is exactly
// what a subtree stop has to reach. A root the store does not track has no
// knowable descendants — the store only ever learns a parent link from a
// record — so the answer is that session alone, which the caller's report
// already names as untracked.
export function subtreeTaskIds(store: TaskStore, rootSessionId: SessionId): SessionId[] {
  const node = findDispatchNode(dispatchForest(store), rootSessionId);
  return node === undefined ? [rootSessionId] : descendDispatch(node);
}
