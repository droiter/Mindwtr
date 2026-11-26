import React from 'react';
import { Alert, TextInput } from 'react-native';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@mindwtr/core';

import OverviewScreen from '../app/(drawer)/(tabs)/overview';

const storageMock = vi.hoisted(() => ({
  getItem: vi.fn(async (_key: string): Promise<string | null> => null),
  setItem: vi.fn(async (_key: string, _value: string): Promise<void> => undefined),
  removeItem: vi.fn(async (_key: string): Promise<void> => undefined),
}));

vi.mock('@/lib/workspace-session-storage', () => ({
  workspaceSessionStorage: storageMock,
}));

const quickCaptureMock = vi.hoisted(() => ({ openQuickCapture: vi.fn() }));

vi.mock('@/contexts/quick-capture-context', () => ({
  useQuickCapture: () => quickCaptureMock,
}));

vi.mock('@/components/task-edit-modal', () => ({
  TaskEditModal: (props: { visible: boolean; task: Task | null }) => React.createElement('TaskEditModal', props),
}));

vi.mock('@/contexts/language-context', () => {
  const translations: Record<string, string> = {
    'nav.addTask': 'Add Task',
    'common.add': 'Add',
    'common.all': 'All',
    'common.cancel': 'Cancel',
    'common.clear': 'Clear',
    'common.close': 'Close',
    'common.delete': 'Delete',
    'common.edit': 'Edit',
    'common.more': 'More',
    'common.rename': 'Rename',
    'filters.label': 'Filters',
    'overview.inbox': 'Inbox',
    'overview.category': 'Category',
    'overview.newCategory': 'New category',
    'overview.moveToCategory': 'Move to category',
    'overview.empty': 'No tasks',
    'overview.taskPlaceholder': 'New task',
    'overview.categoryPlaceholder': 'Category name',
    'overview.statusFilter': 'Status',
    'overview.rootCategory': 'Root',
    'overview.newNode': 'New node',
    'overview.addChildNode': 'Add child node',
    'overview.newSiblingNode': 'New sibling node',
    'overview.convertNeedsLeaf': 'Only categories without children can become tasks',
    'overview.newArea': 'New area',
    'overview.areaNameDefault': 'New area',
    'status.inbox': 'Inbox',
    'status.next': 'Next',
    'status.waiting': 'Waiting',
    'status.someday': 'Someday',
    'status.reference': 'Reference',
    'status.done': 'Done',
  };
  return {
    useLanguage: () => ({
      t: (key: string) => translations[key] ?? key,
      language: 'en',
    }),
  };
});

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#0f172a',
    cardBg: '#111827',
    taskItemBg: '#111827',
    inputBg: '#111827',
    filterBg: '#1f2937',
    border: '#334155',
    text: '#f8fafc',
    secondaryText: '#94a3b8',
    icon: '#94a3b8',
    tint: '#60a5fa',
    onTint: '#ffffff',
    tabIconDefault: '#94a3b8',
    tabIconSelected: '#60a5fa',
    danger: '#f87171',
    success: '#34d399',
    warning: '#fbbf24',
  }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock('lucide-react-native', () => {
  const Icon = (props: Record<string, unknown>) => React.createElement('Icon', props);
  return {
    Check: Icon,
    CornerDownRight: Icon,
    Folder: Icon,
    MoreHorizontal: Icon,
    Pencil: Icon,
    Plus: Icon,
    SlidersHorizontal: Icon,
    Trash2: Icon,
    X: Icon,
  };
});

const now = '2026-11-24T00:00:00.000Z';

