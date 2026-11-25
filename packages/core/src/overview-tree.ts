import { generateUUID } from './uuid';

/**
 * Overview (总览) task tree shared by Android and desktop.
 *
 * The tree is a local view over the synced task database: category nodes are
 * manually titled grouping nodes (any depth), and leaves reference a task by
 * id. Only leaves are todos; every leaf edit goes through the task store, so it
 * stays in sync with the other list views. The tree layout itself is stored per
 * workspace/platform and restored on restart.
 */

export type OverviewNodeKind = 'category' | 'task';

export interface OverviewTreeNode {
  id: string;
  parentId: string | null;
  kind: OverviewNodeKind;
  /** Category title (manual). Task nodes keep their title in the task store. */
  title: string;
  /** Set only for task leaves. */
  taskId?: string;
  /** Store Area bound to a top-level area node (synced with the area list). */
  areaId?: string;
  /** Sibling ordering, ascending. */
  order: number;
}

export interface OverviewTree {
  version: 2;
  nodes: OverviewTreeNode[];
}

export const OVERVIEW_TREE_VERSION = 2;
export const OVERVIEW_TREE_MAX_NODES = 5000;
export const OVERVIEW_CATEGORY_TITLE_MAX = 200;

export function createOverviewTree(): OverviewTree {
  return { version: OVERVIEW_TREE_VERSION, nodes: [] };
}

function nextOrder(nodes: OverviewTreeNode[], parentId: string | null): number {
  let max = -1;
  for (const node of nodes) {
    if (node.parentId === parentId && node.order > max) max = node.order;
  }
  return max + 1;
}

export function createOverviewCategory(
  title: string,
  parentId: string | null,
  order: number,
): OverviewTreeNode {
  return {
    id: generateUUID(),
    parentId,
    kind: 'category',
    title: title.slice(0, OVERVIEW_CATEGORY_TITLE_MAX),
    order,
  };
}

export function appendOverviewCategory(
  nodes: OverviewTreeNode[],
  title: string,
  parentId: string | null = null,
): { nodes: OverviewTreeNode[]; node: OverviewTreeNode } {
  const node = createOverviewCategory(title, parentId, nextOrder(nodes, parentId));
  return { nodes: [...nodes, node], node };
}

export function prependOverviewCategory(
  nodes: OverviewTreeNode[],
  title: string,
  parentId: string | null = null,
): { nodes: OverviewTreeNode[]; node: OverviewTreeNode } {
  const siblings = nodes.filter((node) => node.parentId === parentId);
  const minOrder = siblings.reduce((min, node) => Math.min(min, node.order), 0);
  const node = createOverviewCategory(title, parentId, minOrder - 1);
  return { nodes: [...nodes, node], node };
}

export function appendOverviewTask(
  nodes: OverviewTreeNode[],
  taskId: string,
  parentId: string | null = null,
  order?: number,
): { nodes: OverviewTreeNode[]; node: OverviewTreeNode } {
  const node: OverviewTreeNode = {
    id: generateUUID(),
    parentId,
    kind: 'task',
    title: '',
    taskId,
    order: order ?? nextOrder(nodes, parentId),
  };
  return { nodes: [...nodes, node], node };
}

export function childrenOf(
  nodes: OverviewTreeNode[],
  parentId: string | null,
): OverviewTreeNode[] {
  return nodes
    .filter((node) => node.parentId === parentId)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function overviewNodeDepth(nodes: OverviewTreeNode[], node: OverviewTreeNode): number {
  let depth = 0;
  let parentId = node.parentId;
  const seen = new Set<string>();
  while (parentId) {
    if (seen.has(parentId)) break;
    seen.add(parentId);
    const parent = nodes.find((candidate) => candidate.id === parentId);
    if (!parent) break;
    depth += 1;
    parentId = parent.parentId;
  }
  return depth;
}

/** Category titles from the root down to (excluding) this node. */
export function overviewCategoryPath(
  nodes: OverviewTreeNode[],
  node: OverviewTreeNode,
): string[] {
  const titles: string[] = [];
  const seen = new Set<string>();
  let parentId = node.parentId;
  while (parentId) {
    if (seen.has(parentId)) break;
    seen.add(parentId);
    const parent = nodes.find((candidate) => candidate.id === parentId);
    if (!parent) break;
    if (parent.kind === 'category' && parent.title.trim()) {
      titles.unshift(parent.title.trim());
    }
    parentId = parent.parentId;
  }
  return titles;
}

/**
 * Level-one category is treated as the area, and the whole category path is the
 * project label shown in front of the leaf's task title.
 */
export function overviewLeafLabels(
  nodes: OverviewTreeNode[],
  node: OverviewTreeNode,
): { area: string | null; projectLabel: string; path: string[] } {
  const path = overviewCategoryPath(nodes, node);
  return {
    area: path[0] ?? null,
    projectLabel: path.join(' / '),
    path,
  };
}

export function findOverviewNodeByTaskId(
  nodes: OverviewTreeNode[],
  taskId: string,
): OverviewTreeNode | undefined {
  return nodes.find((node) => node.kind === 'task' && node.taskId === taskId);
}

function collectDescendantIds(nodes: OverviewTreeNode[], id: string): Set<string> {
  const result = new Set<string>([id]);
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const node of nodes) {
      if (node.parentId === current && !result.has(node.id)) {
        result.add(node.id);
        queue.push(node.id);
      }
    }
  }
  return result;
}

