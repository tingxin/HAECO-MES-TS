import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import ElementPlus from 'element-plus';
import ProcessStepEditorView from './ProcessStepEditorView.vue';
import ComponentInserter from './ComponentInserter.vue';
import CaptureItemEditor from './CaptureItemEditor.vue';
import AttachmentUploader from './AttachmentUploader.vue';
const mocks = vi.hoisted(() => ({
  taskGet: vi.fn(), stepUpdate: vi.fn(), stepCreate: vi.fn(), listTemplates: vi.fn(),
  createTemplate: vi.fn(), applyTemplate: vi.fn(), attachmentUpload: vi.fn(),
  getEnums: vi.fn(), getProcessData: vi.fn(), getPpcProcessData: vi.fn(),
}));
vi.mock('../../api/taskCardApi.js', () => ({ taskCardApi: { get: mocks.taskGet } }));
vi.mock('../../api/stepApi.js', () => ({ stepApi: {
  update: mocks.stepUpdate, create: mocks.stepCreate, listTemplates: mocks.listTemplates,
  createTemplate: mocks.createTemplate, applyTemplate: mocks.applyTemplate,
} }));
vi.mock('../../api/configApi.js', () => ({ configApi: { getEnums: mocks.getEnums } }));
vi.mock('../../api/integrationApi.js', () => ({ integrationApi: { getProcessData: mocks.getProcessData, getPpcProcessData: mocks.getPpcProcessData } }));
vi.mock('../../api/attachmentApi.js', () => ({ attachmentApi: { upload: mocks.attachmentUpload } }));
const TYPES = ['measurement','table','text','tool','image','video','audio','range','consumable','time','dataGroup','custom','signature'];
const baseStep = { id: 11, processId: 'A', skill: 'GR', refDocId: 3, descriptionZh: '拆卸轴承', descriptionEn: 'Remove bearing', captureItems: [{ id: 21, type: 'text', itemKey: 'P/N', required: true, config: {} }], components: [{ id: 31, type: 'text', payload: { content: '保留内容' }, sortOrder: 1 }, { id: 32, type: 'image', payload: {}, sortOrder: 2 }], signatureRequirements: [], safetyWarning: '', visualCue: null, repairTips: '', isCritical: 0 };
function card(status = 'New') { return { id: 7, status, referenceDocuments: [{ id: 3, refNo: 'AMM-32', documentRevision: 'R1' }], steps: [structuredClone(baseStep)] }; }
async function mountView(status = 'New') {
  mocks.taskGet.mockResolvedValueOnce(card(status));
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/task-card/step', name: 'task-card-step', component: ProcessStepEditorView }, { path: '/task-card/editor', name: 'task-card-editor', component: { template: '<div />' } }] });
  await router.push({ name: 'task-card-step', query: { cardId: '7', stepId: '11', mode: status === 'New' ? 'edit' : 'view' } }); await router.isReady();
  const wrapper = mount(ProcessStepEditorView, { global: { plugins: [router, ElementPlus], stubs: { transition: false } } }); await flushPromises(); return wrapper;
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.getEnums.mockResolvedValue({ componentType: TYPES, signatureRole: ['Operator','QC','NDT','CertifyingStaff'], skill: ['GR','QC'] });
  mocks.listTemplates.mockResolvedValue([]); mocks.getProcessData.mockResolvedValue({ operation: 'OP-REMOVE' }); mocks.getPpcProcessData.mockResolvedValue([{ stepId: 11, workCategory: 'Repair', estimatedManHours: 2.5 }]);
  mocks.stepUpdate.mockImplementation((_cardId, _stepId, payload) => Promise.resolve({ ...structuredClone(baseStep), ...payload }));
});
afterEach(() => vi.restoreAllMocks());
describe('Section 25 process step authoring', () => {
  it('renders all 13 server component types and shares the exact enum with capture items', async () => {
    const wrapper = await mountView();
    expect(wrapper.findAll('[data-component-type]')).toHaveLength(13);
    expect(wrapper.findAll('[data-component-type]').map((node) => node.attributes('data-component-type'))).toEqual(TYPES);
    expect(wrapper.findComponent(ComponentInserter).props('types')).toEqual(TYPES);
    expect(wrapper.findComponent(CaptureItemEditor).props('types')).toEqual(TYPES);
    wrapper.unmount();
  });
  it('shows Operation and all manhour properties as text without write controls', async () => {
    const wrapper = await mountView('Effective'); const properties = wrapper.get('[data-testid="readonly-properties"]');
    expect(properties.text()).toContain('OP-REMOVE'); expect(properties.text()).toContain('Repair'); expect(properties.text()).toContain('2.5');
    expect(properties.find('input').exists()).toBe(false); expect(wrapper.get('[data-testid="step-readonly-notice"]').exists()).toBe(true);
    wrapper.unmount();
  });
  it('preserves every existing component when an attachment upload fails', async () => {
    mocks.attachmentUpload.mockRejectedValueOnce(new Error('network down')); const wrapper = await mountView();
    const before = JSON.parse(JSON.stringify(wrapper.vm.step.components)); const uploader = wrapper.findAllComponents(AttachmentUploader)[0];
    await uploader.vm.uploadFile(new File(['x'], 'diagram.png', { type: 'image/png' })); await flushPromises();
    expect(wrapper.vm.step.components).toEqual(before); wrapper.unmount();
  });
  it('round-trips multiple signature roles, stamp/date flags and display order', async () => {
    const wrapper = await mountView();
    wrapper.vm.step.signatureRequirements = [{ signatureRole: 'Operator', stampRequired: true, dateRequired: true, sortOrder: 1 }, { signatureRole: 'QC', stampRequired: false, dateRequired: true, sortOrder: 2 }];
    wrapper.vm.changeReason = '配置多角色签署'; await wrapper.vm.save();
    expect(mocks.stepUpdate).toHaveBeenCalledWith('7', 11, expect.objectContaining({ signatureRequirements: [expect.objectContaining({ signatureRole: 'Operator', stampRequired: true, dateRequired: true, sortOrder: 1 }), expect.objectContaining({ signatureRole: 'QC', stampRequired: false, dateRequired: true, sortOrder: 2 })] }));
    expect(wrapper.vm.step.signatureRequirements.map((row) => row.signatureRole)).toEqual(['Operator','QC']); wrapper.unmount();
  });
  it('saves and applies a real reusable template to restore aggregate step content', async () => {
    const wrapper = await mountView(); wrapper.vm.templateName = '轴承拆卸模板'; wrapper.vm.changeReason = '保存模板';
    mocks.createTemplate.mockResolvedValue({ id: 91, name: '轴承拆卸模板' }); mocks.listTemplates.mockResolvedValueOnce([{ id: 91, name: '轴承拆卸模板' }]);
    await wrapper.vm.saveTemplate(); expect(mocks.createTemplate).toHaveBeenCalledWith({ name: '轴承拆卸模板', stepId: 11 });
    const restored = { ...structuredClone(baseStep), descriptionZh: '模板还原内容', signatureRequirements: [{ signatureRole: 'NDT', stampRequired: true, dateRequired: true, sortOrder: 1 }] };
    mocks.applyTemplate.mockResolvedValueOnce(restored); wrapper.vm.selectedTemplate = 91; await wrapper.vm.applyTemplate();
    expect(mocks.applyTemplate).toHaveBeenCalledWith('7', 11, { templateId: 91, reason: '保存模板' }); expect(wrapper.vm.step.descriptionZh).toBe('模板还原内容'); expect(wrapper.vm.step.signatureRequirements[0].signatureRole).toBe('NDT'); wrapper.unmount();
  });
});
