import { mount, flushPromises } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SearchToolbar from './SearchToolbar.vue';
import TaskCardTable from './TaskCardTable.vue';
import ColumnSettingsDialog from './ColumnSettingsDialog.vue';
import BatchCopyDialog from './BatchCopyDialog.vue';
import BatchReplaceDialog from './BatchReplaceDialog.vue';
import VoidDialog from './VoidDialog.vue';
import ExecDocCopyDialog from './ExecDocCopyDialog.vue';
import { cloneDefaultColumns } from './columnSettings.js';

const taskCardMocks = vi.hoisted(() => ({
  copy: vi.fn(), adjustCopiedTaskNo: vi.fn(), batchReplace: vi.fn(), getVoidPrecheck: vi.fn(), voidCard: vi.fn(),
}));
const execDocMocks = vi.hoisted(() => ({ list: vi.fn(), copy: vi.fn() }));
vi.mock('../../api/taskCardApi.js', () => ({ taskCardApi: taskCardMocks }));
vi.mock('../../api/execDocApi.js', () => ({ execDocApi: execDocMocks }));

const mountWithElement = (component, options = {}) => mount(component, {
  ...options,
  global: { plugins: [ElementPlus], ...(options.global || {}) },
  attachTo: document.body,
});

describe('SearchToolbar and TaskCardTable', () => {
  it('exposes exactly five statuses and all Stage values including WFD', () => {
    const wrapper = mountWithElement(SearchToolbar, { props: { modelValue: {} } });
    expect(wrapper.get('[data-testid="status-values"]').text()).toBe('New,UnderReview,Effective,Superseded,Void');
    expect(wrapper.get('[data-testid="stage-values"]').text()).toBe('CUS,DMY,MOD,NRC,RTN,SPC,WCC,WFD');
    wrapper.unmount();
  });

  it('renders WFD prominently, pads revision, and guides Effective editing through revision', async () => {
    const wrapper = mountWithElement(TaskCardTable, { props: {
      rows: [{ id: 7, taskNo: 'TC-7', title: 'Effective WFD', stage: 'WFD', status: 'Effective', revision: 3 }],
      canRead: true, canEdit: true, canVoid: true, canPrint: true,
    } });
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(wrapper.get('[data-testid="wfd-badge"]').text()).toBe('WFD · 待删除');
    expect(wrapper.get('[data-testid="revision-value"]').text()).toBe('03');
    expect(wrapper.get('[data-testid="effective-edit"]').text()).toBe('升版后编辑');
    wrapper.unmount();
  });
});


describe('ExecDocCopyDialog', () => {
  beforeEach(() => {
    execDocMocks.list.mockReset().mockResolvedValue({ list: [{ id: 1, execDocType: 'SW', docNo: 'SWS-001' }] });
    execDocMocks.copy.mockReset();
  });

  it('requires a new SWS number and makes no copy request when blank', async () => {
    const wrapper = mountWithElement(ExecDocCopyDialog, { props: { modelValue: false } });
    await wrapper.setProps({ modelValue: true });
    await wrapper.vm.$nextTick();
    wrapper.vm.sourceId = 1;
    wrapper.vm.newDocNo = '   ';
    await wrapper.vm.submit();
    await wrapper.vm.$nextTick();

    expect(wrapper.get('[data-testid="sws-error"]').text()).toBe('新编号必填');
    expect(execDocMocks.list).toHaveBeenCalledWith({ execDocType: 'SW' });
    expect(execDocMocks.copy).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});

describe('ColumnSettingsDialog', () => {
  beforeEach(() => localStorage.clear());

  it('applies visibility, order and fixed settings through the component', async () => {
    const source = cloneDefaultColumns();
    const wrapper = mountWithElement(ColumnSettingsDialog, { props: { modelValue: false, columns: source } });
    await wrapper.setProps({ modelValue: true });
    wrapper.vm.draft.find(({ key }) => key === 'taskNo').visible = false;
    wrapper.vm.draft.find(({ key }) => key === 'title').fixed = 'right';
    const titleIndex = wrapper.vm.draft.findIndex(({ key }) => key === 'title');
    wrapper.vm.draft.unshift(wrapper.vm.draft.splice(titleIndex, 1)[0]);
    wrapper.vm.apply();

    const applied = wrapper.emitted('apply')[0][0];
    expect(applied[0].key).toBe('title');
    expect(applied).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'taskNo', visible: false }),
      expect.objectContaining({ key: 'title', fixed: 'right' }),
    ]));
    const persisted = JSON.parse(localStorage.getItem('haeco_tc_list_columns'));
    expect(persisted[0]).toEqual({ key: 'title', visible: true, fixed: 'right' });
    expect(persisted.find(({ key }) => key === 'taskNo')).toEqual({ key: 'taskNo', visible: false, fixed: 'left' });
    wrapper.unmount();
  });
});

