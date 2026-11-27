import { describe, expect, it } from 'vitest';

import {
  OVERVIEW_TREE_VERSION,
  appendOverviewCategory,
  appendOverviewTask,
  childrenOf,
  ensureOverviewCategoryPath,
  insertOverviewCategoryAfter,
  findOverviewNodeByTaskId,
  moveOverviewNode,
  moveOverviewNodeSibling,
  normalizeOverviewTree,
  overviewCategoryPath,
  overviewLeafLabels,
  parseOverviewTree,
  prependOverviewCategory,
  reconcileOverviewTree,
  removeOverviewNode,
  renameOverviewCategory,
  serializeOverviewTree,
  type OverviewTreeNode,
  uniqueOverviewAreaTitle,
} from './overview-tree';

const cat = (nodes: OverviewTreeNode[], title: string, parentId: string | null = null) => (
  appendOverviewCategory(nodes, title, parentId)
);

describe('overview tree', () => {
  it('builds arbitrary-depth category paths and leaf labels', () => {
    let nodes: OverviewTreeNode[] = [];
    let work = cat(nodes, '工作');
    nodes = work.nodes;
    let q4 = cat(nodes, 'Q4', work.node.id);
    nodes = q4.nodes;
    let site = cat(nodes, '官网', q4.node.id);
    nodes = site.nodes;
    const leaf = appendOverviewTask(nodes, 'task-1', site.node.id);
    nodes = leaf.nodes;

    expect(overviewCategoryPath(nodes, leaf.node)).toEqual(['工作', 'Q4', '官网']);
    expect(overviewLeafLabels(nodes, leaf.node)).toEqual({
      area: '工作',
      projectLabel: '工作 / Q4 / 官网',
      path: ['工作', 'Q4', '官网'],
    });
    expect(findOverviewNodeByTaskId(nodes, 'task-1')?.id).toBe(leaf.node.id);
  });

  it('orders children and keeps parent constraints on move', () => {
    let nodes: OverviewTreeNode[] = [];
    const root = cat(nodes, 'Root');
    nodes = root.nodes;
    const a = cat(nodes, 'A', root.node.id);
    nodes = a.nodes;
    const b = cat(nodes, 'B', root.node.id);
    nodes = b.nodes;
    expect(childrenOf(nodes, root.node.id).map((node) => node.title)).toEqual(['A', 'B']);

    const moved = moveOverviewNode(nodes, root.node.id, a.node.id);
    expect(moved).toBe(nodes);

    const reordered = moveOverviewNode(nodes, b.node.id, root.node.id, 0);
    expect(childrenOf(reordered, root.node.id).map((node) => node.title)).toEqual(['B', 'A']);
  });

  it('moves a node one slot among its siblings', () => {
    let nodes: OverviewTreeNode[] = [];
    const a = appendOverviewCategory(nodes, 'A');
    nodes = a.nodes;
    const b = appendOverviewCategory(nodes, 'B');
    nodes = b.nodes;
    const c = appendOverviewCategory(nodes, 'C');
    nodes = c.nodes;

    nodes = moveOverviewNodeSibling(nodes, b.node.id, 1);
    expect(childrenOf(nodes, null).map((node) => node.title)).toEqual(['A', 'C', 'B']);
    nodes = moveOverviewNodeSibling(nodes, a.node.id, 1);
    expect(childrenOf(nodes, null).map((node) => node.title)).toEqual(['C', 'A', 'B']);
    expect(moveOverviewNodeSibling(nodes, b.node.id, 1)).toBe(nodes);
    expect(moveOverviewNodeSibling(nodes, c.node.id, -1)).toBe(nodes);
  });

  it('prepends a root category at the top', () => {
    let nodes: OverviewTreeNode[] = [];
    nodes = appendOverviewCategory(nodes, 'First').nodes;
    nodes = appendOverviewCategory(nodes, 'Second').nodes;
    const prepended = prependOverviewCategory(nodes, 'Top');
    expect(childrenOf(prepended.nodes, null).map((node) => node.title)).toEqual(['Top', 'First', 'Second']);
  });

  it('inserts a sibling category directly after the reference node', () => {
    let nodes: OverviewTreeNode[] = [];
    const first = appendOverviewCategory(nodes, 'First');
    nodes = first.nodes;
    const second = appendOverviewCategory(nodes, 'Second');
    nodes = second.nodes;
    const child = appendOverviewCategory(nodes, 'Child', second.node.id);
    nodes = child.nodes;

    const rootSibling = insertOverviewCategoryAfter(nodes, first.node.id, 'Middle');
    expect(rootSibling).not.toBeNull();
    nodes = rootSibling!.nodes;
    expect(childrenOf(nodes, null).map((node) => node.title)).toEqual(['First', 'Middle', 'Second']);

    const childSibling = insertOverviewCategoryAfter(nodes, child.node.id, 'Child 2');
    expect(childSibling).not.toBeNull();
    nodes = childSibling!.nodes;
    expect(childrenOf(nodes, second.node.id).map((node) => node.title)).toEqual(['Child', 'Child 2']);

    expect(insertOverviewCategoryAfter(nodes, 'missing', 'Nope')).toBeNull();
  });

  it('removes a category with all descendants', () => {
    let nodes: OverviewTreeNode[] = [];
    const root = cat(nodes, 'Root');
    nodes = root.nodes;
    const child = cat(nodes, 'Child', root.node.id);
    nodes = child.nodes;
    nodes = appendOverviewTask(nodes, 't1', child.node.id).nodes;
    const pruned = removeOverviewNode(nodes, root.node.id);
    expect(pruned).toEqual([]);
  });

  it('finds or creates category chains without duplicating titles', () => {
    let nodes: OverviewTreeNode[] = [];
    const first = ensureOverviewCategoryPath(nodes, ['工作', '项目A']);
    nodes = first.nodes;
    expect(nodes).toHaveLength(2);
    const second = ensureOverviewCategoryPath(nodes, ['工作', '项目A']);
    expect(second.nodes).toHaveLength(2);
    expect(second.parentId).toBe(first.parentId);
    const third = ensureOverviewCategoryPath(second.nodes, ['工作', '项目B']);
    expect(third.nodes).toHaveLength(3);
  });

  it('does not add a project level that repeats the area name', () => {
    const result = reconcileOverviewTree([], [
      { id: 't1', areaTitle: '工作', projectTitle: '工作' },
    ], { inboxTitle: '收集箱' });
    const categories = result.nodes.filter((node) => node.kind === 'category');
    expect(categories.map((node) => node.title)).toEqual(['工作']);
    expect(findOverviewNodeByTaskId(result.nodes, 't1')).toBeTruthy();
  });

  it('reconciles stored leaves with the live task list', () => {
    let nodes: OverviewTreeNode[] = [];
    const work = cat(nodes, '工作');
    nodes = work.nodes;
    nodes = appendOverviewTask(nodes, 'old-task', work.node.id).nodes;

    const result = reconcileOverviewTree(nodes, [
      { id: 'old-task', areaTitle: '工作', projectTitle: '项目A' },
      { id: 'new-project-task', areaTitle: '工作', projectTitle: '项目A' },
      { id: 'new-area-task', areaTitle: '生活' },
      { id: 'inbox-task' },
      { id: 'orphan-task' },
    ], { inboxTitle: '收集箱' });

    expect(findOverviewNodeByTaskId(result.nodes, 'old-task')).toBeTruthy();
    expect(findOverviewNodeByTaskId(result.nodes, 'new-project-task')).toBeTruthy();
    expect(findOverviewNodeByTaskId(result.nodes, 'inbox-task')).toBeTruthy();
    expect(result.added).toBe(4);
    const inbox = result.nodes.find((node) => node.kind === 'category' && node.title === '收集箱');
    expect(inbox).toBeTruthy();
  });

  it('drops leaves for deleted tasks and duplicate leaves', () => {
    let nodes: OverviewTreeNode[] = [];
    nodes = appendOverviewTask(nodes, 'deleted').nodes;
    nodes = appendOverviewTask(nodes, 'kept').nodes;
    const duplicate = appendOverviewTask(nodes, 'kept');
    nodes = duplicate.nodes;

    const result = reconcileOverviewTree(nodes, [{ id: 'kept' }], { inboxTitle: 'Inbox' });
    expect(result.nodes.filter((node) => node.kind === 'task')).toHaveLength(1);
    expect(findOverviewNodeByTaskId(result.nodes, 'deleted')).toBeUndefined();
  });

  it('round-trips through storage and rejects malformed trees', () => {
    let nodes: OverviewTreeNode[] = [];
    nodes = cat(nodes, '工作').nodes;
    nodes = appendOverviewTask(nodes, 't1').nodes;
    const tree = { version: OVERVIEW_TREE_VERSION as 2, nodes };
    const parsed = parseOverviewTree(serializeOverviewTree(tree));
    expect(parsed?.nodes.map((node) => node.kind)).toEqual(['category', 'task']);

    const areaBound = parseOverviewTree(serializeOverviewTree({
      version: OVERVIEW_TREE_VERSION,
      nodes: [{ id: 'a', parentId: null, kind: 'category', title: 'Work', order: 0, areaId: 'area-1' }],
    }));
    expect(areaBound?.nodes[0].areaId).toBe('area-1');

    expect(parseOverviewTree('{')).toBeNull();
    expect(normalizeOverviewTree({ nodes: 'nope' })).toBeNull();
    expect(normalizeOverviewTree({ nodes: [{ kind: 'task', id: 'x' }] })).toEqual({ version: 2, nodes: [] });
    expect(normalizeOverviewTree({ nodes: [{ kind: 'category', id: 'c', title: 'C', parentId: 'missing' }] })?.nodes).toEqual([]);
  });

  it('renames categories without touching task leaves', () => {
    let nodes: OverviewTreeNode[] = [];
    const root = cat(nodes, 'Old');
    nodes = root.nodes;
    nodes = appendOverviewTask(nodes, 't1', root.node.id).nodes;
    const renamed = renameOverviewCategory(nodes, root.node.id, 'New');
    expect(renamed[0].title).toBe('New');
    expect(renamed[1].taskId).toBe('t1');
  });

  it('picks a non-conflicting area name', () => {
    expect(uniqueOverviewAreaTitle('New area', [])).toBe('New area');
    expect(uniqueOverviewAreaTitle('New area', ['New area'])).toBe('New area 2');
    expect(uniqueOverviewAreaTitle('New area', ['New area', 'new area 2'])).toBe('New area 3');
    expect(uniqueOverviewAreaTitle('  领域  ', ['领域'])).toBe('领域 2');
  });
});