const makeTask = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id}`,
  status: 'inbox',
  tags: [],
  contexts: [],
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

function nodeText(node: ReactTestInstance): string {
  const children = node.props?.children;
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) {
    return children.map((child) => (typeof child === 'string' ? child : '')).join('');
  }
  return '';
}

const findByText = (tree: ReturnType<typeof create>, text: string) => (
  tree.root.findAll((node) => typeof node.type === 'string' && nodeText(node) === text)
);

const findByLabel = (tree: ReturnType<typeof create>, label: string) => (
  tree.root.findAll((node) => node.props?.accessibilityLabel === label)
);

async function renderScreen() {
  let tree!: ReturnType<typeof create>;
  await act(async () => {
    tree = create(<OverviewScreen />);
    await Promise.resolve();
  });
  return tree;
}

describe('OverviewScreen task tree', () => {
  let core: typeof import('@mindwtr/core');

  beforeEach(async () => {
    core = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
    core.resetForTests();
    core.setStorageAdapter(core.noopStorage);
    storageMock.getItem.mockReset();
    storageMock.getItem.mockResolvedValue(null);
    storageMock.setItem.mockClear();
    quickCaptureMock.openQuickCapture.mockClear();
  });

  const seed = (tasks: Task[], extras: Record<string, unknown> = {}) => {
    core.useTaskStore.setState({
      tasks,
      _allTasks: tasks,
      _tasksById: new Map(tasks.map((task) => [task.id, task])),
      projects: [],
      _allProjects: [],
      areas: [],
      _allAreas: [],
      isLoading: false,
      ...extras,
    } as never);
  };

  it('shows all tasks under the inbox category by default', async () => {
    seed([makeTask('a'), makeTask('b', { status: 'next' })]);
    const tree = await renderScreen();
    expect(findByText(tree, 'Inbox').length).toBeGreaterThan(0);
    expect(findByText(tree, 'Task a').length).toBe(1);
    expect(findByText(tree, 'Task b').length).toBe(1);
  });

  it('auto-places tasks under their area and project path', async () => {
    seed([makeTask('p', { projectId: 'proj-1' })], {
      projects: [{ id: 'proj-1', title: 'Website', areaId: 'area-1', status: 'active', color: '#000', order: 0, createdAt: now, updatedAt: now }],
      _allProjects: [{ id: 'proj-1', title: 'Website', areaId: 'area-1', status: 'active', color: '#000', order: 0, createdAt: now, updatedAt: now }],
      areas: [{ id: 'area-1', name: 'Work', color: '#000', order: 0, createdAt: now, updatedAt: now }],
      _allAreas: [{ id: 'area-1', name: 'Work', color: '#000', order: 0, createdAt: now, updatedAt: now }],
    });
    const tree = await renderScreen();
    expect(findByText(tree, 'Work').length).toBeGreaterThan(0);
    expect(findByText(tree, 'Website').length).toBeGreaterThan(0);
    expect(findByText(tree, 'Task p').length).toBe(1);
  });

  it('toggles a task done through the checkbox and reflects it in the store', async () => {
    seed([makeTask('t1')]);
    const tree = await renderScreen();
    const checkbox = findByLabel(tree, 'Done: Task t1')[0];
    await act(async () => {
      checkbox.props.onPress();
      await Promise.resolve();
    });
    const updated = core.useTaskStore.getState()._allTasks.find((task) => task.id === 't1');
    expect(updated?.status).toBe('done');
  });

  it('opens the task editor from the pencil button', async () => {
    seed([makeTask('t1')]);
    const tree = await renderScreen();
    const editButton = findByLabel(tree, 'Edit: Task t1')[0];
    await act(async () => {
      editButton.props.onPress();
      await Promise.resolve();
    });
    const modal = tree.root.findAll((node) => String(node.type) === 'TaskEditModal');
    expect(modal.length).toBe(1);
    expect(modal[0].props.visible).toBe(true);
    expect(modal[0].props.task?.id).toBe('t1');
  });

  it('filters done tasks out when their status is deselected', async () => {
    seed([makeTask('done-1', { status: 'done' }), makeTask('next-1', { status: 'next' })]);
    const tree = await renderScreen();
    expect(findByText(tree, 'Task done-1').length).toBe(1);

    act(() => {
      findByLabel(tree, 'Filters')[0].props.onPress();
    });
    act(() => {
      findByLabel(tree, 'Done')[0].props.onPress();
    });
    expect(findByText(tree, 'Task done-1').length).toBe(0);
    expect(findByText(tree, 'Task next-1').length).toBe(1);
  });

  it('selects a node on the first tap and edits the title on the second tap', async () => {
    seed([makeTask('t1', { title: 'Old title' })]);
    const tree = await renderScreen();
    await act(async () => {
      findByLabel(tree, 'Old title')[0].props.onPress();
      await Promise.resolve();
    });
    expect(tree.root.findAllByType(TextInput)).toHaveLength(0);

    await act(async () => {
      findByLabel(tree, 'Old title')[0].props.onPress();
      await Promise.resolve();
    });
    const input = tree.root.findByType(TextInput);
    act(() => {
      input.props.onChangeText('New title');
    });
    await act(async () => {
      input.props.onSubmitEditing();
      await Promise.resolve();
    });
    const updated = core.useTaskStore.getState()._allTasks.find((task) => task.id === 't1');
    expect(updated?.title).toBe('New title');
  });

  it('commits the inline edit when tapping another node', async () => {
    seed([makeTask('t1', { title: 'One' }), makeTask('t2', { title: 'Two' })]);
    const tree = await renderScreen();
    await act(async () => {
      findByLabel(tree, 'One')[0].props.onPress();
      await Promise.resolve();
    });
    await act(async () => {
      findByLabel(tree, 'One')[0].props.onPress();
      await Promise.resolve();
    });
    const input = tree.root.findByType(TextInput);
    act(() => {
      input.props.onChangeText('Uno');
    });
    await act(async () => {
      findByLabel(tree, 'Two')[0].props.onPress();
      await Promise.resolve();
    });
    expect(tree.root.findAllByType(TextInput)).toHaveLength(0);
    const updated = core.useTaskStore.getState()._allTasks.find((task) => task.id === 't1');
    expect(updated?.title).toBe('Uno');
  });

  it('commits the inline edit when tapping the blank list area', async () => {
    seed([makeTask('t1', { title: 'One' })]);
    const tree = await renderScreen();
    await act(async () => {
      findByLabel(tree, 'One')[0].props.onPress();
      await Promise.resolve();
    });
    await act(async () => {
      findByLabel(tree, 'One')[0].props.onPress();
      await Promise.resolve();
    });
    const input = tree.root.findByType(TextInput);
    act(() => {
      input.props.onChangeText('Uno');
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'overview-list-body' }).props.onPress();
      await Promise.resolve();
    });
    expect(tree.root.findAllByType(TextInput)).toHaveLength(0);
    const updated = core.useTaskStore.getState()._allTasks.find((task) => task.id === 't1');
    expect(updated?.title).toBe('Uno');
  });

  it('turns a leaf category into a task through the edit button, inheriting its title', async () => {
    seed([]);
    const tree = await renderScreen();
    await act(async () => {
      findByLabel(tree, 'Add child node')[0].props.onPress();
      await Promise.resolve();
    });
    const input = tree.root.findByType(TextInput);
    act(() => {
      input.props.onChangeText('Work');
    });
    await act(async () => {
      input.props.onSubmitEditing();
      await Promise.resolve();
    });
    expect(core.useTaskStore.getState()._allTasks).toHaveLength(0);

    act(() => {
      findByLabel(tree, 'Edit: Work')[0].props.onPress();
    });
    let modal = tree.root.findAll((node) => String(node.type) === 'TaskEditModal');
    expect(modal[0].props.visible).toBe(true);
    expect(modal[0].props.task.title).toBe('Work');
    expect(core.useTaskStore.getState()._allTasks).toHaveLength(0);

    await act(async () => {
      await modal[0].props.onSave('draft', { title: 'Work' });
      await Promise.resolve();
    });
    const tasks = core.useTaskStore.getState()._allTasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Work');
    expect(tree.root.findAll((node) => (
      String(node.type) === 'TouchableOpacity' && node.props.accessibilityRole === 'checkbox'
    ))).toHaveLength(1);
    expect(findByLabel(tree, 'More: Inbox')).toHaveLength(0);
  });

  it('creates unique top-level areas', async () => {
    seed([]);
    const tree = await renderScreen();
    await act(async () => {
      tree.root.findByProps({ testID: 'overview-new-area' }).props.onPress();
      await Promise.resolve();
    });
    expect(core.useTaskStore.getState().areas.map((area) => area.name)).toContain('New area');
    let input = tree.root.findByType(TextInput);
    expect(input.props.value).toBe('New area');
    await act(async () => {
      input.props.onSubmitEditing();
      await Promise.resolve();
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'overview-new-area' }).props.onPress();
      await Promise.resolve();
    });
    input = tree.root.findByType(TextInput);
    expect(input.props.value).toBe('New area 2');
  });

  it('keeps the in-progress node title when creating the next node', async () => {
    seed([]);
    const tree = await renderScreen();
    await act(async () => {
      findByLabel(tree, 'Add child node')[0].props.onPress();
      await Promise.resolve();
    });
    let input = tree.root.findByType(TextInput);
    act(() => {
      input.props.onChangeText('Work A');
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'overview-new-node' }).props.onPress();
      await Promise.resolve();
    });
    expect(findByText(tree, 'Work A').length).toBeGreaterThan(0);
    input = tree.root.findByType(TextInput);
    expect(input.props.value).toBe('');
  });

  it('renames the bound Area when its area node is renamed', async () => {
    seed([]);
    const tree = await renderScreen();
    await act(async () => {
      tree.root.findByProps({ testID: 'overview-new-area' }).props.onPress();
      await Promise.resolve();
    });
    let input = tree.root.findByType(TextInput);
    act(() => {
      input.props.onChangeText('Work');
    });
    await act(async () => {
      input.props.onSubmitEditing();
      await Promise.resolve();
    });
    expect(core.useTaskStore.getState().areas.map((area) => area.name)).toContain('Work');

    act(() => {
      findByLabel(tree, 'Clear')[0].props.onPress();
    });
    await act(async () => {
      findByLabel(tree, 'Work')[0].props.onPress();
      await Promise.resolve();
    });
    expect(tree.root.findAllByType(TextInput)).toHaveLength(0);
    await act(async () => {
      findByLabel(tree, 'Work')[0].props.onPress();
      await Promise.resolve();
    });
    input = tree.root.findByType(TextInput);
    act(() => {
      input.props.onChangeText('Work 2');
    });
    await act(async () => {
      input.props.onSubmitEditing();
      await Promise.resolve();
    });
    const names = core.useTaskStore.getState().areas.map((area) => area.name);
    expect(names).toContain('Work 2');
    expect(names).not.toContain('Work');
  });

  it('inherits the area and project from the node path when editing a leaf', async () => {
    seed([]);
    const tree = await renderScreen();
    await act(async () => {
      tree.root.findByProps({ testID: 'overview-new-node' }).props.onPress();
      await Promise.resolve();
    });
    let input = tree.root.findByType(TextInput);
    act(() => {
      input.props.onChangeText('Work');
    });
    await act(async () => {
      input.props.onSubmitEditing();
      await Promise.resolve();
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'overview-new-node' }).props.onPress();
      await Promise.resolve();
    });
    input = tree.root.findByType(TextInput);
    act(() => {
      input.props.onChangeText('Team');
    });
    await act(async () => {
      input.props.onSubmitEditing();
      await Promise.resolve();
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'overview-new-node' }).props.onPress();
      await Promise.resolve();
    });
    input = tree.root.findByType(TextInput);
    act(() => {
      input.props.onChangeText('Project');
    });
    await act(async () => {
      input.props.onSubmitEditing();
      await Promise.resolve();
    });
    act(() => {
      findByLabel(tree, 'Edit: Project')[0].props.onPress();
    });
    const modal = tree.root.findAll((node) => String(node.type) === 'TaskEditModal');
    expect(modal[0].props.lockedDestinationFields).toEqual(expect.arrayContaining(['area', 'project']));
    await act(async () => {
      await modal[0].props.onSave('draft', { title: 'Project' });
      await Promise.resolve();
    });
    const state = core.useTaskStore.getState();
    const created = state._allTasks.find((task) => task.title === 'Project');
    expect(created).toBeTruthy();
    expect(created?.projectId).toBeTruthy();
    const project = state._allProjects.find((candidate) => candidate.id === created?.projectId);
    const area = state.areas.find((candidate) => candidate.name === 'Work');
    expect(project?.title).toBe('Work / Team');
    expect(project?.areaId).toBe(area?.id);
    expect(state.areas.map((candidate) => candidate.name)).toContain('Work');
    expect(state.projects.map((candidate) => candidate.title)).toContain('Work / Team');
  });

  it('deletes the bound store Area when the area node is deleted', async () => {
    seed([]);
    const tree = await renderScreen();
    await act(async () => {
      tree.root.findByProps({ testID: 'overview-new-area' }).props.onPress();
      await Promise.resolve();
    });
    const area = core.useTaskStore.getState().areas[0];
    expect(area?.name).toBe('New area');

    const alertSpy = vi.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      const destructive = buttons?.find((button) => button.style === 'destructive');
      destructive?.onPress?.();
    });
    act(() => {
      findByLabel(tree, 'More: New area')[0].props.onPress();
    });
    await act(async () => {
      findByLabel(tree, 'Delete')[0].props.onPress();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    alertSpy.mockRestore();
    expect(core.useTaskStore.getState().areas).toHaveLength(0);
    expect(findByLabel(tree, 'More: New area')).toHaveLength(0);
  });

  it('removes an area node when its Area is deleted elsewhere', async () => {
    seed([]);
    const tree = await renderScreen();
    await act(async () => {
      tree.root.findByProps({ testID: 'overview-new-area' }).props.onPress();
      await Promise.resolve();
    });
    const area = core.useTaskStore.getState().areas[0];
    await act(async () => {
      await core.useTaskStore.getState().deleteArea(area.id);
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(findByLabel(tree, 'More: New area')).toHaveLength(0);
  });

  it('avoids duplicate default titles among siblings', async () => {
    seed([]);
    const tree = await renderScreen();
    await act(async () => {
      tree.root.findByProps({ testID: 'overview-new-node' }).props.onPress();
      await Promise.resolve();
    });
    let input = tree.root.findByType(TextInput);
    expect(input.props.value).toBe('');
    await act(async () => {
      input.props.onSubmitEditing();
      await Promise.resolve();
    });
    act(() => {
      findByLabel(tree, 'Clear')[0].props.onPress();
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'overview-new-node' }).props.onPress();
      await Promise.resolve();
    });
    input = tree.root.findByType(TextInput);
    await act(async () => {
      input.props.onSubmitEditing();
      await Promise.resolve();
    });
    expect(findByText(tree, 'New node 2').length).toBeGreaterThan(0);
  });

  it('creates a sibling node directly after the selected node', async () => {
    seed([]);
    const tree = await renderScreen();

    const addTopLevelNode = async (title: string) => {
      await act(async () => {
        findByLabel(tree, 'Add child node')[0].props.onPress();
        await Promise.resolve();
      });
      const input = tree.root.findByType(TextInput);
      act(() => {
        input.props.onChangeText(title);
      });
      await act(async () => {
        input.props.onSubmitEditing();
        await Promise.resolve();
      });
      act(() => {
        findByLabel(tree, 'Clear')[0].props.onPress();
      });
    };

    await addTopLevelNode('A');
    await addTopLevelNode('B');

    await act(async () => {
      findByLabel(tree, 'A')[0].props.onPress();
      await Promise.resolve();
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'overview-new-sibling' }).props.onPress();
      await Promise.resolve();
    });
    const input = tree.root.findByType(TextInput);
    act(() => {
      input.props.onChangeText('C');
    });
    await act(async () => {
      input.props.onSubmitEditing();
      await Promise.resolve();
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    const treeWrites = storageMock.setItem.mock.calls
      .filter(([key]) => key === 'mindwtr:overview:tree:v2');
    const saved = JSON.parse(String(treeWrites.at(-1)?.[1]));
    const rootCategories = saved.nodes
      .filter((node: { kind: string; parentId: string | null }) => (
        node.kind === 'category' && node.parentId === null
      ))
      .sort((a: { order: number }, b: { order: number }) => a.order - b.order)
      .map((node: { title: string }) => node.title);
    expect(rootCategories).toEqual(['B', 'A', 'C']);
  });
});
