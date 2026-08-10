import { describe, expect, it } from 'vitest';
import router from './index.js';

describe('application routes smoke', () => {
  it('registers every real screen and resolves JOB parameters', () => {
    const names = new Set(router.getRoutes().map((route) => route.name).filter(Boolean));
    for (const name of ['task-card-list', 'task-card-editor', 'task-card-step', 'job', 'config', 'identity']) {
      expect(names).toContain(name);
    }

    const resolved = router.resolve('/job/JOB-001');
    expect(resolved.name).toBe('job');
    expect(resolved.params.jobNo).toBe('JOB-001');
  });

  it('imports the lazy JOB and config views as real Vue components', async () => {
    for (const name of ['job', 'config']) {
      const route = router.getRoutes().find((candidate) => candidate.name === name);
      const module = await route.components.default();
      expect(module.default).toBeTruthy();
      expect(module.default.__name).toBeTruthy();
    }
  });
});