import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import JobViewerView from './job/JobViewerView.vue';
import ConfigMaintenanceView from './config/ConfigMaintenanceView.vue';
import { renderPrintTriple } from './output/printRenderer.js';
import { usePermissionStore } from '../stores/permission.js';

const jobs = vi.hoisted(() => ({ get: vi.fn(), startProcess: vi.fn(), finishProcess: vi.fn(), acknowledgeSafety: vi.fn() }));
const cards = vi.hoisted(() => ({ getArchiveStatus: vi.fn(), sign: vi.fn(), getPrintModel: vi.fn() }));
const config = vi.hoisted(() => ({
  getEnums: vi.fn(), getStageConstraints: vi.fn(), getCommercialMap: vi.fn(), getDerivationPriority: vi.fn(), getCapabilities: vi.fn(),
  updateStageConstraints: vi.fn(), updateCommercialMap: vi.fn(), updateDerivationPriority: vi.fn(), updateCapabilities: vi.fn(),
}));
vi.mock('../api/jobApi.js', () => ({ jobApi: jobs }));
vi.mock('../api/taskCardApi.js', () => ({ taskCardApi: cards }));
vi.mock('../api/configApi.js', () => ({ configApi: config }));

const criticalProcess = {
  id: 21, processId: 'A', barcodeValue: 'JOB-001-A', barcodeType: 'CODE128', startTime: null, finishTime: null,
  snapshot: { snapshotAt: '2026-08-09T00:00:00Z', content: {
    processId: 'A', descriptionZh: '冻结快照内容', descriptionEn: 'Frozen snapshot', isCritical: true,
    safetyWarning: '佩戴护目镜', signatureRequirements: [{ id: 91, signatureRole: 'Operator', stampRequired: false, dateRequired: true }],
  } },
};
const jobDetail = { id: 7, jobNo: 'JOB-001', cardId: 3, cardRevision: 2, execStatus: 'Released', processes: [criticalProcess] };
let pinia;

async function mountJob() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/job/:jobNo', component: JobViewerView }] });
  await router.push('/job/JOB-001'); await router.isReady();
  const wrapper = mount(JobViewerView, { global: { plugins: [router, ElementPlus] }, attachTo: document.body });
  await flushPromises(); return wrapper;
}

