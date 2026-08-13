import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus, { ElMessageBox } from 'element-plus';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ImageAnnotationEditor from './ImageAnnotationEditor.vue';
import ProcessComponentEditor from './ProcessComponentEditor.vue';
import ProcessStepList from './ProcessStepList.vue';
import VersionHistoryPanel from './VersionHistoryPanel.vue';
import { structuredPayload } from './structuredPayload.js';
import { usePermissionStore } from '../../stores/permission.js';

const mocks = vi.hoisted(() => ({
  copy: vi.fn(), create: vi.fn(), remove: vi.fn(), reorder: vi.fn(), importSteps: vi.fn(), downloadImportTemplate: vi.fn(),
  listVersions: vi.fn(), getVersionSnapshot: vi.fn(), getVersionDiff: vi.fn(), printVersion: vi.fn(),
}));
vi.mock('../../api/stepApi.js', () => ({ stepApi: {
  copy: mocks.copy, create: mocks.create, remove: mocks.remove, reorder: mocks.reorder,
  importSteps: mocks.importSteps, downloadImportTemplate: mocks.downloadImportTemplate,
} }));
vi.mock('../../api/taskCardApi.js', () => ({ taskCardApi: {
  listVersions: mocks.listVersions, getVersionSnapshot: mocks.getVersionSnapshot,
  getVersionDiff: mocks.getVersionDiff, printVersion: mocks.printVersion,
} }));

function piniaWith(permissions = ['card_edit', 'card_print_export']) {
  const pinia = createPinia(); setActivePinia(pinia); usePermissionStore().permissions = permissions; return pinia;
}
const mountElement = (component, options = {}) => mount(component, {
  ...options, global: { plugins: [ElementPlus, piniaWith()], ...(options.global || {}) }, attachTo: document.body,
});

beforeEach(() => { vi.clearAllMocks(); document.body.innerHTML = ''; });

describe('Section 29 structured payload and annotations', () => {
  it('normalizes legacy table aliases and strips non-contract image data', () => {
    expect(structuredPayload('tool', { toolPn: 'T-1', toolDesc: 'Torque wrench' })).toEqual({ rows: [{ partNo: 'T-1', description: 'Torque wrench' }] });
    expect(structuredPayload('consumable', { materialNo: 'M-1', desc: 'Grease', quantity: 2, unit: 'tube' })).toEqual({ rows: [{ partNo: 'M-1', description: 'Grease', qty: '2', category: 'tube' }] });
    expect(structuredPayload('image', { attachmentId: 7, url: '/api/attachments/7', originalBase64: 'data:image/png;base64,AAAA', annotations: [
      { type: 'rectangle', path: [[-1, 0.2], [2, 0.8]], color: 'red' },
    ] })).toEqual({ attachmentId: 7, url: '/api/attachments/7', annotations: [
      expect.objectContaining({ type: 'rect', points: [[0, 0.2], [1, 0.8]], color: 'red' }),
    ] });
  });

  it('supports normalized drawing, undo, reset, and readonly overlay display', async () => {
    const wrapper = mountElement(ImageAnnotationEditor, { props: { modelValue: { attachmentId: 7, url: '/image.png', annotations: [] } } });
    wrapper.vm.$refs.svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100 });
    wrapper.vm.tool = 'arrow'; wrapper.vm.pointerDown({ clientX: 20, clientY: 20, pointerId: 1 });
    wrapper.vm.pointerUp({ clientX: 180, clientY: 80, pointerId: 1 }); await wrapper.vm.$nextTick();
    const drawn = wrapper.emitted('update:modelValue').at(-1)[0];
    expect(drawn).toMatchObject({ attachmentId: 7, annotations: [
      expect.objectContaining({ type: 'arrow', points: [[0.1, 0.2], [0.9, 0.8]] }),
    ] });
    await wrapper.setProps({ modelValue: drawn }); expect(wrapper.vm.history).toHaveLength(1);
    wrapper.vm.undo(); expect(wrapper.emitted('update:modelValue').at(-1)[0].annotations).toEqual([]);
    await wrapper.setProps({ readonly: true, modelValue: { attachmentId: 7, url: '/image.png', annotations: [{ type: 'text', points: [[0.2, 0.3]], color: 'blue', text: 'CHECK' }] } });
    expect(wrapper.get('[data-testid="annotation-overlay"]').text()).toContain('CHECK');
    expect(wrapper.find('[data-testid="annotation-tools"]').exists()).toBe(false); wrapper.unmount();
  });

  it('edits old tool payload as canonical rows with add/remove controls', async () => {
    const wrapper = mountElement(ProcessComponentEditor, { props: { modelValue: { type: 'tool', payload: { name: 'T-1', details: 'Legacy tool' } } } });
    expect(wrapper.get('[data-testid="structured-payload-editor"]').text()).toContain('Part No.');
    await wrapper.get('[data-testid="add-structured-row"]').trigger('click');
    expect(wrapper.emitted('update:modelValue').at(-1)[0].payload.rows).toHaveLength(2);
    wrapper.unmount();
  });
});
describe('Section 29 step arrangement and import', () => {
  async function mountSteps(permissions = ['card_edit']) {
    const pinia = piniaWith(permissions);
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: '/', component: { template: '<div />' } }, { path: '/step', name: 'task-card-step', component: { template: '<div />' } },
    ] });
    await router.push('/'); await router.isReady();
    return mount(ProcessStepList, { props: { cardId: 7, rows: [{ id: 1, processId: 'A' }, { id: 2, processId: 'B' }] }, global: { plugins: [pinia, router, ElementPlus] } });
  }
  it('uses exact copy/reorder/delete contracts with mandatory reasons and final-step guard', async () => {
    mocks.copy.mockResolvedValue({ id: 3 }); mocks.reorder.mockResolvedValue([]); mocks.remove.mockResolvedValue({ id: 2 });
    const wrapper = await mountSteps();
    await wrapper.vm.copy({ id: 1, processId: 'A' }, 'deep copy');
    await wrapper.vm.move({ id: 1 }, 1, 'reorder');
    await wrapper.vm.remove({ id: 2 }, 'delete duplicate');
    expect(mocks.copy).toHaveBeenCalledWith(7, 1, { reason: 'deep copy' });
    expect(mocks.reorder).toHaveBeenCalledWith(7, { orderedStepIds: [2, 1], reason: 'reorder' });
    expect(mocks.remove).toHaveBeenCalledWith(7, 2, { reason: 'delete duplicate' });
    await wrapper.setProps({ rows: [{ id: 1, processId: 'A' }] }); await wrapper.vm.remove({ id: 1 }, 'cannot');
    expect(mocks.remove).toHaveBeenCalledTimes(1); expect(wrapper.get('[data-testid="delete-step"]').attributes('title')).toBe('至少保留一道工序');
    wrapper.unmount();
  });

  it('submits append/replace multipart options, confirms replace, and exposes returned counts', async () => {
    const wrapper = await mountSteps(); const file = new File(['xlsx'], 'steps.xlsx');
    mocks.importSteps.mockResolvedValue({ mode: 'append', successCount: 1, failureCount: 0, totalCount: 1, records: [{ rowNo: 2, status: 'success', processId: 'C' }] });
    await wrapper.vm.importFile({ target: { files: [file], value: 'x' } }); await flushPromises();
    expect(mocks.importSteps).toHaveBeenCalledWith(7, file, { mode: 'append', reason: '' });
    expect(wrapper.get('[data-testid="import-result"]').text()).toContain('成功 1');
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm'); wrapper.vm.importMode = 'replace'; wrapper.vm.importReason = 'replace all';
    mocks.importSteps.mockResolvedValue({ mode: 'replace', successCount: 2, failureCount: 0, totalCount: 2, records: [] });
    await wrapper.vm.importFile({ target: { files: [file], value: 'x' } });
    expect(mocks.importSteps).toHaveBeenLastCalledWith(7, file, { mode: 'replace', reason: 'replace all' });
    wrapper.unmount();
  });

  it('uses runtime Pinia card_edit rather than route mode or role proxies', async () => {
    const wrapper = await mountSteps([]);
    expect(wrapper.vm.canEdit).toBe(false); expect(wrapper.get('[data-testid="add-step"]').attributes('disabled')).toBeDefined();
    wrapper.unmount();
  });
});

