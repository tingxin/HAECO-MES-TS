<script setup>
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useRoute } from 'vue-router';
import { jobApi } from '../../api/jobApi.js';
import { taskCardApi } from '../../api/taskCardApi.js';
import BarcodeView from './BarcodeView.vue';
import SafetyAckDialog from './SafetyAckDialog.vue';
import ElectronicSignaturePanel from './ElectronicSignaturePanel.vue';
import ProcessComponentPreview from '../task-card/ProcessComponentPreview.vue';
import { printTriples } from '../output/printRenderer.js';

const route = useRoute();
const jobNo = computed(() => String(route.params.jobNo || ''));
const job = ref(null);
const loading = ref(false);
const actionId = ref(null);
const safetyOpen = ref(false);
const safetyProcess = ref(null);
const acknowledged = ref(new Set());
const processes = computed(() => job.value?.processes || []);
const executionFields = [
  ['OWNER', 'owner'], ['JOB TARGET DATE', 'jobTargetDate'], ['Check', 'checkType'],
  ['进厂 P/N', 'inboundGearPn'], ['进厂 S/N', 'inboundSn'], ['出厂 P/N', 'outboundGearPn'],
  ['出厂 S/N', 'outboundSn'], ['CSNo.', 'csNo'], ['WORK ORDER', 'workOrder'],
];
const processCardFields = [['PART No.', 'partNo'], ['PART S/N', 'partSn'], ['PART DES.', 'partDesc'], ['Operation Type', 'operationType']];
function contentOf(process) { return process.snapshot?.content || {}; }
function isCritical(process) { return Boolean(contentOf(process).isCritical); }
function canStart(process) { return !process.startTime && (!isCritical(process) || acknowledged.value.has(String(process.id))); }
function display(value) { return value === null || value === undefined || value === '' ? '—' : String(value); }
async function load() {
  loading.value = true;
  try { job.value = await jobApi.get(jobNo.value); }
  catch (error) { ElMessage.error(error.message || 'JOB 加载失败'); }
  finally { loading.value = false; }
}
function openSafety(process) { safetyProcess.value = process; safetyOpen.value = true; }
function onAcknowledged({ processId }) {
  acknowledged.value = new Set([...acknowledged.value, String(processId)]);
}
async function start(process) {
  if (!canStart(process)) return;
  actionId.value = process.id;
  try { await jobApi.startProcess(process.id); await load(); ElMessage.success(`工序 ${process.processId} 已开始`); }
  catch (error) { ElMessage.error(error.message || '工序开始失败'); }
  finally { actionId.value = null; }
}
async function finish(process) {
  if (!process.startTime || process.finishTime) return;
  actionId.value = process.id;
  try { await jobApi.finishProcess(process.id); await load(); ElMessage.success(`工序 ${process.processId} 已完成`); }
  catch (error) { ElMessage.error(error.message || '工序完成失败'); }
  finally { actionId.value = null; }
}
async function printJob() {
  try { printTriples(await taskCardApi.getPrintModel(job.value.cardId, { jobNo: jobNo.value })); }
  catch (error) { ElMessage.error(error.message || 'JOB 打印失败'); }
}
onMounted(load);
defineExpose({ job, processes, acknowledged, safetyProcess, load, canStart, start, finish, onAcknowledged, printJob });
</script>

