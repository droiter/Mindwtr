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
    fireEvent.click(await screen.findByRole('button', { name: 'New node' }));
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
    fireEvent.click(await screen.findByRole('button', { name: 'New node' }));
    const input = await screen.findByPlaceholderText('Category name');
    fireEvent.change(input, { target: { value: 'Work' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await screen.findByRole('button', { name: 'Edit: Work' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit: Work' }));
    expect(useTaskStore.getState()._allTasks).toHaveLength(0);
    expect(useUiStore.getState().editingTaskId).toBeNull();
  });
});