export function removeOverviewNode(
  nodes: OverviewTreeNode[],
  id: string,
): OverviewTreeNode[] {
  const removed = collectDescendantIds(nodes, id);
  return nodes.filter((node) => !removed.has(node.id));
}

/** Move a node under another parent without creating a cycle. */
export function moveOverviewNode(
  nodes: OverviewTreeNode[],
  id: string,
  parentId: string | null,
  order?: number,
): OverviewTreeNode[] {
  const node = nodes.find((candidate) => candidate.id === id);
  if (!node) return nodes;
  if (parentId) {
    const target = nodes.find((candidate) => candidate.id === parentId);
    if (!target || target.kind !== 'category') return nodes;
    if (collectDescendantIds(nodes, id).has(parentId)) return nodes;
  }
  const withParent = nodes.map((candidate) => (
    candidate.id === id ? { ...candidate, parentId } : candidate
  ));
  const moved = withParent.find((candidate) => candidate.id === id) as OverviewTreeNode;
  const siblings = childrenOf(withParent, parentId).filter((candidate) => candidate.id !== id);
  const index = order === undefined
    ? siblings.length
    : Math.max(0, Math.min(siblings.length, Math.trunc(order)));
  const reordered = [...siblings.slice(0, index), moved, ...siblings.slice(index)];
  const orderById = new Map(reordered.map((candidate, position) => [candidate.id, position]));
  return withParent.map((candidate) => (
    orderById.has(candidate.id) ? { ...candidate, order: orderById.get(candidate.id) as number } : candidate
  ));
}

export function renameOverviewCategory(
  nodes: OverviewTreeNode[],
  id: string,
  title: string,
): OverviewTreeNode[] {
  return nodes.map((node) => (
    node.id === id && node.kind === 'category'
      ? { ...node, title: title.slice(0, OVERVIEW_CATEGORY_TITLE_MAX) }
      : node
  ));
}

/** Find or create a category chain; returns the deepest parent id. */
export function ensureOverviewCategoryPath(
  nodes: OverviewTreeNode[],
  titles: string[],
  create: (title: string, parentId: string | null, order: number) => OverviewTreeNode = createOverviewCategory,
): { nodes: OverviewTreeNode[]; parentId: string | null } {
  let nextNodes = nodes;
  let parentId: string | null = null;
  for (const rawTitle of titles) {
    const title = rawTitle.trim();
    if (!title) continue;
    const existing = nextNodes
      .filter((node) => node.kind === 'category' && node.parentId === parentId && node.title === title)
      .sort((a, b) => a.order - b.order)[0];
    if (existing) {
      parentId = existing.id;
      continue;
    }
    const node = create(title, parentId, nextOrder(nextNodes, parentId));
    nextNodes = [...nextNodes, node];
    parentId = node.id;
  }
  return { nodes: nextNodes, parentId };
}

export interface OverviewReconcileTask {
  id: string;
  /** Area title for the first-level category, when the task has one. */
  areaTitle?: string | null;
  /** Project title for the second level, when the task has one. */
  projectTitle?: string | null;
}

/**
 * Reconcile the stored tree with the current task database:
 * - drop task leaves whose task no longer exists;
 * - de-duplicate leaves that reference the same task;
 * - append tasks that are not in the tree yet beneath their area/project (or
 *   the inbox category).
 */
