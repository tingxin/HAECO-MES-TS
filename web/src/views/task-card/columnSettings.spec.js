import { beforeEach, describe, expect, it } from 'vitest';
import { COLUMN_STORAGE_KEY, cloneDefaultColumns, loadColumns, saveColumns } from './columnSettings.js';

describe('task-card column settings persistence', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips visibility, order, and fixed settings', () => {
    const columns = cloneDefaultColumns().reverse();
    columns[0].visible = false;
    columns[1].fixed = 'right';

    expect(saveColumns(columns)).toBe(true);
    const restored = loadColumns();

    expect(restored.map(({ key }) => key)).toEqual(columns.map(({ key }) => key));
    expect(restored[0]).toMatchObject({ visible: false });
    expect(restored[1]).toMatchObject({ fixed: 'right' });
  });

  it.each([
    '{malformed',
    JSON.stringify([{ key: 'unknown', visible: true, fixed: false }]),
    JSON.stringify([{ key: 'taskNo', visible: 'yes', fixed: 'middle' }]),
  ])('falls back to defaults for malformed storage: %s', (raw) => {
    localStorage.setItem(COLUMN_STORAGE_KEY, raw);
    expect(loadColumns()).toEqual(cloneDefaultColumns());
  });

  it('falls back when storage access throws', () => {
    const brokenStorage = { getItem: () => { throw new Error('denied'); } };
    expect(loadColumns(brokenStorage)).toEqual(cloneDefaultColumns());
  });
});