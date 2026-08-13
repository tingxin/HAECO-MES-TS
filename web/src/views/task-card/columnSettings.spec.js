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

it('migrates the old complete column layout and appends new Section 29 columns without losing preferences', () => {
  localStorage.clear();
  const old = cloneDefaultColumns().filter(({ key }) => !['revisionDate', 'documentType', 'referenceNo', 'cmmRevision'].includes(key));
  old.find(({ key }) => key === 'title').visible = false;
  localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(old.map(({ key, visible, fixed }) => ({ key, visible, fixed }))));
  const migrated = loadColumns();
  expect(migrated.find(({ key }) => key === 'title').visible).toBe(false);
  expect(migrated.slice(-4).map(({ key }) => key)).toEqual(['revisionDate', 'documentType', 'referenceNo', 'cmmRevision']);
});
