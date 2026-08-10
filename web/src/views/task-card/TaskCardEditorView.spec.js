import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BomBaseTable from './BomBaseTable.vue';
import CardRelationPanel from './CardRelationPanel.vue';
import ClassificationConfirmDialog from './ClassificationConfirmDialog.vue';
import MetadataForm from './MetadataForm.vue';
import ReferenceDocTable from './ReferenceDocTable.vue';
import ReviewPanel from './ReviewPanel.vue';
import TaskCardEditorView from './TaskCardEditorView.vue';
import { usePermissionStore } from '../../stores/permission.js';

const taskApi = vi.hoisted(() => ({
  get: vi.fn(), create: vi.fn(), update: vi.fn(), checkDuplicate: vi.fn(), addReferenceDocument: vi.fn(),
  deleteReferenceDocument: vi.fn(), listChangeRecords: vi.fn(), listRelations: vi.fn(), addRelation: vi.fn(), deleteRelation: vi.fn(), revise: vi.fn(),
  release: vi.fn(),
}));
const config = vi.hoisted(() => ({ getEnums: vi.fn(), getStageConstraints: vi.fn(), getSystemParameters: vi.fn() }));
const review = vi.hoisted(() => ({ submit: vi.fn(), approve: vi.fn(), reject: vi.fn(), list: vi.fn() }));
const integration = vi.hoisted(() => ({ searchTpcDocuments: vi.fn() }));
const bom = vi.hoisted(() => ({ listLotLinks: vi.fn(), addLotLink: vi.fn(), deleteLotLink: vi.fn(), listBases: vi.fn() }));
const classification = vi.hoisted(() => ({ derive: vi.fn(), confirm: vi.fn() }));
vi.mock('../../api/taskCardApi.js', () => ({ taskCardApi: taskApi }));
vi.mock('../../api/configApi.js', () => ({ configApi: config }));
vi.mock('../../api/reviewApi.js', () => ({ reviewApi: review }));
vi.mock('../../api/integrationApi.js', () => ({ integrationApi: integration }));
vi.mock('../../api/bomApi.js', () => ({ bomApi: bom }));
vi.mock('../../api/classificationApi.js', () => ({ classificationApi: classification }));

const enums = { acType: ['320'], gearType: ['MLG'], stage: ['CUS', 'RTN', 'WFD'], skill: ['AS'], ctrlCode: ['AS'], cardType: ['04', '05', '11'] };
const stageConfig = { byCardType: { '04': { defaultStage: 'RTN', selectableStages: ['RTN', 'WFD'] }, '05': { defaultStage: 'RTN', selectableStages: ['RTN', 'WFD'] } } };
const baseCard = { id: 7, taskNo: 'TC-7', title: 'Card', revision: 1, date: '2026-08-09', status: 'New', cardType: '04', stage: 'RTN', referenceDocuments: [], relations: [], steps: [], changeRecords: [] };
const componentPinia = createPinia();
const global = { plugins: [componentPinia, ElementPlus] };
afterEach(() => { document.body.innerHTML = ''; });

