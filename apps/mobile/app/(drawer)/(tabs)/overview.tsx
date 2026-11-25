import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Check,
  Folder,
  MoreHorizontal,
  Pencil,
  Plus,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react-native';
import {
  appendOverviewCategory,
  childrenOf,
  DEFAULT_PROJECT_COLOR,
  moveOverviewNode,
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

import { TaskEditModal } from '@/components/task-edit-modal';
import { useLanguage } from '@/contexts/language-context';
import { useThemeColors, type ThemeColors } from '@/hooks/use-theme-colors';
import { workspaceSessionStorage as AsyncStorage } from '@/lib/workspace-session-storage';

const TREE_STORAGE_KEY = 'mindwtr:overview:tree:v2';
const SAVE_DEBOUNCE_MS = 300;

const STATUS_ORDER: TaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'reference', 'done'];

type FlatRow = {
  node: OverviewTreeNode;
  depth: number;
  task?: Task;
};

type ActionSheetState =
  | { kind: 'category'; nodeId: string }
  | { kind: 'task'; nodeId: string; taskId: string }
  | null;
type TitleDraft = {
  nodeId: string;
  taskId?: string;
  original: string;
  value: string;
};

function depthPrefix(depth: number): string {
  return depth > 0 ? `${'  '.repeat(depth)}· ` : '';
}

function statusLabelKey(status: TaskStatus): string {
  return `status.${status}`;
}

function Sheet({
  visible,
  title,
  closeLabel,
  bottomInset,
  onClose,
  tc,
  children,
}: {
  visible: boolean;
  title: string;
  closeLabel: string;
  bottomInset: number;
  onClose: () => void;
  tc: ThemeColors;
  children: React.ReactNode;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.sheetRoot}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={closeLabel}
          onPress={onClose}
          style={styles.sheetBackdrop}
        />
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: tc.cardBg,
              borderColor: tc.border,
              paddingBottom: Math.max(24, bottomInset + 16),
            },
          ]}
        >
          <View style={styles.sheetHeader}>
            <Text style={[styles.sheetTitle, { color: tc.text }]} accessibilityRole="header">
              {title}
            </Text>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={closeLabel}
              onPress={onClose}
              style={styles.sheetCloseButton}
            >
              <Text style={[styles.sheetCloseText, { color: tc.tint }]}>✕</Text>
            </TouchableOpacity>
          </View>
          {children}
        </View>
      </View>
    </Modal>
  );
}

