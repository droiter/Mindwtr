import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, CornerDownRight, Folder, FolderPlus, Minus, Pencil, Plus, Trash2, X } from 'lucide-react';
import {
  appendOverviewCategory,
  childrenOf,
  DEFAULT_PROJECT_COLOR,
  insertOverviewCategoryAfter,
  overviewLeafLabels,
  parseOverviewTree,
  prependOverviewCategory,
  reconcileOverviewTree,
  removeOverviewNode,
  renameOverviewCategory,
  uniqueOverviewAreaTitle,
  serializeOverviewTree,
  shallow,
  useTaskStore,
  type OverviewReconcileTask,
  type OverviewTreeNode,
  type Task,
  type TaskStatus,
} from '@mindwtr/core';
import { TaskItem } from '../TaskItem';
import { useLanguage } from '../../contexts/language-context';
import { useUiStore } from '../../store/ui-store';
import { cn } from '../../lib/utils';

const TREE_STORAGE_KEY = 'mindwtr:overview:tree:v2';
const SAVE_DEBOUNCE_MS = 300;
const STATUS_ORDER: TaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'reference', 'done'];

type TitleDraft = { nodeId: string; value: string; category: boolean };

function TreeGuides({ guides, stops }: { guides: boolean[]; stops: boolean[] }) {
  const depth = guides.length;
  if (depth <= 0) return null;
  return (
    <>
      {guides.map((visible, level) => (
        visible ? (
          <span
            key={`guide-${level}`}
            aria-hidden
            className={stops[level]
              ? 'pointer-events-none absolute top-0 h-1/2 border-l border-solid border-muted-foreground/40'
              : 'pointer-events-none absolute top-0 bottom-0 border-l border-solid border-muted-foreground/40'}
            style={{ left: level * 18 }}
          />
        ) : null
      ))}
      <span
        aria-hidden
        className="pointer-events-none absolute border-t border-solid border-muted-foreground/40"
        style={{ left: (depth - 1) * 18, top: '50%', width: 18 }}
      />
    </>
  );
}