describe('BatchCopyDialog', () => {
  beforeEach(() => {
    taskCardMocks.copy.mockReset();
    taskCardMocks.adjustCopiedTaskNo.mockReset();
  });

  it('submits the complete numbering rule and reports every copied card', async () => {
    taskCardMocks.copy.mockResolvedValue([
      { id: 11, taskNo: 'PRE-10-X', status: 'New' },
      { id: 12, taskNo: 'PRE-12-X', status: 'New' },
    ]);
    const wrapper = mountWithElement(BatchCopyDialog, { props: {
      modelValue: true, cards: [{ id: 1 }, { id: 2 }],
    } });
    Object.assign(wrapper.vm.form, { prefix: 'PRE-', suffix: '-X', startSeq: 10, step: 2 });
    await wrapper.vm.submit();
    await flushPromises();

    expect(taskCardMocks.copy).toHaveBeenCalledWith({
      ids: [1, 2], numbering: { prefix: 'PRE-', suffix: '-X', startSeq: 10, step: 2 },
    });
    expect(wrapper.vm.results.map(({ taskNo, adjustedTaskNo }) => ({ taskNo, adjustedTaskNo }))).toEqual([
      { taskNo: 'PRE-10-X', adjustedTaskNo: 'PRE-10-X' },
      { taskNo: 'PRE-12-X', adjustedTaskNo: 'PRE-12-X' },
    ]);
    expect(document.body.textContent).toContain('逐张调整新工卡编号');

    taskCardMocks.adjustCopiedTaskNo.mockResolvedValue({ id: 11, taskNo: 'MANUAL-001', status: 'New' });
    wrapper.vm.results[0].adjustedTaskNo = ' MANUAL-001 ';
    await wrapper.vm.adjustTaskNo(wrapper.vm.results[0]);
    await flushPromises();
    expect(taskCardMocks.adjustCopiedTaskNo).toHaveBeenCalledWith(11, 'MANUAL-001');
    expect(wrapper.vm.results[0]).toMatchObject({ taskNo: 'MANUAL-001', adjustedTaskNo: 'MANUAL-001', adjustmentMessage: '已保存' });
    wrapper.unmount();
  });
});

describe('BatchReplaceDialog', () => {
  beforeEach(() => taskCardMocks.batchReplace.mockReset());

  it('requires a reason and then renders per-card status restriction feedback', async () => {
    const wrapper = mountWithElement(BatchReplaceDialog, { props: {
      modelValue: true, cards: [{ id: 1 }, { id: 2 }],
    } });
    await wrapper.vm.submit();
    expect(taskCardMocks.batchReplace).not.toHaveBeenCalled();
    expect(document.body.querySelector('[data-testid="replace-error"]').textContent).toBe('替换原因必填');

    taskCardMocks.batchReplace.mockResolvedValue({
      affectedCount: 1,
      items: [
        { card: { id: 1, taskNo: 'TC-1' }, outcome: 'replaced' },
        { card: { id: 2, taskNo: 'TC-2' }, outcome: 'rejected_not_editable', rejectionMessage: '仅新增状态可替换' },
      ],
    });
    Object.assign(wrapper.vm.form, { field: 'title', from: 'old', to: 'new', reason: '统一修订' });
    await wrapper.vm.submit();
    await flushPromises();

    expect(taskCardMocks.batchReplace).toHaveBeenCalledWith({
      ids: [1, 2], field: 'title', from: 'old', to: 'new', reason: '统一修订',
    });
    expect(document.body.textContent).toContain('TC-1');
    expect(document.body.textContent).toContain('状态不允许');
    expect(document.body.textContent).toContain('仅新增状态可替换');
    wrapper.unmount();
  });
});

describe('VoidDialog', () => {
  beforeEach(() => {
    taskCardMocks.getVoidPrecheck.mockReset().mockResolvedValue({
      ok: false, blockingRefs: [{ type: 'JOB_IN_PROGRESS', location: 'JOB-001' }],
    });
    taskCardMocks.voidCard.mockReset().mockResolvedValue({ id: 1, status: 'Void' });
  });

  it('shows precheck results, requires a reason, and reports each void result', async () => {
    const wrapper = mountWithElement(VoidDialog, { props: {
      modelValue: false, cards: [{ id: 1, taskNo: 'TC-1' }],
    } });
    await wrapper.setProps({ modelValue: true });
    await flushPromises();
    expect(taskCardMocks.getVoidPrecheck).toHaveBeenCalledWith(1);
    expect(document.body.textContent).toContain('阻止项 1');

    await wrapper.vm.submit();
    expect(taskCardMocks.voidCard).not.toHaveBeenCalled();
    expect(document.body.querySelector('[data-testid="void-error"]').textContent).toBe('作废原因必填');

    wrapper.vm.reason = '停止使用';
    await wrapper.vm.submit();
    await flushPromises();
    expect(taskCardMocks.voidCard).toHaveBeenCalledWith(1, { reason: '停止使用' });
    expect(document.body.textContent).toContain('已作废');
    wrapper.unmount();
  });
});