function SheetOption({
  label,
  icon,
  destructive,
  tc,
  onPress,
}: {
  label: string;
  icon?: React.ReactNode;
  destructive?: boolean;
  tc: ThemeColors;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.sheetOption, { borderColor: tc.border }]}
    >
      {icon}
      <Text
        style={[
          styles.sheetOptionText,
          { color: destructive ? tc.danger : tc.text },
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

export default function OverviewScreen() {
  const tc = useThemeColors();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();

  const { tasks, areas, projects, updateTask, deleteTask, addTask, addArea: addAreaToStore, updateArea, addProject, deleteArea, isLoading } = useTaskStore((state) => ({
    tasks: state.tasks,
    areas: state.areas,
    projects: state.projects,
    updateTask: state.updateTask,
    deleteTask: state.deleteTask,
    addTask: state.addTask,
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
  const [filterVisible, setFilterVisible] = useState(false);
  const [actionSheet, setActionSheet] = useState<ActionSheetState>(null);
  const [moveSheetNodeId, setMoveSheetNodeId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState<TitleDraft | null>(null);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [lockedDestinationFields, setLockedDestinationFields] = useState<('area' | 'project')[]>([]);
  const pendingEditRef = useRef<{ mode: 'create' | 'update'; nodeId: string; taskId?: string; fallbackTitle: string } | null>(null);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTree = useRef<OverviewTreeNode[] | null>(null);
  const titleDraftRef = useRef<TitleDraft | null>(null);
  titleDraftRef.current = titleDraft;
  const treeRef = useRef<OverviewTreeNode[]>(tree);
  treeRef.current = tree;

  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const areaById = useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);

  const reconcileTasks = useMemo<OverviewReconcileTask[]>(() => tasks.map((task) => {
    const project = task.projectId ? projectById.get(task.projectId) : undefined;
    const area = (project?.areaId ? areaById.get(project.areaId) : undefined)
      ?? (task.areaId ? areaById.get(task.areaId) : undefined);
    return {
      id: task.id,
      areaTitle: area?.name ?? null,
      projectTitle: project?.title ?? null,
    };
  }), [areaById, projectById, tasks]);
  const taskSignature = useMemo(
    () => tasks.map((task) => task.id).sort().join(','),
    [tasks],
  );

  const flushSave = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const pending = pendingTree.current;
    if (!pending) return;
    pendingTree.current = null;
    void AsyncStorage.setItem(TREE_STORAGE_KEY, serializeOverviewTree({ version: 2, nodes: pending }))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(TREE_STORAGE_KEY)
      .then((raw) => {
        if (cancelled) return;
        setTree(parseOverviewTree(raw)?.nodes ?? []);
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setTree([]);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
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

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') flushSave();
    });
    return () => subscription.remove();
  }, [flushSave]);

  useEffect(() => () => flushSave(), [flushSave]);

  const reconcileWithTasks = useCallback((nodes: OverviewTreeNode[]): OverviewTreeNode[] => (
    reconcileOverviewTree(nodes, reconcileTasks, { inboxTitle }).nodes
  ), [inboxTitle, reconcileTasks]);

  useEffect(() => {
    if (!loaded) return;
    setTree((current) => {
      const next = reconcileWithTasks(current);
      return serializeOverviewTree({ version: 2, nodes: next }) === serializeOverviewTree({ version: 2, nodes: current })
        ? current
        : next;
    });
  }, [loaded, taskSignature, reconcileWithTasks]);

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

  const visibleTaskIds = useMemo(() => new Set(
    tasks.filter((task) => filters.has(task.status)).map((task) => task.id),
  ), [filters, tasks]);

  const rows = useMemo<FlatRow[]>(() => {
    const build = (parentId: string | null, depth: number): FlatRow[] => {
      const result: FlatRow[] = [];
      for (const node of childrenOf(tree, parentId)) {
        if (node.kind === 'category') {
          const childRows = build(node.id, depth + 1);
          const hasChildren = tree.some((candidate) => candidate.parentId === node.id);
          if (hasChildren && childRows.length === 0) continue;
          result.push({ node, depth });
          result.push(...childRows);
        } else {
          const task = node.taskId ? taskById.get(node.taskId) : undefined;
          if (!task || !visibleTaskIds.has(task.id)) continue;
          result.push({ node, depth, task });
        }
      }
      return result;
    };
    return build(null, 0);
  }, [taskById, tree, visibleTaskIds]);

  const visibleCount = rows.reduce((total, row) => total + (row.task ? 1 : 0), 0);

  const taskCounts = useMemo(() => {
    const counts = new Map<string, number>();
    const countCategory = (categoryId: string): number => {
      let total = 0;
      for (const node of childrenOf(tree, categoryId)) {
        if (node.kind === 'category') {
          total += countCategory(node.id);
        } else if (node.taskId && visibleTaskIds.has(node.taskId)) {
          total += 1;
        }
      }
      counts.set(categoryId, total);
      return total;
    };
    for (const node of tree) {
      if (node.kind === 'category' && node.parentId === null) countCategory(node.id);
    }
    return counts;
  }, [tree, visibleTaskIds]);

  const beginTitleEdit = useCallback((draft: TitleDraft) => {
    setTitleDraft(draft);
  }, []);

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
    if (draft.taskId) {
      if (trimmed && trimmed !== draft.original) {
        void updateTask(draft.taskId, { title: trimmed });
      }
      return treeRef.current;
    }
    const proposedTitle = trimmed || draft.original || t('overview.category');
    const node = treeRef.current.find((candidate) => candidate.id === draft.nodeId);
    const occupied = node?.areaId
      ? [
        ...areas.filter((area) => area.id !== node.areaId).map((area) => area.name),
        ...siblingCategoryTitles(null, node.id),
      ]
      : siblingCategoryTitles(node?.parentId ?? null, node?.id);
    const nextTitle = uniqueOverviewAreaTitle(proposedTitle, occupied);
    const nextTree = renameOverviewCategory(treeRef.current, draft.nodeId, nextTitle);
    if (node?.areaId) {
      void updateArea(node.areaId, { name: nextTitle });
    }
    setTree(nextTree);
    return nextTree;
  }, [areas, siblingCategoryTitles, t, updateArea, updateTask]);

  const finishTitleEdit = useCallback((save: boolean) => {
    if (!save) {
      titleDraftRef.current = null;
      setTitleDraft(null);
      return;
    }
    commitActiveTitleEdit();
  }, [commitActiveTitleEdit]);

  const addNodeUnder = useCallback((parentId: string | null) => {
    const baseTree = commitActiveTitleEdit();
    const title = uniqueOverviewAreaTitle(t('overview.newNode'), baseTree
      .filter((node) => node.kind === 'category' && node.parentId === parentId)
      .map((node) => categoryDisplayTitle(node)));
    const appended = appendOverviewCategory(baseTree, title, parentId);
    setTree(appended.nodes);
    setSelectedNodeId(appended.node.id);
    beginTitleEdit({
      nodeId: appended.node.id,
      original: title,
      value: '',
    });
  }, [beginTitleEdit, categoryDisplayTitle, commitActiveTitleEdit, t]);

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
    beginTitleEdit({
      nodeId: appended.node.id,
      original: title,
      value: '',
    });
  }, [addNodeUnder, beginTitleEdit, categoryDisplayTitle, commitActiveTitleEdit, selectedNodeId, t]);

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
    beginTitleEdit({ nodeId: appended.node.id, original: resolvedTitle, value: resolvedTitle });
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

  const openNodeEditor = useCallback((node: OverviewTreeNode) => {
    const baseTree = commitActiveTitleEdit();
    const current = baseTree.find((candidate) => candidate.id === node.id) ?? node;
    if (current.kind === 'category' && baseTree.some((candidate) => candidate.parentId === current.id)) {
      Alert.alert(t('overview.newNode'), t('overview.convertNeedsLeaf'));
      return;
    }
    const destination = resolveNodeDestinationSync(current);
    const lockedFields: ('area' | 'project')[] = destination.hasPath
      ? ['area', 'project']
      : destination.areaId
        ? ['area']
        : [];
    setLockedDestinationFields(lockedFields);

    if (current.kind === 'task' && current.taskId) {
      const task = useTaskStore.getState()._allTasks.find((candidate) => candidate.id === current.taskId);
      if (!task) return;
      pendingEditRef.current = { mode: 'update', nodeId: current.id, taskId: task.id, fallbackTitle: task.title };
      setEditingTask({
        ...task,
        ...(destination.areaId ? { areaId: destination.areaId } : {}),
        ...(destination.projectId ? { projectId: destination.projectId } : {}),
      });
      return;
    }

    const title = categoryDisplayTitle(current).trim();
    if (!title) return;
    const now = new Date().toISOString();
    pendingEditRef.current = { mode: 'create', nodeId: current.id, fallbackTitle: title };
    setEditingTask({
      id: `draft-${current.id}`,
      title,
      status: 'inbox',
      tags: [],
      contexts: [],
      createdAt: now,
      updatedAt: now,
      ...(destination.areaId ? { areaId: destination.areaId } : {}),
      ...(destination.projectId ? { projectId: destination.projectId } : {}),
    } as Task);
  }, [categoryDisplayTitle, commitActiveTitleEdit, resolveNodeDestinationSync, t]);

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

  const handleEditorSave = useCallback(async (taskId: string, updates: Partial<Task>) => {
    const pending = pendingEditRef.current;
    pendingEditRef.current = null;
    if (!pending) return;
    const node = treeRef.current.find((candidate) => candidate.id === pending.nodeId);
    if (!node) return;
    const destination = await ensureDestinationForNode(node);
    const patch: Partial<Task> = {
      ...updates,
      ...(destination.areaId ? { areaId: destination.areaId } : {}),
      ...(destination.projectId ? { projectId: destination.projectId } : {}),
    };
    if (pending.mode === 'create') {
      const beforeCategoryIds = new Set(
        treeRef.current.filter((candidate) => candidate.kind === 'category').map((candidate) => candidate.id),
      );
      const title = (updates.title ?? pending.fallbackTitle).trim() || pending.fallbackTitle;
      const result = await addTask(title, { ...patch, status: updates.status ?? 'inbox' });
      if (!result.success || !result.id) return;
      const newTaskId = result.id;
      setTree((current) => placeTaskLeaf(current, newTaskId, pending.nodeId, beforeCategoryIds));
      return;
    }
    if (pending.taskId) {
      await updateTask(pending.taskId, patch);
    }
  }, [addTask, ensureDestinationForNode, placeTaskLeaf, updateTask]);

  const toggleTaskDone = useCallback((task: Task) => {
    const nextStatus: TaskStatus = task.status === 'done'
      ? (task.projectId ? 'next' : 'inbox')
      : 'done';
    void updateTask(task.id, { status: nextStatus });
  }, [updateTask]);

  const removeTaskLeaf = useCallback((nodeId: string, taskId: string) => {
    setSelectedNodeId((current) => (current === nodeId ? null : current));
    setTree((current) => removeOverviewNode(current, nodeId));
    void deleteTask(taskId);
  }, [deleteTask]);

  const removeCategory = useCallback((nodeId: string) => {
    const node = treeRef.current.find((candidate) => candidate.id === nodeId);
    if (!node) return;
    Alert.alert(
      t('common.delete'),
      node.title,
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            setSelectedNodeId((current) => (current === nodeId ? null : current));
            if (node.areaId) void deleteArea(node.areaId);
            const without = removeOverviewNode(treeRef.current, nodeId);
            setTree(reconcileWithTasks(without));
          },
        },
      ],
    );
  }, [deleteArea, reconcileWithTasks, t]);

  const moveNodeToCategory = useCallback((nodeId: string, parentId: string | null) => {
    setTree((current) => moveOverviewNode(current, nodeId, parentId));
    setMoveSheetNodeId(null);
  }, []);

  const renderTaskTitle = (row: FlatRow) => {
    const task = row.task as Task;
    const labels = overviewLeafLabels(tree, row.node);
    const draft = titleDraft?.nodeId === row.node.id ? titleDraft : null;
    if (draft) {
      return (
        <TextInput
          value={draft.value}
          autoFocus
          selectTextOnFocus
          style={[styles.taskTitleInput, { color: tc.text }]}
          placeholder={t('overview.taskPlaceholder')}
          placeholderTextColor={tc.secondaryText}
          onChangeText={(value) => setTitleDraft((current) => (current ? { ...current, value } : current))}
          onSubmitEditing={() => finishTitleEdit(true)}
          onBlur={() => finishTitleEdit(true)}
          submitBehavior="blurAndSubmit"
          returnKeyType="done"
        />
      );
    }
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={task.title}
        onPress={() => {
          setSelectedNodeId(row.node.id);
          beginTitleEdit({
          nodeId: row.node.id,
          taskId: task.id,
          original: task.title,
          value: task.title,
        }); }}
        style={styles.taskTitlePressable}
      >
        {labels.projectLabel ? (
          <Text style={[styles.taskPathPrefix, { color: tc.secondaryText }]} numberOfLines={1}>
            {labels.projectLabel} ·{' '}
          </Text>
        ) : null}
        <Text
          style={[
            styles.taskTitle,
            {
              color: tc.text,
              textDecorationLine: task.status === 'done' ? 'line-through' : 'none',
              opacity: task.status === 'done' ? 0.6 : 1,
            },
          ]}
          numberOfLines={2}
        >
          {task.title}
        </Text>
      </Pressable>
    );
  };

  const renderCategoryTitle = (node: OverviewTreeNode) => {
    const draft = titleDraft?.nodeId === node.id ? titleDraft : null;
    if (draft) {
      return (
        <TextInput
          value={draft.value}
          autoFocus
          selectTextOnFocus
          style={[styles.categoryInput, { color: tc.text }]}
          placeholder={t('overview.categoryPlaceholder')}
          placeholderTextColor={tc.secondaryText}
          onChangeText={(value) => setTitleDraft((current) => (current ? { ...current, value } : current))}
          onSubmitEditing={() => finishTitleEdit(true)}
          onBlur={() => finishTitleEdit(true)}
          submitBehavior="blurAndSubmit"
          returnKeyType="done"
        />
      );
    }
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={categoryDisplayTitle(node)}
        onPress={() => {
          setSelectedNodeId(node.id);
          beginTitleEdit({ nodeId: node.id, original: categoryDisplayTitle(node), value: categoryDisplayTitle(node) });
        }}
        onLongPress={() => setActionSheet({ kind: 'category', nodeId: node.id })}
        style={styles.categoryTitlePressable}
      >
        <Text style={[styles.categoryTitle, { color: tc.text }]} numberOfLines={1}>
          {categoryDisplayTitle(node)}
        </Text>
      </Pressable>
    );
  };

  const activeFilterCount = filters.size;

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: tc.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={[styles.toolbar, { borderBottomColor: tc.border, backgroundColor: tc.cardBg }]}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={t('filters.label')}
          onPress={() => setFilterVisible(true)}
          style={[
            styles.toolbarButton,
            { borderColor: activeFilterCount === STATUS_ORDER.length ? tc.border : tc.tint },
          ]}
        >
          <SlidersHorizontal
            size={17}
            color={activeFilterCount === STATUS_ORDER.length ? tc.secondaryText : tc.tint}
          />
          <Text
            style={[
              styles.toolbarButtonText,
              { color: activeFilterCount === STATUS_ORDER.length ? tc.secondaryText : tc.tint },
            ]}
          >
            {t('filters.label')}
          </Text>
        </TouchableOpacity>
        <Text style={[styles.countLabel, { color: tc.secondaryText }]}>
          {visibleCount}
        </Text>
        {selectedNodeId ? (
          <View style={[styles.selectedChip, { borderColor: tc.tint, backgroundColor: `${tc.tint}14` }]}>
            <Text style={[styles.selectedChipText, { color: tc.tint }]} numberOfLines={1}>
              {(() => {
                const node = tree.find((candidate) => candidate.id === selectedNodeId);
                if (!node) return '';
                return node.kind === 'task' && node.taskId
                  ? taskById.get(node.taskId)?.title ?? ''
                  : node.title;
              })()}
            </Text>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={t('common.clear')}
              onPress={() => setSelectedNodeId(null)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <X size={13} color={tc.tint} />
            </TouchableOpacity>
          </View>
        ) : null}
        <View style={styles.toolbarSpacer} />
        <TouchableOpacity
          testID="overview-new-node"
          accessibilityRole="button"
          accessibilityLabel={t('overview.newNode')}
          onPress={addNode}
          style={[styles.addButton, { backgroundColor: tc.tint }]}
        >
          <Plus size={20} color={tc.onTint} strokeWidth={2.6} />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.list}
        contentContainerStyle={[styles.listContent, { paddingBottom: 160 + insets.bottom }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        {rows.map((row) => {
          if (row.node.kind === 'category') {
            const count = taskCounts.get(row.node.id) ?? 0;
            return (
              <Pressable
                key={row.node.id}
                onPress={() => setSelectedNodeId(row.node.id)}
                style={[
                  styles.categoryRow,
                  { marginLeft: row.depth * 14 },
                  selectedNodeId === row.node.id ? { backgroundColor: `${tc.tint}14` } : null,
                ]}
              >
                <Folder size={16} color={tc.tint} strokeWidth={2} style={styles.categoryIcon} />
                {renderCategoryTitle(row.node)}
                <Text style={[styles.categoryCount, { color: tc.secondaryText }]}>{count}</Text>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={`${t('common.edit')}: ${categoryDisplayTitle(row.node)}`}
                  onPress={() => { setSelectedNodeId(row.node.id); void openNodeEditor(row.node); }}
                  style={styles.rowIconButton}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Pencil size={15} color={tc.secondaryText} />
                </TouchableOpacity>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={`${t('common.more')}: ${row.node.title}`}
                  onPress={() => setActionSheet({ kind: 'category', nodeId: row.node.id })}
                  style={styles.rowIconButton}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <MoreHorizontal size={17} color={tc.secondaryText} />
                </TouchableOpacity>
              </Pressable>
            );
          }

          const task = row.task as Task;
          const done = task.status === 'done';
          return (
            <Pressable
              key={row.node.id}
              onPress={() => setSelectedNodeId(row.node.id)}
              style={[
                styles.taskRow,
                { marginLeft: row.depth * 14 },
                selectedNodeId === row.node.id ? { backgroundColor: `${tc.tint}14` } : null,
              ]}
            >
              <TouchableOpacity
                accessibilityRole="checkbox"
                accessibilityState={{ checked: done }}
                accessibilityLabel={`${t('status.done')}: ${task.title}`}
                onPress={() => toggleTaskDone(task)}
                style={styles.checkboxButton}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <View
                  style={[
                    styles.checkbox,
                    {
                      borderColor: done ? tc.success : tc.secondaryText,
                      backgroundColor: done ? tc.success : 'transparent',
                    },
                  ]}
                >
                  {done ? <Check size={11} color={tc.onTint} strokeWidth={3} /> : null}
                </View>
              </TouchableOpacity>
              {renderTaskTitle(row)}
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={`${t('common.edit')}: ${task.title}`}
                onPress={() => { setSelectedNodeId(row.node.id); void openNodeEditor(row.node); }}
                style={styles.rowIconButton}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Pencil size={15} color={tc.secondaryText} />
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={`${t('common.more')}: ${task.title}`}
                onPress={() => setActionSheet({ kind: 'task', nodeId: row.node.id, taskId: task.id })}
                style={styles.rowIconButton}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <MoreHorizontal size={17} color={tc.secondaryText} />
              </TouchableOpacity>
            </Pressable>
          );
        })}

        {rows.length === 0 ? (
          <Text style={[styles.emptyText, { color: tc.secondaryText }]}>{t('overview.empty')}</Text>
        ) : null}

        <View style={styles.footerActions}>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={t('overview.newNode')}
            onPress={addNode}
            style={[styles.footerButton, { borderColor: tc.border }]}
          >
            <Plus size={15} color={tc.tint} />
            <Text style={[styles.footerButtonText, { color: tc.tint }]}>{t('overview.newNode')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="overview-new-area"
            accessibilityRole="button"
            accessibilityLabel={t('overview.newArea')}
            onPress={() => { void addArea(); }}
            style={[styles.footerButton, { borderColor: tc.border }]}
          >
            <Folder size={15} color={tc.secondaryText} />
            <Text style={[styles.footerButtonText, { color: tc.secondaryText }]}>
              {t('overview.newArea')}
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      <Sheet
        visible={Boolean(actionSheet)}
        title={
          actionSheet?.kind === 'category'
            ? (() => { const node = tree.find((candidate) => candidate.id === actionSheet.nodeId); return node ? categoryDisplayTitle(node) : t('common.more'); })()
            : actionSheet?.kind === 'task'
              ? taskById.get(actionSheet.taskId)?.title ?? t('common.more')
              : ''
        }
        closeLabel={t('common.close')}
        bottomInset={insets.bottom}
        onClose={() => setActionSheet(null)}
        tc={tc}
      >
        {actionSheet?.kind === 'category' ? (
          <>
            <SheetOption
              label={t('overview.addChildNode')}
              icon={<Plus size={17} color={tc.tint} />}
              tc={tc}
              onPress={() => addNodeUnder(actionSheet.nodeId)}
            />
            <SheetOption
              label={t('common.rename')}
              icon={<Pencil size={17} color={tc.secondaryText} />}
              tc={tc}
              onPress={() => {
                const node = tree.find((candidate) => candidate.id === actionSheet.nodeId);
                setActionSheet(null);
                if (node) beginTitleEdit({ nodeId: node.id, original: categoryDisplayTitle(node), value: categoryDisplayTitle(node) });
              }}
            />
            <SheetOption
              label={t('common.delete')}
              icon={<Trash2 size={17} color={tc.danger} />}
              destructive
              tc={tc}
              onPress={() => {
                const nodeId = actionSheet.nodeId;
                setActionSheet(null);
                setTimeout(() => removeCategory(nodeId), 0);
              }}
            />
          </>
        ) : actionSheet?.kind === 'task' ? (
          <>
            <SheetOption
              label={t('common.edit')}
              icon={<Pencil size={17} color={tc.secondaryText} />}
              tc={tc}
              onPress={() => {
                const nodeId = actionSheet.nodeId;
                setActionSheet(null);
                const node = treeRef.current.find((candidate) => candidate.id === nodeId);
                if (node) void openNodeEditor(node);
              }}
            />
            <SheetOption
              label={t('overview.moveToCategory')}
              icon={<Folder size={17} color={tc.secondaryText} />}
              tc={tc}
              onPress={() => {
                setMoveSheetNodeId(actionSheet.nodeId);
                setActionSheet(null);
              }}
            />
            <SheetOption
              label={t('common.delete')}
              icon={<Trash2 size={17} color={tc.danger} />}
              destructive
              tc={tc}
              onPress={() => {
                const { nodeId, taskId } = actionSheet;
                setActionSheet(null);
                removeTaskLeaf(nodeId, taskId);
              }}
            />
          </>
        ) : null}
      </Sheet>

      <Sheet
        visible={Boolean(moveSheetNodeId)}
        title={t('overview.moveToCategory')}
        closeLabel={t('common.close')}
        bottomInset={insets.bottom}
        onClose={() => setMoveSheetNodeId(null)}
        tc={tc}
      >
        <ScrollView style={styles.moveList} keyboardShouldPersistTaps="handled">
          <SheetOption
            label={t('overview.rootCategory')}
            icon={<Folder size={17} color={tc.tint} />}
            tc={tc}
            onPress={() => {
              if (moveSheetNodeId) moveNodeToCategory(moveSheetNodeId, null);
            }}
          />
          {rows
            .filter((row) => row.node.kind === 'category')
            .map((row) => (
              <SheetOption
                key={row.node.id}
                label={`${depthPrefix(row.depth)}${row.node.title}`}
                icon={<Folder size={16} color={tc.secondaryText} />}
                tc={tc}
                onPress={() => {
                  if (moveSheetNodeId) moveNodeToCategory(moveSheetNodeId, row.node.id);
                }}
              />
            ))}
        </ScrollView>
      </Sheet>

      <Sheet
        visible={filterVisible}
        title={t('filters.label')}
        closeLabel={t('common.close')}
        bottomInset={insets.bottom}
        onClose={() => setFilterVisible(false)}
        tc={tc}
      >
        <Text style={[styles.filterLabel, { color: tc.secondaryText }]}>
          {t('overview.statusFilter')}
        </Text>
        <View style={styles.chipRow}>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={t('common.all')}
            onPress={() => setFilters(new Set(STATUS_ORDER))}
            style={[
              styles.chip,
              {
                borderColor: activeFilterCount === STATUS_ORDER.length ? tc.tint : tc.border,
                backgroundColor: activeFilterCount === STATUS_ORDER.length ? `${tc.tint}22` : 'transparent',
              },
            ]}
          >
            <Text style={[styles.chipText, { color: tc.text }]}>{t('common.all')}</Text>
          </TouchableOpacity>
          {STATUS_ORDER.map((status) => {
            const selected = filters.has(status);
            return (
              <TouchableOpacity
                key={status}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={t(statusLabelKey(status))}
                onPress={() => {
                  setFilters((current) => {
                    const next = new Set(current);
                    if (next.has(status)) next.delete(status);
                    else next.add(status);
                    return next;
                  });
                }}
                style={[
                  styles.chip,
                  {
                    borderColor: selected ? tc.tint : tc.border,
                    backgroundColor: selected ? `${tc.tint}22` : 'transparent',
                  },
                ]}
              >
                <Text style={[styles.chipText, { color: selected ? tc.tint : tc.text }]}>
                  {t(statusLabelKey(status))}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </Sheet>

      <TaskEditModal
        visible={Boolean(editingTask)}
        task={editingTask}
        lockedDestinationFields={lockedDestinationFields}
        onClose={() => { pendingEditRef.current = null; setEditingTask(null); setLockedDestinationFields([]); }}
        onSave={handleEditorSave}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  toolbarButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  toolbarButtonText: { fontSize: 12, fontWeight: '700' },
  countLabel: { fontSize: 12, fontWeight: '600' },
  toolbarSpacer: { flex: 1 },
  selectedChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 5,
    maxWidth: 140,
  },
  selectedChipText: { fontSize: 11, fontWeight: '700', flexShrink: 1 },
  addButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  list: { flex: 1 },
  listContent: { paddingHorizontal: 12, paddingTop: 10 },
  categoryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 38,
    marginTop: 6,
  },
  categoryIcon: { marginLeft: 2 },
  categoryTitlePressable: { flex: 1, minWidth: 0, paddingVertical: 6 },
  categoryTitle: { fontSize: 14, fontWeight: '800' },
  categoryInput: {
    flex: 1,
    minWidth: 0,
    fontSize: 14,
    fontWeight: '800',
    paddingVertical: 4,
    paddingHorizontal: 0,
  },
  categoryCount: { fontSize: 11, fontWeight: '600', minWidth: 18, textAlign: 'right' },
  taskRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 40,
  },
  checkboxButton: { paddingVertical: 8, paddingHorizontal: 2 },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 5,
    borderWidth: 1.6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  taskTitlePressable: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
  },
  taskPathPrefix: { fontSize: 11, fontWeight: '600', flexShrink: 1 },
  taskTitle: { fontSize: 15, fontWeight: '600', flexShrink: 1 },
  taskTitleInput: {
    flex: 1,
    minWidth: 0,
    fontSize: 15,
    fontWeight: '600',
    paddingVertical: 4,
    paddingHorizontal: 0,
  },
  rowIconButton: {
    width: 30,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  editTaskButton: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: { fontSize: 13, textAlign: 'center', marginTop: 28 },
  footerActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 18,
  },
  footerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  footerButtonText: { fontSize: 12, fontWeight: '700' },
  sheetRoot: { flex: 1, justifyContent: 'flex-end' },
  sheetBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  sheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingHorizontal: 16,
    paddingTop: 14,
    maxHeight: '75%',
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 8,
  },
  sheetTitle: { fontSize: 16, fontWeight: '800', flex: 1 },
  sheetCloseButton: { minWidth: 36, minHeight: 36, alignItems: 'center', justifyContent: 'center' },
  sheetCloseText: { fontSize: 16, fontWeight: '700' },
  sheetOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 46,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sheetOptionText: { fontSize: 14, fontWeight: '600', flex: 1 },
  moveList: { maxHeight: 380 },
  filterLabel: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 4,
    marginBottom: 8,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  chipText: { fontSize: 12, fontWeight: '700' },
});