describe('MetadataForm', () => {
  it('keeps Stage editable and includes WFD, and conditionally shows IR fields', async () => {
    const wrapper = mount(MetadataForm, { props: { modelValue: { status: 'New', cardType: '04', stage: 'RTN' }, enums, stageConfig, mode: 'edit' }, global });
    await flushPromises();
    expect(wrapper.get('[data-testid="stage-select"]').classes()).not.toContain('is-disabled');
    expect(wrapper.get('[data-testid="stage-option-values"]').text()).toContain('WFD');
    wrapper.vm.form.stage = 'WFD';
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted('update:modelValue').at(-1)[0].stage).toBe('WFD');
    await wrapper.setProps({ modelValue: { status: 'New', cardType: '04', stage: 'CUS' } });
    expect(wrapper.get('[data-testid="stage-combination-warning"]').text()).toContain('RTN、WFD');
    expect(wrapper.find('[data-testid="base-number"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="ipc-item-no"]').exists()).toBe(true);
    await wrapper.setProps({ modelValue: { status: 'New', cardType: '05', stage: 'RTN' } });
    expect(wrapper.find('[data-testid="base-number"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="ipc-item-no"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('hides execution and Process Card fields without JOB and renders text-only values with JOB', async () => {
    const wrapper = mount(MetadataForm, { props: { modelValue: baseCard, enums, stageConfig }, global });
    expect(wrapper.find('[data-testid="execution-fields"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="process-card-fields"]').exists()).toBe(false);
    await wrapper.setProps({ jobContext: { owner: 'E1', jobTargetDate: '2026-08-10', checkType: 'Detailed', inboundSn: 'GEAR-SN-1', partNo: 'PN-1', partSn: 'SN-1', partDesc: 'Part', operationType: 'Repair' } });
    expect(wrapper.get('[data-testid="execution-fields"]').text()).toContain('E1');
    expect(wrapper.get('[data-testid="execution-fields"]').text()).toContain('Detailed');
    expect(wrapper.get('[data-testid="execution-fields"]').text()).toContain('GEAR-SN-1');
    expect(wrapper.get('[data-testid="process-card-fields"]').text()).toContain('PN-1');
    expect(wrapper.find('[data-testid="execution-fields"] input').exists()).toBe(false);
    expect(wrapper.find('[data-testid="process-card-fields"] input').exists()).toBe(false);
    wrapper.unmount();
  });
});

describe('TPC and review components', () => {
  beforeEach(() => classification.derive.mockResolvedValue({
    classification: 'Routine', candidates: [{ classification: 'Routine', sourceRef: 'P6:04' }],
    requiresManualConfirmation: false,
  }));

  it('fills all four TPC fields', async () => {
    const wrapper = mount(ReferenceDocTable, { props: { rows: [] }, global });
    wrapper.vm.applyTpc({ documentType: 'AMM', refNo: '32-11', documentRevision: 'R2', documentDesc: 'MLG manual' });
    await wrapper.vm.$nextTick();
    expect(wrapper.vm.draft).toMatchObject({ docType: 'AMM', refNo: '32-11', docRevision: 'R2', documentDesc: 'MLG manual' });
    expect(wrapper.get('[data-testid="tpc-document-desc"]').text()).toContain('MLG manual');
    wrapper.unmount();
  });

  it('disables approval on blank comment and shows field-level changes', async () => {
    review.list.mockResolvedValue([]); taskApi.listChangeRecords.mockResolvedValue([{ field: 'title', oldValue: 'Old', newValue: 'New', changeType: 'edit', reason: 'correct' }]);
    const wrapper = mount(ReviewPanel, { props: { cardId: 7, status: 'UnderReview', revision: 2 }, global });
    await flushPromises();
    expect(wrapper.get('[data-testid="approve-review"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="change-records"]').text()).toContain('Old');
    expect(wrapper.get('[data-testid="change-records"]').text()).toContain('New');
    wrapper.unmount();
  });

  it('lists every failed review check with stable (a)-(g) labels and blocks unconfirmed classification', async () => {
    review.list.mockResolvedValue([]); taskApi.listChangeRecords.mockResolvedValue([]);
    review.submit.mockRejectedValue({ message: 'checklist failed', data: { failedChecks: 'abcdefg'.split('').map(check => ({ check, label: `check-${check}`, message: `failed-${check}` })) } });
    const wrapper = mount(ReviewPanel, { props: { cardId: 7, status: 'New', revision: 1 }, global });
    await flushPromises(); await wrapper.vm.submit(); await flushPromises();
    const failures = wrapper.get('[data-testid="review-failures"]').text();
    for (const check of 'abcdefg') expect(failures).toContain(`(${check})`);
    await wrapper.setProps({ classificationPending: true });
    expect(wrapper.get('[data-testid="submit-review"]').attributes('disabled')).toBeDefined();
    review.submit.mockClear(); await wrapper.vm.submit();
    expect(review.submit).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('derives classification candidates and confirms the selected value with its source evidence', async () => {
    classification.derive.mockResolvedValue({ candidates: [
      { classification: 'Material Special Replacement', sourceRef: 'P6:11' },
      { classification: 'Configuration(MOD)', sourceRef: 'P6:11' },
    ], hitTier: 'P6_CardTypeFallback', sourceRef: null });
    classification.confirm.mockResolvedValue({ classification: 'Material Special Replacement' });
    const wrapper = mount(ClassificationConfirmDialog, {
      props: { modelValue: true, cardId: 7 }, global, attachTo: document.body,
    });
    await wrapper.vm.derive();
    await flushPromises();
    expect(wrapper.vm.candidates).toHaveLength(2);
    expect(document.body.querySelector('[data-testid="classification-candidates"]').textContent).toContain('依据：P6:11');
    wrapper.vm.choice = 'Material Special Replacement'; await wrapper.vm.confirm();
    expect(classification.confirm).toHaveBeenCalledWith(7, { classification: 'Material Special Replacement' });
    expect(wrapper.emitted('confirmed')?.[0]?.[0]).toEqual({ classification: 'Material Special Replacement' });
    wrapper.unmount();
  });
});

describe('Relation and BOM components', () => {
  it('offers all 11 execution document types and renders origin plus key snapshot', async () => {
    taskApi.listRelations.mockResolvedValue([
      { id: 1, execDocType: 'CR', relatedDocNo: 'CR-1', origin: 'manual', keyInfoSnapshot: { aircraftType: '320' } },
      { id: 2, execDocType: 'PC', relatedDocNo: 'PC-1', origin: 'auto', keyInfoSnapshot: { partNo: 'PN-1' } },
    ]);
    const wrapper = mount(CardRelationPanel, { props: { cardId: 7 }, global });
    await flushPromises();
    expect(wrapper.get('[data-testid="relation-type-values"]').text().split(',')).toHaveLength(11);
    expect(wrapper.text()).toContain('人工'); expect(wrapper.text()).toContain('自动');
    expect(wrapper.get('[data-testid="relation-snapshot"]').text()).toContain('aircraftType');
    wrapper.unmount();
  });

  it('marks BOM bases from both IR card and Lot List sources with Lot Number', async () => {
    const wrapper = mount(BomBaseTable, { props: { rows: [
      { id: 1, taskNo: 'TC-IR', taskTitle: 'IR inspection', baseNumber: 'BASE-IR', source: 'ir_card' },
      { id: 2, taskNo: 'TC-LOT', taskTitle: 'IR lot', baseNumber: 'BASE-LOT', source: 'lot_list', lotNumber: 'LOT-9' },
    ] }, global });
    await flushPromises();
    expect(wrapper.text()).toContain('TC-IR'); expect(wrapper.text()).toContain('IR inspection');
    expect(wrapper.text()).toContain('BASE-IR'); expect(wrapper.text()).toContain('IR 卡');
    expect(wrapper.text()).toContain('BASE-LOT'); expect(wrapper.text()).toContain('Lot List'); expect(wrapper.text()).toContain('LOT-9');
    wrapper.unmount();
  });
});

async function mountEditor(query, cardValue = baseCard, permissionValues = []) {
  taskApi.get.mockResolvedValue(structuredClone(cardValue));
  const pinia = createPinia(); setActivePinia(pinia);
  usePermissionStore().permissions = permissionValues;
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/task-card/editor', name: 'task-card-editor', component: TaskCardEditorView },
    { path: '/task-card/list', name: 'task-card-list', component: { template: '<div />' } },
    { path: '/job/:jobNo', name: 'job', component: { template: '<div data-testid="job-route" />' } },
  ] });
  await router.push({ path: '/task-card/editor', query }); await router.isReady();
  const wrapper = mount(TaskCardEditorView, { global: { plugins: [pinia, router, ElementPlus] }, attachTo: document.body });
  await flushPromises(); return wrapper;
}

