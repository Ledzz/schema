import { describe, expect, it } from 'vitest';
import { useEditor } from '../src/store/editor';
import { autorouteProject } from '../src/lib/pcb/actions';
import { autorouteAsync, checkBoardAsync, renderPictureAsync } from '../src/lib/pcb/background';
import { cancelOffloaded, offload, offloading } from '../src/lib/pcb/offload';
import { TASKS } from '../src/lib/pcb/tasks';
import { comp, project } from './fixtures';

const st = () => useEditor.getState();

describe('PCB work off the main thread', () => {
  it('runs the tasks in place where there is no worker', async () => {
    st().loadProject(project({ components: [comp('a', 'res', 'R1', 0, 0)] }));
    expect(typeof Worker).toBe('undefined');
    const issues = await offload('check', st().project);
    expect(Array.isArray(issues)).toBe(true);
    expect(offloading()).toBe(false);
    await expect(offload('render', st().project, {})).rejects.toThrow(/empty/);
    cancelOffloaded();
  });

  it('routing a project leaves the store alone until the result is committed', () => {
    st().loadProject(project({ components: [comp('a', 'res', 'R1', 0, 0)] }));
    const before = st().project;
    const { pcb, report } = autorouteProject(before);
    expect(pcb).toBeNull();
    expect(report).toEqual({ routed: 0, failed: [], planes: 0, planeFailed: [] });
    expect(st().project).toBe(before);
    expect(Object.keys(TASKS).sort()).toEqual(['autoroute', 'check', 'render']);
  });

  it('the page-side helpers resolve through the same path', async () => {
    st().loadProject(project({ components: [comp('a', 'res', 'R1', 0, 0)] }));
    const report = await autorouteAsync();
    expect(report.routed).toBe(0);
    const issues = await checkBoardAsync();
    expect(st().pcbIssues).toBe(issues);
    await expect(renderPictureAsync({})).rejects.toThrow(/pcb_update/);
  });
});
