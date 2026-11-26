import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Task } from '@mindwtr/core';
import { useTaskStore } from '@mindwtr/core';
import { useUiStore } from '../../store/ui-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../../contexts/language-context';
import { OverviewView } from './OverviewView';

vi.mock('../TaskItem', () => ({
  TaskItem: ({ task }: { task: Task }) => (
    <div data-testid={`task-item-${task.id}`}>{task.title}</div>
  ),
}));

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

const renderOverview = () => render(
  <LanguageProvider>
    <OverviewView />
  </LanguageProvider>,
);

const seed = (tasks: Task[]) => {
  useTaskStore.setState({
    tasks,
    _allTasks: tasks,
    _tasksById: new Map(tasks.map((task) => [task.id, task])),
    projects: [],
    _allProjects: [],
    areas: [],
    _allAreas: [],
    isLoading: false,
  } as never);
};

describe('OverviewView', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    window.localStorage.clear();
    seed([]);
  });

  it('shows all tasks under the default inbox category', async () => {
    seed([makeTask('a'), makeTask('b', { status: 'next' })]);
    renderOverview();
    expect((await screen.findAllByText(/Inbox|收件箱|收集箱/)).length).toBeGreaterThan(0);
    expect(await screen.findByTestId('task-item-a')).toBeTruthy();
    expect(await screen.findByTestId('task-item-b')).toBeTruthy();
  });

  it('toggles a task done through the checkbox', async () => {
    seed([makeTask('a')]);
    renderOverview();
    const checkbox = await screen.findByRole('button', { name: 'Done: Task a' });
    fireEvent.click(checkbox);
    const updated = useTaskStore.getState()._allTasks.find((task) => task.id === 'a');
    expect(updated?.status).toBe('done');
  });

  it('hides done tasks when the Done filter is turned off', async () => {
    seed([makeTask('done', { status: 'done' }), makeTask('next', { status: 'next' })]);
    renderOverview();
    expect(await screen.findByTestId('task-item-done')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Done', pressed: true }));
    expect(screen.queryByTestId('task-item-done')).toBeNull();
    expect(screen.getByTestId('task-item-next')).toBeTruthy();
  });

  it('creates a category from the toolbar', async () => {
    renderOverview();
    fireEvent.click(await screen.findByRole('button', { name: 'Add child node' }));
    const input = await screen.findByPlaceholderText('Category name');
    fireEvent.change(input, { target: { value: 'Work' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect((await screen.findAllByText('Work')).length).toBeGreaterThan(0);
  });

  it('creates unique top-level areas', async () => {
    renderOverview();
    fireEvent.click((await screen.findAllByRole('button', { name: 'New area' }))[0]);
    expect(useTaskStore.getState().areas.some((area) => area.name === 'New area')).toBe(true);
    let input = await screen.findByDisplayValue('New area');
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getAllByRole('button', { name: 'New area' })[0]);
    input = await screen.findByDisplayValue('New area 2');
    expect(input).toBeTruthy();
  });

  it('deletes the bound Area when the area node is deleted', async () => {
    renderOverview();
    fireEvent.click(await screen.findByRole('button', { name: 'New area' }));
    await screen.findByRole('button', { name: 'Delete: New area' });
    const area = useTaskStore.getState().areas[0];
    expect(area.name).toBe('New area');
    fireEvent.click(screen.getByRole('button', { name: 'Delete: New area' }));
    expect(useTaskStore.getState().areas).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Delete: New area' })).toBeNull();
  });

  it('removes an area node when its Area is deleted elsewhere', async () => {
    renderOverview();
    fireEvent.click(await screen.findByRole('button', { name: 'New area' }));
    await screen.findByRole('button', { name: 'Delete: New area' });
    const area = useTaskStore.getState().areas[0];
    await act(async () => {
      await useTaskStore.getState().deleteArea(area.id);
    });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Delete: New area' })).toBeNull();
    });
  });

  it('does not write task data when opening the editor for a category', async () => {
    renderOverview();
    fireEvent.click(await screen.findByRole('button', { name: 'Add child node' }));
    const input = await screen.findByPlaceholderText('Category name');
    fireEvent.change(input, { target: { value: 'Work' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await screen.findByRole('button', { name: 'Edit: Work' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit: Work' }));
    expect(useTaskStore.getState()._allTasks).toHaveLength(0);
    expect(useUiStore.getState().editingTaskId).toBeNull();
  });

  const createCategory = async (title: string) => {
    const buttons = await screen.findAllByRole('button', { name: 'Add child node' });
    fireEvent.click(buttons[0]);
    const input = await screen.findByPlaceholderText('Category name');
    fireEvent.change(input, { target: { value: title } });
    fireEvent.keyDown(input, { key: 'Enter' });
  };

  it('selects a node on the first click and edits its title on the second click', async () => {
    renderOverview();
    await createCategory('Work');
    fireEvent.click(await screen.findByRole('button', { name: 'New sibling node' }));
    let input = await screen.findByPlaceholderText('Category name');
    fireEvent.change(input, { target: { value: 'Home' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    fireEvent.click(await screen.findByRole('button', { name: 'Work' }));
    expect(screen.queryByPlaceholderText('Category name')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Work' }));
    input = await screen.findByPlaceholderText('Category name');
    expect(input).toBeTruthy();
  });

  it('commits the inline edit when clicking the blank list area', async () => {
    renderOverview();
    await createCategory('Work');
    fireEvent.click(screen.getByRole('button', { name: 'Work' }));
    const input = await screen.findByPlaceholderText('Category name');
    fireEvent.change(input, { target: { value: 'Work 2' } });
    fireEvent.mouseDown(screen.getByTestId('overview-list'));
    expect(screen.queryByPlaceholderText('Category name')).toBeNull();
    expect((await screen.findAllByText('Work 2')).length).toBeGreaterThan(0);
  });

  it('collapses and expands the whole subtree when clicking a middle node', async () => {
    seed([makeTask('p', { projectId: 'proj-1' })]);
    useTaskStore.setState({
      projects: [{ id: 'proj-1', title: 'Website', areaId: 'area-1', status: 'active', color: '#000', order: 0, createdAt: now, updatedAt: now }],
      _allProjects: [{ id: 'proj-1', title: 'Website', areaId: 'area-1', status: 'active', color: '#000', order: 0, createdAt: now, updatedAt: now }],
      areas: [{ id: 'area-1', name: 'Work', color: '#000', order: 0, createdAt: now, updatedAt: now }],
      _allAreas: [{ id: 'area-1', name: 'Work', color: '#000', order: 0, createdAt: now, updatedAt: now }],
    } as never);
    renderOverview();
    expect(await screen.findByTestId('task-item-p')).toBeTruthy();

    fireEvent.click(await screen.findByRole('button', { name: 'Work' }));
    expect(screen.queryByTestId('task-item-p')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Website' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Work' }));
    expect(await screen.findByTestId('task-item-p')).toBeTruthy();
  });

  it('creates a sibling node directly after the selected node', async () => {
    renderOverview();
    await createCategory('Work');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await createCategory('Home');

    fireEvent.click(await screen.findByRole('button', { name: 'Work' }));
    fireEvent.click(screen.getByRole('button', { name: 'New sibling node' }));
    const input = await screen.findByPlaceholderText('Category name');
    fireEvent.change(input, { target: { value: 'Middle' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      const saved = window.localStorage.getItem('mindwtr:overview:tree:v2');
      expect(saved).toBeTruthy();
      const nodes = JSON.parse(String(saved)).nodes as Array<{
        kind: string;
        parentId: string | null;
        order: number;
        title: string;
      }>;
      const roots = nodes
        .filter((node) => node.kind === 'category' && node.parentId === null)
        .sort((a, b) => a.order - b.order)
        .map((node) => node.title);
      expect(roots).toEqual(['Home', 'Work', 'Middle']);
    });
  });
});