describe('TaskCardEditorView modes and tabs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.getEnums.mockResolvedValue(enums); config.getStageConstraints.mockResolvedValue(stageConfig);
    config.getSystemParameters.mockResolvedValue([{ key: 'organizationName', value: 'HAECO Landing Gear Services' }]);
    review.list.mockResolvedValue([]); taskApi.listChangeRecords.mockResolvedValue([]); taskApi.listRelations.mockResolvedValue([]);
    bom.listLotLinks.mockResolvedValue([]); bom.listBases.mockResolvedValue([]); taskApi.checkDuplicate.mockResolvedValue({ duplicate: false });
  });

  it('supports add defaults and view mode while keeping organization read-only', async () => {
    const addWrapper = await mountEditor({ mode: 'add' });
    expect(addWrapper.vm.mode).toBe('add'); expect(taskApi.get).not.toHaveBeenCalled();
    expect(addWrapper.vm.card.date).toBe(new Date().toISOString().slice(0, 10));
    expect(addWrapper.vm.card.isFai).toBe(false);
    expect(addWrapper.get('[data-testid="organization-name"]').text()).toContain('HAECO Landing Gear Services');
    expect(addWrapper.find('[data-testid="organization-name"] input').exists()).toBe(false);
    expect(addWrapper.find('[data-testid="save-card"]').exists()).toBe(true);
    addWrapper.unmount();

    const viewWrapper = await mountEditor({ mode: 'view', id: '7' });
    expect(viewWrapper.vm.mode).toBe('view');
    expect(viewWrapper.find('[data-testid="save-card"]').exists()).toBe(false);
    expect(viewWrapper.get('[data-testid="title"]').attributes('disabled')).toBeDefined();
    viewWrapper.unmount();
  });

  it('surfaces duplicate revision 409 feedback', async () => {
    const wrapper = await mountEditor({ mode: 'add' });
    Object.assign(wrapper.vm.card, { taskNo: 'TC-DUP', revision: 2 });
    taskApi.checkDuplicate.mockRejectedValueOnce({ status: 409, message: 'Task No 与版本号已存在' });
    expect(await wrapper.vm.checkRevision()).toBe(false); await flushPromises();
    expect(wrapper.get('[data-testid="revision-duplicate"]').text()).toContain('已存在');
    wrapper.unmount();
  });

  it('renders all five tabs and makes non-New content read-only with revise guidance', async () => {
    const wrapper = await mountEditor({ mode: 'edit', id: '7' }, { ...baseCard, status: 'Effective' });
    expect(wrapper.get('[data-testid="editor-tabs"]').text()).toContain('基础信息');
    for (const label of ['参考文件', '工序', '关联工卡', '审核记录']) expect(wrapper.get('[data-testid="editor-tabs"]').text()).toContain(label);
    expect(wrapper.get('[data-testid="revise-notice"]').text()).toContain('变更请先执行升版');
    expect(wrapper.find('[data-testid="save-card"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="title"]').attributes('disabled')).toBeDefined();
    wrapper.unmount();
  });

  it('shows the release action only with card_release and navigates Effective cards to the created JOB', async () => {
    taskApi.release.mockResolvedValue({ jobNo: 'JOB-7-001', message: '发布成功' });
    const wrapper = await mountEditor(
      { mode: 'edit', id: '7' },
      { ...baseCard, status: 'Effective' },
      ['card_release'],
    );
    const panel = wrapper.getComponent(ReviewPanel);
    expect(panel.get('[data-testid="release-to-job"]').text()).toContain('发布至工包');

    await panel.get('[data-testid="release-to-job"]').trigger('click');
    await flushPromises();

    expect(taskApi.release).toHaveBeenCalledWith(7);
    expect(wrapper.vm.$route.name).toBe('job');
    expect(wrapper.vm.$route.params.jobNo).toBe('JOB-7-001');
    wrapper.unmount();
  });

  it('uses JOB query context to render read-only execution fields and revise mode persists a manually adjusted version', async () => {
    const withJob = { ...baseCard, revision: 3, jobContext: { owner: 'JOB-OWNER', partNo: 'PN-JOB' } };
    const wrapper = await mountEditor({ mode: 'revise', id: '7', jobNo: 'JOB-7' }, withJob);
    expect(taskApi.get).toHaveBeenCalledWith('7', { jobNo: 'JOB-7' });
    expect(wrapper.vm.card.revision).toBe(4);
    expect(wrapper.get('[data-testid="execution-fields"]').text()).toContain('JOB-OWNER');
    expect(wrapper.get('[data-testid="process-card-fields"]').text()).toContain('PN-JOB');

    wrapper.vm.card.revision = 6;
    wrapper.vm.changeReason = '手动调整升版号';
    taskApi.revise.mockResolvedValue([{ id: 8, revision: 6 }]);
    taskApi.update.mockResolvedValue({ ...withJob, id: 8, revision: 6, status: 'New' });
    taskApi.get.mockResolvedValueOnce({ ...withJob, id: 8, revision: 6, status: 'New' });
    await wrapper.vm.save();
    expect(taskApi.revise).toHaveBeenCalledWith({ ids: ['7'], reason: '手动调整升版号', revision: 6 });
    expect(taskApi.update).toHaveBeenCalledWith(8, expect.objectContaining({ revision: 6, reason: '手动调整升版号' }));
    wrapper.unmount();
  });
});