describe('Section 29 version history center', () => {
  it('sorts versions descending, loads aggregate snapshot/direct predecessor diff, and prints only one historical version', async () => {
    mocks.listVersions.mockResolvedValue([{ id: 1, revision: 1, reviews: [] }, { id: 2, revision: 2, reviews: [{ action: 'approve', reviewer: 'M1' }] }]);
    mocks.getVersionSnapshot.mockResolvedValue({ id: 2, revision: 2, taskNo: 'TC-1', steps: [{ id: 11, processId: 'A', components: [] }], referenceDocuments: [], relations: [] });
    mocks.getVersionDiff.mockResolvedValue({ revision: 2, previousRevision: 1, diff: { headerChanges: [{ field: 'title' }], referenceDocuments: { added: [], removed: [], changed: [] }, steps: { added: [], removed: [], changed: [] } } });
    mocks.printVersion.mockResolvedValue({ templateId: 1, templateBody: '{{taskNo}}', model: { taskNo: 'TC-1', steps: [] } });
    const popup = { document: { open: vi.fn(), write: vi.fn(), close: vi.fn() }, focus: vi.fn(), print: vi.fn() }; vi.stubGlobal('open', vi.fn(() => popup));
    const wrapper = mountElement(VersionHistoryPanel, { props: { cardId: 7 } }); await flushPromises();
    expect(wrapper.vm.orderedVersions.map(({ revision }) => revision)).toEqual([2, 1]);
    expect(mocks.getVersionSnapshot).toHaveBeenCalledWith(7, 2); expect(mocks.getVersionDiff).toHaveBeenCalledWith(7, 2);
    expect(wrapper.get('[data-testid="version-diff"]').text()).toContain('抬头字段 (1)');
    expect(wrapper.text()).not.toContain('Restore'); expect(wrapper.text()).not.toContain('Print Compare');
    await wrapper.vm.printVersion(); expect(mocks.printVersion).toHaveBeenCalledWith(7, 2); expect(popup.print).toHaveBeenCalledOnce();
    vi.unstubAllGlobals(); wrapper.unmount();
  });
});