export function reconcileOverviewTree(
  nodes: OverviewTreeNode[],
  tasks: OverviewReconcileTask[],
  options: { inboxTitle: string },
): { nodes: OverviewTreeNode[]; added: number } {
  const taskIds = new Set(tasks.map((task) => task.id));
  const seenTaskIds = new Set<string>();
  let nextNodes = nodes.filter((node) => {
    if (node.kind !== 'task') return true;
    if (!node.taskId || !taskIds.has(node.taskId) || seenTaskIds.has(node.taskId)) return false;
    seenTaskIds.add(node.taskId);
    return true;
  });

  let added = 0;
  for (const task of tasks) {
    if (seenTaskIds.has(task.id)) continue;
    const titles: string[] = [];
    if (task.areaTitle?.trim()) titles.push(task.areaTitle.trim());
    if (task.projectTitle?.trim()) titles.push(task.projectTitle.trim());
    if (titles.length === 0) titles.push(options.inboxTitle);
    const ensured = ensureOverviewCategoryPath(nextNodes, titles);
    nextNodes = ensured.nodes;
    const appended = appendOverviewTask(nextNodes, task.id, ensured.parentId);
    nextNodes = appended.nodes;
    seenTaskIds.add(task.id);
    added += 1;
  }

  return { nodes: nextNodes, added };
}

export function normalizeOverviewTree(raw: unknown): OverviewTree | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, unknown>;
  const rawNodes = candidate.nodes;
  if (!Array.isArray(rawNodes)) return null;
  const ids = new Set<string>();
  const nodes: OverviewTreeNode[] = [];
  for (const item of rawNodes.slice(0, OVERVIEW_TREE_MAX_NODES)) {
    if (!item || typeof item !== 'object') continue;
    const value = item as Record<string, unknown>;
    const id = typeof value.id === 'string' && value.id ? value.id : generateUUID();
    if (ids.has(id)) continue;
    const kind: OverviewNodeKind = value.kind === 'task' ? 'task' : 'category';
    const parentId = typeof value.parentId === 'string' && value.parentId ? value.parentId : null;
    const taskId = typeof value.taskId === 'string' && value.taskId ? value.taskId : undefined;
    if (kind === 'task' && !taskId) continue;
    const areaId = typeof value.areaId === 'string' && value.areaId ? value.areaId : undefined;
    const title = typeof value.title === 'string'
      ? value.title.slice(0, OVERVIEW_CATEGORY_TITLE_MAX)
      : '';
    const order = typeof value.order === 'number' && Number.isFinite(value.order)
      ? Math.trunc(value.order)
      : 0;
    ids.add(id);
    nodes.push({
      id, parentId, kind, title, order,
      ...(kind === 'task' ? { taskId } : {}),
      ...(areaId && kind === 'category' ? { areaId } : {}),
    });
  }
  // Drop nodes whose parent is missing or is not a category.
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const valid = nodes.filter((node) => {
    if (!node.parentId) return true;
    const parent = byId.get(node.parentId);
    return Boolean(parent && parent.kind === 'category' && parent.id !== node.id);
  });
  return { version: OVERVIEW_TREE_VERSION, nodes: valid };
}

export function parseOverviewTree(raw: string | null): OverviewTree | null {
  if (!raw) return null;
  try {
    return normalizeOverviewTree(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function serializeOverviewTree(tree: OverviewTree): string {
  return JSON.stringify({ version: OVERVIEW_TREE_VERSION, nodes: tree.nodes });
}

/** Pick a top-level area title that does not collide with an existing area or root node. */
export function uniqueOverviewAreaTitle(baseTitle: string, occupied: Iterable<string>): string {
  const base = baseTitle.trim() || 'Area';
  const taken = new Set(
    Array.from(occupied, (value) => value.trim().toLowerCase()).filter(Boolean),
  );
  if (!taken.has(base.toLowerCase())) return base;
  let index = 2;
  while (taken.has(`${base} ${index}`.toLowerCase())) index += 1;
  return `${base} ${index}`;
}

export function countOverviewTasks(nodes: OverviewTreeNode[]): number {
  return nodes.reduce((total, node) => total + (node.kind === 'task' ? 1 : 0), 0);
}