export function OverviewView() {
  const { t } = useLanguage();
  const { tasks, projects, areas, updateTask, deleteTask, addArea: addAreaToStore, updateArea, addProject, deleteArea, isLoading } = useTaskStore((state) => ({
    tasks: state.tasks,
    projects: state.projects,
    areas: state.areas,
    updateTask: state.updateTask,
    deleteTask: state.deleteTask,
    addArea: state.addArea,
    updateArea: state.updateArea,
    addProject: state.addProject,
    deleteArea: state.deleteArea,
    isLoading: state.isLoading,
  }), shallow);

  const inboxTitle = t('overview.inbox');
  const [tree, setTree] = useState<OverviewTreeNode[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [filters, setFilters] = useState<Set<TaskStatus>>(() => new Set(STATUS_ORDER));
  const [titleDraft, setTitleDraft] = useState<TitleDraft | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [collapsedNodeIds, setCollapsedNodeIds] = useState<Set<string>>(() => new Set());
  const [lockedTaskIds, setLockedTaskIds] = useState<Set<string>>(() => new Set());
  const [lockedDestinations, setLockedDestinations] = useState<Map<string, { areaId?: string; projectId?: string }>>(() => new Map());
  const pendingConversionUnsubscribeRef = useRef<null | (() => void)>(null);
  const treeRef = useRef<OverviewTreeNode[]>(tree);
  treeRef.current = tree;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTree = useRef<OverviewTreeNode[] | null>(null);
  const titleDraftRef = useRef<TitleDraft | null>(null);
  titleDraftRef.current = titleDraft;

  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const areaById = useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);

  const reconcileTasks = useMemo<OverviewReconcileTask[]>(() => tasks.map((task) => {
    const project = task.projectId ? projectById.get(task.projectId) : undefined;
    const area = (project?.areaId ? areaById.get(project.areaId) : undefined)
      ?? (task.areaId ? areaById.get(task.areaId) : undefined);
    return { id: task.id, areaTitle: area?.name ?? null, projectTitle: project?.title ?? null };
  }), [areaById, projectById, tasks]);
  const taskSignature = useMemo(() => tasks.map((task) => task.id).sort().join(','), [tasks]);

  const flushSave = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const pending = pendingTree.current;
    if (!pending) return;
    pendingTree.current = null;
    try {
      window.localStorage.setItem(TREE_STORAGE_KEY, serializeOverviewTree({ version: 2, nodes: pending }));
    } catch {
      // ignore storage failures
    }
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(TREE_STORAGE_KEY);
      setTree(parseOverviewTree(raw)?.nodes ?? []);
    } catch {
      setTree([]);
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    pendingTree.current = tree;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      flushSave();
    }, SAVE_DEBOUNCE_MS);
  }, [tree, loaded, flushSave]);

  useEffect(() => () => flushSave(), [flushSave]);

  useEffect(() => {
    if (!loaded) return;
    setTree((current) => {
      const next = reconcileOverviewTree(current, reconcileTasks, { inboxTitle }).nodes;
      return serializeOverviewTree({ version: 2, nodes: next }) === serializeOverviewTree({ version: 2, nodes: current })
        ? current
        : next;
    });
  }, [loaded, taskSignature, inboxTitle, reconcileTasks]);

  useEffect(() => {
    if (selectedNodeId && !tree.some((node) => node.id === selectedNodeId)) {
      setSelectedNodeId(null);
    }
  }, [tree, selectedNodeId]);

  useEffect(() => {
    if (!loaded || isLoading) return;
    setTree((current) => {
      const missingAreaNodeIds = current
        .filter((node) => node.kind === 'category' && node.areaId && !areaById.has(node.areaId))
        .map((node) => node.id);
      if (missingAreaNodeIds.length === 0) return current;
      let next = current;
      for (const id of missingAreaNodeIds) next = removeOverviewNode(next, id);
      return reconcileOverviewTree(next, reconcileTasks, { inboxTitle }).nodes;
    });
  }, [areaById, inboxTitle, isLoading, loaded, reconcileTasks]);

  const rows = useMemo(() => {
    const visible = new Set(tasks.filter((task) => filters.has(task.status)).map((task) => task.id));
    const build = (parentId: string | null, depth: number): Array<{ node: OverviewTreeNode; depth: number; task?: Task; hasChildren?: boolean; collapsed?: boolean; guides?: boolean[] }> => {
      const result: Array<{ node: OverviewTreeNode; depth: number; task?: Task; hasChildren?: boolean; collapsed?: boolean; guides?: boolean[] }> = [];
      for (const node of childrenOf(tree, parentId)) {
        if (node.kind === 'category') {
          const hasChildren = tree.some((candidate) => candidate.parentId === node.id);
          if (collapsedNodeIds.has(node.id)) {
            result.push({ node, depth, hasChildren, collapsed: true });
            continue;
          }
          const children = build(node.id, depth + 1);
          if (hasChildren && children.length === 0) continue;
          result.push({ node, depth, hasChildren, collapsed: false });
          result.push(...children);
        } else {
          const task = node.taskId ? taskById.get(node.taskId) : undefined;
          if (!task || !visible.has(task.id)) continue;
          result.push({ node, depth, task });
        }
      }
      return result;
    };
    const flatRows = build(null, 0);
    const nodeById = new Map(tree.map((node) => [node.id, node]));
    const lastChildRow = new Map<string, number>();
    flatRows.forEach((row, index) => {
      if (row.node.parentId) lastChildRow.set(row.node.parentId, index);
    });
    const ancestorsOf = (node: OverviewTreeNode): string[] => {
      const path: string[] = [];
      const seen = new Set<string>();
      let parentId = node.parentId;
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId);
        path.unshift(parentId);
        parentId = nodeById.get(parentId)?.parentId ?? null;
      }
      return path;
    };
    return flatRows.map((row, index) => ({
      ...row,
      guides: ancestorsOf(row.node).map((ancestorId) => (
        index <= (lastChildRow.get(ancestorId) ?? -1)
      )),
      guideStops: ancestorsOf(row.node).map((ancestorId) => (
        index === (lastChildRow.get(ancestorId) ?? -1)
      )),
    }));
  }, [collapsedNodeIds, filters, taskById, tree, tasks]);

  const toggleCollapsed = useCallback((nodeId: string) => {
    setCollapsedNodeIds((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  const visibleCount = rows.filter((row) => row.task).length;

  const beginTitleEdit = (draft: TitleDraft) => setTitleDraft(draft);

  const categoryDisplayTitle = useCallback((node: OverviewTreeNode): string => {
    if (node.areaId) {
      const area = areaById.get(node.areaId);
      if (area?.name?.trim()) return area.name.trim();
    }
    return node.title;
  }, [areaById]);

  const siblingCategoryTitles = useCallback((parentId: string | null, exceptId?: string): string[] => (
    treeRef.current
      .filter((node) => node.kind === 'category' && node.parentId === parentId && node.id !== exceptId)
      .map((node) => categoryDisplayTitle(node))
  ), [categoryDisplayTitle]);

  const commitActiveTitleEdit = useCallback((): OverviewTreeNode[] => {
    const draft = titleDraftRef.current;
    titleDraftRef.current = null;
    setTitleDraft(null);
    if (!draft) return treeRef.current;
    const trimmed = draft.value.trim();
    if (draft.category) {
      const proposedTitle = trimmed || t('overview.category');
      const node = treeRef.current.find((candidate) => candidate.id === draft.nodeId);
      const occupied = node?.areaId
        ? [
          ...areas.filter((area) => area.id !== node.areaId).map((area) => area.name),
          ...siblingCategoryTitles(null, node.id),
        ]
        : siblingCategoryTitles(node?.parentId ?? null, node?.id);
      const nextTitle = uniqueOverviewAreaTitle(proposedTitle, occupied);
      if (node?.areaId) {
        void updateArea(node.areaId, { name: nextTitle });
      }
      const nextTree = renameOverviewCategory(treeRef.current, draft.nodeId, nextTitle);
      setTree(nextTree);
      return nextTree;
    }
    return treeRef.current;
  }, [areas, siblingCategoryTitles, t, updateArea]);

  const finishTitleEdit = useCallback((save: boolean) => {
    if (!save) {
      titleDraftRef.current = null;
      setTitleDraft(null);
      return;
    }
    commitActiveTitleEdit();
  }, [commitActiveTitleEdit]);

  // Clicking anywhere outside the inline input commits the title.
  const commitPendingTitleEdit = useCallback(() => {
    if (titleDraftRef.current) {
      commitActiveTitleEdit();
    }
  }, [commitActiveTitleEdit]);

  const addNodeUnder = useCallback((parentId: string | null) => {
    const baseTree = commitActiveTitleEdit();
    if (parentId) {
      setCollapsedNodeIds((current) => {
        if (!current.has(parentId)) return current;
        const next = new Set(current);
        next.delete(parentId);
        return next;
      });
    }
    const title = uniqueOverviewAreaTitle(t('overview.newNode'), baseTree
      .filter((node) => node.kind === 'category' && node.parentId === parentId)
      .map((node) => categoryDisplayTitle(node)));
    const appended = appendOverviewCategory(baseTree, title, parentId);
    setTree(appended.nodes);
    setSelectedNodeId(appended.node.id);
    beginTitleEdit({ nodeId: appended.node.id, value: '', category: true });
  }, [categoryDisplayTitle, commitActiveTitleEdit, t]);

  const addNode = useCallback(() => {
    const selected = selectedNodeId
      ? treeRef.current.find((node) => node.id === selectedNodeId)
      : undefined;
    if (selected && selected.kind === 'category') {
      addNodeUnder(selected.id);
      return;
    }
    const baseTree = commitActiveTitleEdit();
    const title = uniqueOverviewAreaTitle(t('overview.newNode'), baseTree
      .filter((node) => node.kind === 'category' && node.parentId === null)
      .map((node) => categoryDisplayTitle(node)));
    const appended = prependOverviewCategory(baseTree, title, null);
    setTree(appended.nodes);
    setSelectedNodeId(appended.node.id);
    beginTitleEdit({ nodeId: appended.node.id, value: '', category: true });
  }, [addNodeUnder, categoryDisplayTitle, commitActiveTitleEdit, selectedNodeId, t]);

  const addSiblingNode = useCallback(() => {
    const selected = selectedNodeId
      ? treeRef.current.find((node) => node.id === selectedNodeId)
      : undefined;
    const baseTree = commitActiveTitleEdit();
    const parentId = selected?.parentId ?? null;
    const title = uniqueOverviewAreaTitle(t('overview.newNode'), baseTree
      .filter((node) => node.kind === 'category' && node.parentId === parentId)
      .map((node) => categoryDisplayTitle(node)));
    const inserted = selected
      ? insertOverviewCategoryAfter(baseTree, selected.id, title)
      : null;
    const appended = inserted ?? prependOverviewCategory(baseTree, title, null);
    setTree(appended.nodes);
    setSelectedNodeId(appended.node.id);
    beginTitleEdit({ nodeId: appended.node.id, value: '', category: true });
  }, [beginTitleEdit, categoryDisplayTitle, commitActiveTitleEdit, selectedNodeId, t]);

  const addArea = useCallback(async () => {
    const baseTree = commitActiveTitleEdit();
    const occupied = [
      ...areas.map((area) => area.name),
      ...baseTree
        .filter((node) => node.kind === 'category' && node.parentId === null)
        .map((node) => categoryDisplayTitle(node)),
    ];
    const title = uniqueOverviewAreaTitle(t('overview.areaNameDefault'), occupied);
    const created = await addAreaToStore(title);
    const resolvedTitle = created?.name?.trim() || title;
    const appended = prependOverviewCategory(baseTree, resolvedTitle, null);
    const nodes = created
      ? appended.nodes.map((node) => (
        node.id === appended.node.id ? { ...node, areaId: created.id } : node
      ))
      : appended.nodes;
    setTree(nodes);
    setSelectedNodeId(appended.node.id);
    beginTitleEdit({ nodeId: appended.node.id, value: resolvedTitle, category: true });
  }, [addAreaToStore, areas, beginTitleEdit, categoryDisplayTitle, commitActiveTitleEdit, t]);

  const ensureDestinationForNode = useCallback(async (
    node: OverviewTreeNode,
  ): Promise<{ areaId?: string; projectId?: string }> => {
    const ancestors: OverviewTreeNode[] = [];
    const seen = new Set<string>();
    let parentId = node.parentId;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = treeRef.current.find((candidate) => candidate.id === parentId);
      if (!parent || parent.kind !== 'category') break;
      ancestors.unshift(parent);
      parentId = parent.parentId;
    }
    const titles = ancestors
      .map((ancestor) => categoryDisplayTitle(ancestor).trim())
      .filter(Boolean);
    if (titles.length === 1 && titles[0].toLowerCase() === inboxTitle.trim().toLowerCase()) {
      return {};
    }

    let areaId: string | undefined;
    if (ancestors.length === 0) {
      areaId = node.areaId
        ?? areas.find((area) => area.name.trim().toLowerCase() === categoryDisplayTitle(node).trim().toLowerCase())?.id;
    } else {
      areaId = ancestors.find((ancestor) => ancestor.areaId)?.areaId;
      if (!areaId && titles[0]) {
        const existingArea = areas.find((area) => area.name.trim().toLowerCase() === titles[0].toLowerCase());
        areaId = existingArea?.id ?? (await addAreaToStore(titles[0]))?.id;
      }
    }

    let projectId: string | undefined;
    const projectTitle = titles.join(' / ');
    if (projectTitle) {
      const existingProject = projects.find((project) => (
        project.title.trim().toLowerCase() === projectTitle.toLowerCase()
        && (!areaId || project.areaId === areaId)
      ));
      projectId = existingProject?.id
        ?? (await addProject(projectTitle, DEFAULT_PROJECT_COLOR, areaId ? { areaId } : undefined))?.id;
    }
    return { areaId, projectId };
  }, [addAreaToStore, addProject, areas, categoryDisplayTitle, inboxTitle, projects]);

  const resolveNodeDestinationSync = useCallback((node: OverviewTreeNode): {
    areaId?: string;
    projectId?: string;
    hasPath: boolean;
  } => {
    const ancestors: OverviewTreeNode[] = [];
    const seen = new Set<string>();
    let parentId = node.parentId;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = treeRef.current.find((candidate) => candidate.id === parentId);
      if (!parent || parent.kind !== 'category') break;
      ancestors.unshift(parent);
      parentId = parent.parentId;
    }
    const titles = ancestors.map((ancestor) => categoryDisplayTitle(ancestor).trim()).filter(Boolean);
    if (titles.length === 1 && titles[0].toLowerCase() === inboxTitle.trim().toLowerCase()) {
      return { hasPath: false };
    }
    let areaId: string | undefined;
    if (ancestors.length === 0) {
      areaId = node.areaId
        ?? areas.find((area) => area.name.trim().toLowerCase() === categoryDisplayTitle(node).trim().toLowerCase())?.id;
    } else {
      areaId = ancestors.find((ancestor) => ancestor.areaId)?.areaId
        ?? areas.find((area) => area.name.trim().toLowerCase() === titles[0].toLowerCase())?.id;
    }
    const projectTitle = titles.join(' / ');
    const projectId = projectTitle
      ? projects.find((project) => (
        project.title.trim().toLowerCase() === projectTitle.toLowerCase()
        && (!areaId || project.areaId === areaId)
      ))?.id
      : undefined;
    return { areaId, projectId, hasPath: titles.length > 0 };
  }, [areas, categoryDisplayTitle, inboxTitle, projects]);

  const placeTaskLeaf = useCallback((
    nodes: OverviewTreeNode[],
    taskId: string,
    keepNodeId: string,
    beforeCategoryIds: Set<string>,
  ): OverviewTreeNode[] => {
    const converted = nodes
      .map((candidate) => (
        candidate.id === keepNodeId
          ? { ...candidate, kind: 'task' as const, taskId, title: '', areaId: undefined }
          : candidate
      ))
      .filter((candidate) => !(
        candidate.kind === 'task' && candidate.taskId === taskId && candidate.id !== keepNodeId
      ));
    return converted.filter((candidate) => !(
      candidate.kind === 'category'
      && !beforeCategoryIds.has(candidate.id)
      && !converted.some((child) => child.parentId === candidate.id)
    ));
  }, []);

  const openNodeEditor = useCallback((node: OverviewTreeNode) => {
    const baseTree = commitActiveTitleEdit();
    const current = baseTree.find((candidate) => candidate.id === node.id) ?? node;
    if (current.kind === 'category' && baseTree.some((candidate) => candidate.parentId === current.id)) {
      window.alert(t('overview.convertNeedsLeaf'));
      return;
    }
    const destination = resolveNodeDestinationSync(current);

    if (current.kind === 'task' && current.taskId) {
      setLockedDestinations((map) => new Map(map).set(current.taskId as string, destination));
      if (destination.areaId || destination.projectId) {
        setLockedTaskIds((ids) => new Set(ids).add(current.taskId as string));
      }
      useUiStore.getState().setEditingTaskId(current.taskId);
      return;
    }

    const title = categoryDisplayTitle(current).trim();
    if (!title) return;
    const nodeId = current.id;
    const beforeCategoryIds = new Set(
      treeRef.current.filter((candidate) => candidate.kind === 'category').map((candidate) => candidate.id),
    );
    const before = new Set(useTaskStore.getState()._allTasks.map((task) => task.id));
    pendingConversionUnsubscribeRef.current?.();
    pendingConversionUnsubscribeRef.current = null;
    window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
      detail: { initialValue: title, lockDestination: true },
    }));
    const unsubscribe = useTaskStore.subscribe((state) => {
      const created = state._allTasks.find((task) => !before.has(task.id));
      if (!created) return;
      unsubscribe();
      pendingConversionUnsubscribeRef.current = null;
      void (async () => {
        const destinationNow = await ensureDestinationForNode(current);
        if (destinationNow.areaId || destinationNow.projectId) {
          await updateTask(created.id, {
            ...(destinationNow.areaId ? { areaId: destinationNow.areaId } : {}),
            ...(destinationNow.projectId ? { projectId: destinationNow.projectId } : {}),
          });
          setLockedTaskIds((ids) => new Set(ids).add(created.id));
          setLockedDestinations((map) => new Map(map).set(created.id, destinationNow));
        }
        setTree((treeNow) => placeTaskLeaf(treeNow, created.id, nodeId, beforeCategoryIds));
      })();
    });
    pendingConversionUnsubscribeRef.current = unsubscribe;
  }, [categoryDisplayTitle, commitActiveTitleEdit, ensureDestinationForNode, placeTaskLeaf, resolveNodeDestinationSync, t, updateTask]);

  useEffect(() => () => {
    pendingConversionUnsubscribeRef.current?.();
    pendingConversionUnsubscribeRef.current = null;
  }, []);

  const toggleTaskDone = useCallback((task: Task) => {
    const nextStatus: TaskStatus = task.status === 'done'
      ? (task.projectId ? 'next' : 'inbox')
      : 'done';
    void updateTask(task.id, { status: nextStatus });
  }, [updateTask]);

  const removeCategory = useCallback((nodeId: string) => {
    setSelectedNodeId((current) => (current === nodeId ? null : current));
    const node = treeRef.current.find((candidate) => candidate.id === nodeId);
    if (node?.areaId) void deleteArea(node.areaId);
    const without = removeOverviewNode(treeRef.current, nodeId);
    setTree(reconcileOverviewTree(without, reconcileTasks, { inboxTitle }).nodes);
  }, [deleteArea, inboxTitle, reconcileTasks]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {STATUS_ORDER.map((status) => {
            const selected = filters.has(status);
            return (
              <button
                key={status}
                type="button"
                aria-pressed={selected}
                onClick={() => {
                  setFilters((current) => {
                    const next = new Set(current);
                    if (next.has(status)) next.delete(status);
                    else next.add(status);
                    return next;
                  });
                }}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs font-semibold transition-colors',
                  selected
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {t(`status.${status}`)}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setFilters(new Set(STATUS_ORDER))}
            className="rounded-full border border-border px-3 py-1 text-xs font-semibold text-muted-foreground hover:text-foreground"
          >
            {t('common.all')}
          </button>
        </div>
        <span className="ml-auto text-xs font-semibold text-muted-foreground">{visibleCount}</span>
        {selectedNodeId ? (
          <div className="flex max-w-[160px] items-center gap-1 rounded-full border border-primary bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
            <span className="truncate">
              {(() => {
                const node = tree.find((candidate) => candidate.id === selectedNodeId);
                if (!node) return '';
                return node.kind === 'task' && node.taskId
                  ? taskById.get(node.taskId)?.title ?? ''
                  : node.title;
              })()}
            </span>
            <button
              type="button"
              aria-label={t('common.clear')}
              onClick={() => {
                commitPendingTitleEdit();
                setSelectedNodeId(null);
              }}
              className="rounded p-0.5 hover:bg-primary/20"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ) : null}
        <button
          type="button"
          onClick={addNode}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground"
        >
          <Plus className="h-4 w-4" />
          {t('overview.addChildNode')}
        </button>
        <button
          type="button"
          onClick={addSiblingNode}
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-semibold text-foreground"
        >
          <CornerDownRight className="h-4 w-4" />
          {t('overview.newSiblingNode')}
        </button>
        <button
          type="button"
          onClick={() => { void addArea(); }}
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-semibold text-foreground"
        >
          <Folder className="h-4 w-4" />
          {t('overview.newArea')}
        </button>
      </div>

      <div
        data-testid="overview-list"
        className="flex-1 overflow-auto px-4 py-3"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) finishTitleEdit(true);
        }}
      >
        {rows.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">{t('overview.empty')}</div>
        ) : null}

        {rows.map((row) => {
          if (row.node.kind === 'category') {
            const draft = titleDraft?.nodeId === row.node.id ? titleDraft : null;
            return (
              <div
                key={row.node.id}
                onClick={(event) => {
                  if (event.target instanceof Element && event.target.closest('button, a, input, [role="button"]')) {
                    return;
                  }
                  commitPendingTitleEdit();
                  setSelectedNodeId(row.node.id);
                  if (row.hasChildren) toggleCollapsed(row.node.id);
                }}
                className={cn(
                  'group relative flex cursor-default items-center gap-2 rounded-md py-1.5 hover:bg-muted/40',
                  selectedNodeId === row.node.id ? 'bg-primary/10' : null,
                )}
                style={{ paddingLeft: row.depth * 18 }}
              >
                <TreeGuides guides={row.guides ?? []} stops={row.guideStops ?? []} />
                <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
                  <Folder className="h-4 w-4 text-primary" />
                  {row.hasChildren ? (
                    <span className="absolute -bottom-1 -right-1 flex h-3 w-3 items-center justify-center rounded-full bg-background">
                      {row.collapsed
                        ? <Plus className="h-2 w-2 text-primary" />
                        : <Minus className="h-2 w-2 text-primary" />}
                    </span>
                  ) : null}
                </span>
                {draft ? (
                  <input
                    autoFocus
                    value={draft.value}
                    placeholder={t('overview.categoryPlaceholder')}
                    onChange={(event) => setTitleDraft((current) => (current ? { ...current, value: event.target.value } : current))}
                    onBlur={() => finishTitleEdit(true)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') finishTitleEdit(true);
                      if (event.key === 'Escape') finishTitleEdit(false);
                    }}
                    className="min-w-0 flex-1 border-b border-primary bg-transparent text-sm font-bold outline-none"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      commitPendingTitleEdit();
                      if (row.hasChildren) {
                        if (selectedNodeId !== row.node.id) setSelectedNodeId(row.node.id);
                        toggleCollapsed(row.node.id);
                        return;
                      }
                      if (selectedNodeId !== row.node.id) {
                        setSelectedNodeId(row.node.id);
                        return;
                      }
                      beginTitleEdit({ nodeId: row.node.id, value: categoryDisplayTitle(row.node), category: true });
                    }}
                    className="min-w-0 flex-1 truncate text-left text-sm font-bold text-foreground"
                  >
                    {categoryDisplayTitle(row.node)}
                  </button>
                )}
                <button
                  type="button"
                  title={t('common.edit')}
                  aria-label={`${t('common.edit')}: ${categoryDisplayTitle(row.node)}`}
                  onClick={() => {
                    commitPendingTitleEdit();
                    setSelectedNodeId(row.node.id);
                    if (row.hasChildren) {
                      beginTitleEdit({ nodeId: row.node.id, value: categoryDisplayTitle(row.node), category: true });
                      return;
                    }
                    void openNodeEditor(row.node);
                  }}
                  className="rounded p-1 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover:opacity-100"
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  title={t('overview.addChildNode')}
                  onClick={() => addNodeUnder(row.node.id)}
                  className="rounded p-1 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover:opacity-100"
                >
                  <FolderPlus className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  aria-label={`${t('common.delete')}: ${categoryDisplayTitle(row.node)}`}
                  title={t('common.delete')}
                  onClick={() => removeCategory(row.node.id)}
                  className="rounded p-1 text-muted-foreground opacity-0 hover:bg-muted hover:text-danger group-hover:opacity-100"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            );
          }

          const task = row.task as Task;
          const project = task.projectId ? projectById.get(task.projectId) : undefined;
          const labels = overviewLeafLabels(tree, row.node);
          return (
            <div
              key={row.node.id}
              onClick={() => {
                commitPendingTitleEdit();
                setSelectedNodeId(row.node.id);
              }}
              className={cn('group relative rounded-md', selectedNodeId === row.node.id ? 'bg-primary/10' : null)}
              style={{ paddingLeft: row.depth * 18 }}
            >
              <TreeGuides guides={row.guides ?? []} stops={row.guideStops ?? []} />
              {labels.projectLabel ? (
                <div className="pl-1 text-[11px] font-semibold text-muted-foreground">{labels.projectLabel} ·</div>
              ) : null}
              <div className="flex items-start gap-2">
                <button
                  type="button"
                  aria-label={`${t('status.done')}: ${task.title}`}
                  aria-pressed={task.status === 'done'}
                  onClick={() => {
                    commitPendingTitleEdit();
                    toggleTaskDone(task);
                  }}
                  className={cn(
                    'mt-2 flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                    task.status === 'done' ? 'border-success bg-success text-white' : 'border-muted-foreground',
                  )}
                >
                  {task.status === 'done' ? <Check className="h-3 w-3" /> : null}
                </button>
                <div className="min-w-0 flex-1">
                  <TaskItem
                    task={(() => {
                      const destination = lockedDestinations.get(task.id);
                      return destination
                        ? {
                          ...task,
                          ...(destination.areaId ? { areaId: destination.areaId } : {}),
                          ...(destination.projectId ? { projectId: destination.projectId } : {}),
                        }
                        : task;
                    })()}
                    project={project}
                    compactMetaEnabled
                    showProjectBadgeInMetadata={false}
                    showProjectBadgeInActions={false}
                    lockedDestination={lockedTaskIds.has(task.id)}
                  />
                </div>
                <button
                  type="button"
                  aria-label={`${t('common.edit')}: ${task.title}`}
                  title={t('common.edit')}
                  onClick={() => {
                    commitPendingTitleEdit();
                    setSelectedNodeId(row.node.id);
                    void openNodeEditor(row.node);
                  }}
                  className="mt-1 rounded p-1 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover:opacity-100"
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  aria-label={`${t('common.delete')}: ${task.title}`}
                  title={t('common.delete')}
                  onClick={() => {
                    setSelectedNodeId((current) => (current === row.node.id ? null : current));
                    setTree((current) => removeOverviewNode(current, row.node.id));
                    void deleteTask(task.id);
                  }}
                  className="mt-1 rounded p-1 text-muted-foreground opacity-0 hover:bg-muted hover:text-danger group-hover:opacity-100"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
