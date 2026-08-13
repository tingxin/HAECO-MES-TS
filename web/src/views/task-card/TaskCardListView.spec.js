import { mount, flushPromises } from '@vue/test-utils';
import ElementPlus, { ElMessage } from 'element-plus';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TaskCardListView from './TaskCardListView.vue';
import { usePermissionStore } from '../../stores/permission.js';

const api = vi.hoisted(() => ({
  list: vi.fn(), copy: vi.fn(), adjustCopiedTaskNo: vi.fn(), revise: vi.fn(), batchReplace: vi.fn(), voidCard: vi.fn(),
  getVoidPrecheck: vi.fn(), exportCsv: vi.fn(), getPrintModel: vi.fn(), getBatchPrintModels: vi.fn(),
}));
vi.mock('../../api/taskCardApi.js', () => ({ taskCardApi: api }));
vi.mock('../../api/execDocApi.js', () => ({ execDocApi: { list: vi.fn().mockResolvedValue({ list: [] }), copy: vi.fn() } }));

async function mountView(permissionValues = []) {
  const pinia = createPinia(); setActivePinia(pinia);
  usePermissionStore().permissions = permissionValues;
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', component: TaskCardListView },
    { path: '/task-card/editor', name: 'task-card-editor', component: { template: '<div />' } },
  ] });
  await router.push('/'); await router.isReady();
  const wrapper = mount(TaskCardListView, { global: { plugins: [pinia, router, ElementPlus] }, attachTo: document.body });
  await flushPromises();
  return wrapper;
}

const allPermissions = ['card_read', 'card_edit', 'card_void', 'card_print_export', 'batch_replace'];

describe('TaskCardListView actions and permissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.list.mockResolvedValue({ list: [], total: 0, page: 1, pageSize: 20 });
    vi.spyOn(ElMessage, 'warning').mockImplementation(() => {});
    vi.spyOn(ElMessage, 'error').mockImplementation(() => {});
  });


  it('uniformly intercepts every selection-dependent list action and performs zero action API calls', async () => {
    const wrapper = await mountView(allPermissions);
    const actionIds = ['action-edit', 'action-copy', 'action-revise', 'action-detail', 'action-key-export',
      'action-all-export', 'action-print', 'action-void', 'action-batch-replace'];
    for (const id of actionIds) await wrapper.get(`[data-testid="${id}"]`).trigger('click');

    expect(ElMessage.warning).toHaveBeenCalledTimes(actionIds.length);
    for (const call of ElMessage.warning.mock.calls) expect(call).toEqual(['请先选择工卡']);
    expect(api.copy).not.toHaveBeenCalled();
    expect(api.revise).not.toHaveBeenCalled();
    expect(api.exportCsv).not.toHaveBeenCalled();
    expect(api.getPrintModel).not.toHaveBeenCalled();
    expect(api.getBatchPrintModels).not.toHaveBeenCalled();
    expect(api.voidCard).not.toHaveBeenCalled();
    expect(api.getVoidPrecheck).not.toHaveBeenCalled();
    expect(api.batchReplace).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('retains all filters after an empty response', async () => {
    const wrapper = await mountView(allPermissions);
    const requested = { acType: '320', taskNo: 'TC-X', gearType: 'MLG', title: 'empty', status: 'Void', stage: 'WFD' };
    await wrapper.vm.search(requested);
    await flushPromises();

    expect(api.list).toHaveBeenLastCalledWith({ ...requested, page: 1, pageSize: 20 });
    expect({ ...wrapper.vm.filters }).toMatchObject(requested);
    expect(wrapper.vm.filters).toMatchObject({ processSkills: [], cmm: '', processDescription: '' });
    expect(wrapper.getComponent({ name: 'SearchToolbar' }).props('modelValue')).toMatchObject(requested);
    expect(wrapper.get('[data-testid="task-card-empty"]').text()).toContain('当前筛选条件已保留');
    wrapper.unmount();
  });

  it('uses the server full mode for full export', async () => {
    api.exportCsv.mockResolvedValue(new Blob(['csv'], { type: 'text/csv' }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const wrapper = await mountView(allPermissions);
    wrapper.vm.onSelectionChange([{ id: 42, taskNo: 'TC-42' }]);
    await wrapper.vm.exportCards('full');
    await flushPromises();

    expect(api.exportCsv).toHaveBeenCalledWith([42], 'full');
    expect(click).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it('disables permission-protected buttons instead of hiding them', async () => {
    const wrapper = await mountView([]);
    const actionIds = ['action-add', 'action-edit', 'action-copy', 'action-revise', 'action-detail',
      'action-key-export', 'action-all-export', 'action-print', 'action-void', 'action-batch-replace', 'action-sws-copy'];
    for (const id of actionIds) {
      const button = wrapper.get(`[data-testid="${id}"]`);
      expect(button.exists()).toBe(true);
      expect(button.attributes('disabled')).toBeDefined();
    }
    expect(api.list).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});

describe('TaskCardListView Section 29 filters and batch print', () => {
  beforeEach(() => {
    vi.clearAllMocks(); api.list.mockResolvedValue({ list: [], total: 0, page: 1, pageSize: 20 });
    vi.spyOn(ElMessage, 'warning').mockImplementation(() => {}); vi.spyOn(ElMessage, 'error').mockImplementation(() => {});
  });
  it('serializes Process Skill as the server processSkills comma contract and preserves all advanced filters', async () => {
    const wrapper = await mountView(allPermissions);
    await wrapper.vm.search({ cmm: '32-10 R2', processSkills: ['GR', 'QC'], processDescription: 'bearing' });
    expect(api.list).toHaveBeenLastCalledWith({ cmm: '32-10 R2', processSkills: 'GR,QC', processDescription: 'bearing', page: 1, pageSize: 20 });
    expect(wrapper.vm.filters.processSkills).toEqual(['GR', 'QC']); wrapper.unmount();
  });
  it('uses one backend batch-print request and leaves one browser sheet per selected card', async () => {
    api.getBatchPrintModels.mockResolvedValue([
      { templateId: 1, templateBody: '{{taskNo}}', model: { taskNo: 'TC-1', steps: [] } },
      { templateId: 2, templateBody: '{{taskNo}}', model: { taskNo: 'TC-2', steps: [] } },
    ]);
    const popup = { document: { open: vi.fn(), write: vi.fn(), close: vi.fn() }, focus: vi.fn(), print: vi.fn() };
    vi.stubGlobal('open', vi.fn(() => popup));
    const wrapper = await mountView(allPermissions); wrapper.vm.onSelectionChange([{ id: 1 }, { id: 2 }]);
    await wrapper.vm.printCards();
    expect(api.getBatchPrintModels).toHaveBeenCalledWith([1, 2]);
    expect(popup.document.write.mock.calls[0][0].match(/class="print-sheet"/g)).toHaveLength(2);
    vi.unstubAllGlobals(); wrapper.unmount();
  });
});