<template>
  <section class="job-viewer" data-testid="job-viewer-view" v-loading="loading">
    <el-card v-if="job" shadow="never">
      <template #header><div class="heading"><div><h1>JOB {{ job.jobNo }}</h1><p>工卡 {{ job.cardId }} · Rev.{{ job.cardRevision }}</p></div><div><el-tag>{{ job.execStatus }}</el-tag><el-button type="primary" data-testid="print-job" @click="printJob">打印 JOB</el-button></div></div></template>
      <el-descriptions title="执行上下文（只读）" :column="4" border data-testid="job-execution-fields">
        <el-descriptions-item v-for="([label, key]) in executionFields" :key="key" :label="label">{{ display(job[key]) }}</el-descriptions-item>
      </el-descriptions>
      <el-descriptions title="Process Card（只读）" :column="4" border data-testid="job-process-card-fields">
        <el-descriptions-item v-for="([label, key]) in processCardFields" :key="key" :label="label">{{ display(job[key]) }}</el-descriptions-item>
      </el-descriptions>
      <el-descriptions title="工卡报工时间（只读）" :column="2" border data-testid="job-times">
        <el-descriptions-item label="开始时间">{{ display(job.startTime) }}</el-descriptions-item><el-descriptions-item label="结束时间">{{ display(job.finishTime) }}</el-descriptions-item>
      </el-descriptions>
    </el-card>

    <el-card v-for="process in processes" :key="process.id" shadow="never" class="process-card" :data-process-id="process.processId">
      <template #header><div class="heading"><div><h2>工序 {{ process.processId }} <el-tag v-if="isCritical(process)" type="danger" size="small">关键工序</el-tag></h2><small>内容快照：{{ process.snapshot?.snapshotAt || '—' }}</small></div><BarcodeView :value="process.barcodeValue" :type="process.barcodeType" /></div></template>
      <article class="snapshot" data-testid="snapshot-content">
        <h3>{{ display(contentOf(process).descriptionZh) }}</h3><p>{{ display(contentOf(process).descriptionEn) }}</p>
        <el-alert v-if="contentOf(process).safetyWarning" :title="typeof contentOf(process).safetyWarning === 'string' ? contentOf(process).safetyWarning : (contentOf(process).safetyWarning.content || contentOf(process).safetyWarning.text)" type="warning" :closable="false" show-icon />
        <dl><template v-for="key in ['skill', 'refDoc', 'repairTips', 'operation']" :key="key"><dt>{{ key }}</dt><dd>{{ display(typeof contentOf(process)[key] === 'object' ? JSON.stringify(contentOf(process)[key]) : contentOf(process)[key]) }}</dd></template></dl>
        <div v-if="contentOf(process).components?.length" class="components"><b>插入组件</b><ProcessComponentPreview v-for="(component,index) in contentOf(process).components" :key="component.id || index" :component="component" /></div>
      </article>
      <el-descriptions :column="4" border class="process-times" data-testid="process-times">
        <el-descriptions-item label="开始时间">{{ display(process.startTime) }}</el-descriptions-item><el-descriptions-item label="结束时间">{{ display(process.finishTime) }}</el-descriptions-item>
        <el-descriptions-item label="有效工时">{{ display(process.effectiveManHours) }}</el-descriptions-item><el-descriptions-item label="实际工时">{{ display(process.actualManHours) }}</el-descriptions-item>
      </el-descriptions>
      <div class="actions">
        <el-button v-if="isCritical(process) && !acknowledged.has(String(process.id))" type="warning" :disabled="Boolean(process.startTime)" :data-testid="`ack-${process.id}`" @click="openSafety(process)">查看并确认安全警示</el-button>
        <el-button type="primary" :disabled="!canStart(process)" :loading="actionId === process.id" :data-testid="`start-${process.id}`" @click="start(process)">进入执行</el-button>
        <el-button type="success" :disabled="!process.startTime || Boolean(process.finishTime)" :loading="actionId === process.id" :data-testid="`finish-${process.id}`" @click="finish(process)">完成工序</el-button>
        <span v-if="isCritical(process) && !acknowledged.has(String(process.id))" class="gate-message">安全警示未确认，禁止进入执行</span>
      </div>
    </el-card>

    <ElectronicSignaturePanel v-if="job" :card-id="job.cardId" :job-id="job.id" :job-no="job.jobNo" :processes="processes" />
    <SafetyAckDialog v-model="safetyOpen" :process="safetyProcess" @acknowledged="onAcknowledged" />
  </section>
</template>

<style scoped>
.job-viewer{min-width:980px}.heading{display:flex;align-items:center;justify-content:space-between;gap:16px}.heading>div:last-child{display:flex;align-items:center;gap:10px}h1,h2{margin:0;color:#12395b}h1{font-size:22px}h2{font-size:17px}.heading p{margin:4px 0 0;color:#909399}.process-card,.el-descriptions{margin-top:16px}.snapshot{padding:4px 0}.snapshot h3{margin:8px 0;color:#303133}.snapshot p{white-space:pre-wrap;line-height:1.6}.snapshot dl{display:grid;grid-template-columns:110px 1fr;margin:12px 0}.snapshot dt,.snapshot dd{margin:0;padding:6px;border-bottom:1px solid #ebeef5}.snapshot dt{font-weight:600;color:#606266}.components{margin-top:12px}.actions{display:flex;align-items:center;gap:8px;margin-top:12px}.gate-message{color:#e6a23c;font-size:13px}
</style>