describe('Section 26.5 JOB、打印与配置视图明确断言', () => {
  beforeEach(() => {
    document.body.innerHTML = ''; vi.clearAllMocks(); pinia = createPinia(); setActivePinia(pinia);
    jobs.get.mockResolvedValue(structuredClone(jobDetail)); cards.getArchiveStatus.mockResolvedValue({ ok: false, total: 1, satisfiedCount: 0, missing: [{ requirement: { id: 91 }, gaps: ['notSigned'] }] });
    config.getEnums.mockResolvedValue({ cardType: ['01'], stage: ['NRC'], commercialClassification: ['Routine'], derivationPriority: ['P1_PlanSetting'], acType: ['320'], gearType: ['MLG'], skill: ['AS'] });
    config.getStageConstraints.mockResolvedValue({ constraints: [{ cardType: '01', allowedStage: 'NRC', isAutoFill: true }], crosscut: ['NRC'] });
    config.getCommercialMap.mockResolvedValue([{ cardType: '01', commercialClassification: 'Routine' }]);
    config.getDerivationPriority.mockResolvedValue({ all: [{ tierCode: 'P1_PlanSetting', tierOrder: 1, enabled: true }] });
    config.getCapabilities.mockResolvedValue([{ acType: '320', gearType: 'MLG', skill: 'AS', revision: 1, effectiveFrom: '2026-01-01', effectiveTo: null }]);
  });

  it('1/5：JOB 视图只渲染 job_process.snapshot.content，不渲染模板当前内容', async () => {
    jobs.get.mockResolvedValue({ ...structuredClone(jobDetail), templateCurrentContent: '发布后模板当前内容' });
    const wrapper = await mountJob();
    expect(wrapper.get('[data-testid="snapshot-content"]').text()).toContain('冻结快照内容');
    expect(wrapper.get('[data-testid="bar-code"] svg').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('发布后模板当前内容');
    wrapper.unmount();
  });

  it('2/5：关键工序未确认安全警示时进入执行按钮禁用', async () => {
    const wrapper = await mountJob();
    expect(wrapper.get('[data-testid="start-21"]').attributes('disabled')).toBeDefined();
    wrapper.vm.onAcknowledged({ processId: 21 }); await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-testid="start-21"]').attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });

  it('3/5：打印不含工卡分类，且签署栏逐项服从 model.steps.signatures 配置', () => {
    const html = renderPrintTriple({ templateId: 1, templateBody: '{{cardType}}<table>{{#each steps}}{{#each signatures}}<tr><td>{{signatureRole}}</td><td>{{stampRequired}}</td></tr>{{/each}}{{/each}}</table>', model: {
      cardType: 'SHOULD-NOT-PRINT', steps: [{ signatures: [{ signatureRole: 'Operator', stampRequired: false }] }],
    } });
    expect(html).not.toContain('SHOULD-NOT-PRINT');
    expect(html).toContain('Operator');
    expect(html).not.toContain('QC');
  });

  it('4/5：按服务端真实投影，编制态实际栏为空，JOB 态带出实际工时、起止时间和签署记录', () => {
    const templateBody = '{{#each steps}}PLAN={{manHours.estimated}}|ACT={{manHours.actual}}|S={{startTime}}|F={{finishTime}}|{{#each signatures}}{{signedBy}}/{{stampId}}/{{signedAt}}{{/each}}{{/each}}';
    const authoring = renderPrintTriple({ templateId: 1, templateBody, model: { steps: [{ manHours: { estimated: 2.5, actual: null }, startTime: null, finishTime: null, signatures: [{ signatureRole: 'Operator', signedBy: null, stampId: null, signedAt: null }] }] } });
    const execution = renderPrintTriple({ templateId: 1, templateBody, model: { steps: [{ manHours: { estimated: 2.5, actual: 2.25 }, startTime: '08:00', finishTime: '10:30', signatures: [{ signatureRole: 'Operator', signedBy: 'E50001', stampId: 'STAMP-1', signedAt: '10:31' }] }] } });
    expect(authoring).toContain('PLAN=2.5|ACT=|S=|F=|//');
    expect(authoring).not.toContain('E50001');
    expect(execution).toContain('PLAN=2.5|ACT=2.25|S=08:00|F=10:30|E50001/STAMP-1/10:31');

    const legacyTemplate = '{{#each steps}}<td>{{manHours}}</td>{{#each signatures}}<td>Signature</td><td>Stamp</td><td>Date</td>{{/each}}{{/each}}';
    const legacyExecution = renderPrintTriple({ templateId: 1, templateBody: legacyTemplate, model: { steps: [{ manHours: { estimated: 2.5, actual: 2.25 }, signatures: [{ signedBy: 'E50001', stampId: 'STAMP-1', signedAt: '10:31' }] }] } });
    expect(legacyExecution).toContain('<td>2.25</td>');
    expect(legacyExecution).toContain('<td>E50001</td><td>STAMP-1</td><td>10:31</td>');
  });

  it('5/5：无 config_write 时前三组配置整表只读，capability_write 仍独立生效', async () => {
    usePermissionStore().permissions = ['card_read', 'capability_write'];
    const wrapper = mount(ConfigMaintenanceView, { global: { plugins: [ElementPlus, pinia] }, attachTo: document.body });
    await flushPromises();
    expect(wrapper.get('[data-testid="config-readonly-warning"]').text()).toContain('config_write');
    expect(wrapper.get('[data-testid="save-stage"]').attributes('disabled')).toBeDefined();
    expect(wrapper.vm.canWriteConfig).toBe(false);
    expect(wrapper.vm.canWriteCapabilities).toBe(true);
    wrapper.vm.activeTab = 'capability'; await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-testid="save-capability"]').attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });
});
