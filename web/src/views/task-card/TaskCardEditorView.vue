<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useRoute, useRouter } from 'vue-router';
import { taskCardApi } from '../../api/taskCardApi.js';
import { configApi } from '../../api/configApi.js';
import { bomApi } from '../../api/bomApi.js';
import { classificationApi } from '../../api/classificationApi.js';
import MetadataForm from './MetadataForm.vue';
import ReferenceDocTable from './ReferenceDocTable.vue';
import CardRelationPanel from './CardRelationPanel.vue';
import LotLinkPanel from './LotLinkPanel.vue';
import BomBaseTable from './BomBaseTable.vue';
import ReviewPanel from './ReviewPanel.vue';
import ClassificationConfirmDialog from './ClassificationConfirmDialog.vue';
import ProcessStepList from './ProcessStepList.vue';
import VersionHistoryPanel from './VersionHistoryPanel.vue';
import { usePermissionStore } from '../../stores/permission.js';

const route = useRoute(); const router = useRouter(); const permissionStore = usePermissionStore();
const mode = computed(() => ['add', 'edit', 'view', 'revise'].includes(String(route.query.mode)) ? String(route.query.mode) : 'add');
const sourceId = computed(() => route.query.id); const jobNo = computed(() => route.query.jobNo);
const activeTab = ref('metadata'); const loading = ref(false); const saving = ref(false);
const card = reactive({ status: 'New', revision: 1, date: new Date().toISOString().slice(0, 10), isFai: false });
const enums = ref({}); const stageConfig = ref({}); const organizationName = ref('');
const pendingReferences = ref([]); const bomBases = ref([]); const changeReason = ref('');
const classificationOpen = ref(false); const classificationResult = ref(null); const duplicateMessage = ref('');
const canEdit = computed(() => permissionStore.hasPermission('card_edit'));
const readonly = computed(() => mode.value === 'view' || card.status !== 'New' || !canEdit.value);
const pendingRevision = computed(() => mode.value === 'revise' && String(card.id ?? '') === String(sourceId.value ?? ''));
const authoringReadonly = computed(() => readonly.value || pendingRevision.value);
const classificationPending = computed(() => classificationResult.value?.status === 'requires_confirmation');
const showReviseNotice = computed(() => mode.value !== 'view' && card.status !== 'New');
const title = computed(() => ({ add: '新增工卡', edit: '编辑工卡', view: '查看工卡', revise: '工卡升版' }[mode.value]));
const references = computed(() => card.id ? (card.referenceDocuments || []) : pendingReferences.value);
const steps = computed(() => card.steps || []);
const jobContext = computed(() => card.jobContext || null);

function parameterValue(rows, key) { return (rows || []).find((row) => row.key === key)?.value || ''; }
async function loadConfig() {
  const [enumValues, constraints, parameters] = await Promise.all([configApi.getEnums(), configApi.getStageConstraints(), configApi.getSystemParameters()]);
  enums.value = enumValues; stageConfig.value = constraints; organizationName.value = parameterValue(parameters, 'organizationName');
}
async function loadCard() {
  if (mode.value === 'add' || !sourceId.value) return;
  const detail = await taskCardApi.get(sourceId.value, jobNo.value ? { jobNo: jobNo.value } : undefined);
  Object.assign(card, detail);
  classificationResult.value = await classificationApi.latest(detail.id ?? sourceId.value);
  if (mode.value === 'revise') { card.revision = Number(detail.revision || 0) + 1; card.status = 'New'; }
  if (card.cardType === '05') await refreshBom();
}
async function refreshCard() { if (card.id) Object.assign(card, await taskCardApi.get(card.id)); }
async function refreshBom() { if (card.id || sourceId.value) bomBases.value = await bomApi.listBases(card.id || sourceId.value); }
async function checkRevision() {
  if (!card.taskNo || !card.revision) return true;
  try {
    const result = await taskCardApi.checkDuplicate({ taskNo: card.taskNo, revision: card.revision, ...(card.id && mode.value !== 'revise' ? { excludeId: card.id } : {}) });
    duplicateMessage.value = result.duplicate ? (result.message || `工卡编号 ${card.taskNo} 的版本 ${card.revision} 已存在`) : '';
    return !result.duplicate;
  } catch (error) { duplicateMessage.value = error.status === 409 ? error.message : ''; return false; }
}
function applyTpc(doc) { Object.assign(card, doc); }
async function addReference(doc) {
  if (card.id) { await taskCardApi.addReferenceDocument(card.id, doc); Object.assign(card, await taskCardApi.get(card.id)); }
  else pendingReferences.value.push({ ...doc, id: `pending-${Date.now()}` });
}
async function removeReference(doc) {
  if (card.id && !String(doc.id).startsWith('pending-')) {
    if (!changeReason.value.trim()) { ElMessage.warning('删除参考文件前请填写变更原因'); return; }
    await taskCardApi.deleteReferenceDocument(card.id, doc.id, { reason: changeReason.value.trim() });
    Object.assign(card, await taskCardApi.get(card.id));
  } else pendingReferences.value = pendingReferences.value.filter((row) => row.id !== doc.id);
}
function authoringPayload(extra = {}) {
  const payload = { ...card, ...extra };
  delete payload.commercialClassification;
  delete payload.outsourceSubtype;
  delete payload.commercial_classification;
  delete payload.outsource_subtype;
  return payload;
}
async function save() {
  if (readonly.value) return;
  if (!(await checkRevision())) { ElMessage.error(duplicateMessage.value || '版本号已存在'); return; }
  saving.value = true;
  try {
    let saved;
    if (mode.value === 'revise') {
      if (!changeReason.value.trim()) { ElMessage.warning('升版原因必填'); return; }
      const reason = changeReason.value.trim();
      const result = await taskCardApi.revise({ ids: [sourceId.value], reason, revision: card.revision });
      saved = await taskCardApi.update(result[0].id, authoringPayload({ reason }));
    } else if (!card.id) saved = await taskCardApi.create(authoringPayload());
    else {
      if (!changeReason.value.trim()) { ElMessage.warning('变更原因必填'); return; }
      saved = await taskCardApi.update(card.id, authoringPayload({ reason: changeReason.value.trim() }));
    }
    if (!card.id && pendingReferences.value.length) for (const doc of pendingReferences.value) await taskCardApi.addReferenceDocument(saved.id, doc);
    Object.assign(card, await taskCardApi.get(saved.id)); pendingReferences.value = []; ElMessage.success('工卡已保存');
    classificationResult.value = await classificationApi.latest(saved.id);
    await router.replace({ name: 'task-card-editor', query: { mode: 'edit', id: saved.id, ...(jobNo.value ? { jobNo: jobNo.value } : {}) } });
  } catch (error) { duplicateMessage.value = error.status === 409 ? error.message : ''; ElMessage.error(error.message || '保存失败'); }
  finally { saving.value = false; }
}
function onClassificationDerived(result) {
  classificationResult.value = result;
  if (result?.status === 'derived' && result.classification) {
    card.commercialClassification = result.classification;
    card.outsourceSubtype = result.classification === 'Outsource' ? result.outsourceSubtype : null;
  }
}
function onClassificationRequired(result) {
  if (result?.status === 'requires_confirmation') classificationResult.value = result;
  classificationOpen.value = true;
}
function onClassificationConfirmed(result) {
  classificationResult.value = result;
  card.commercialClassification = result.classification;
  card.outsourceSubtype = result.classification === 'Outsource' ? result.outsourceSubtype : null;
}
function onStatusChange(updated) { Object.assign(card, updated); }
async function onReleased(result) { await router.push({ name: 'job', params: { jobNo: result.jobNo } }); }
onMounted(async () => { loading.value = true; try { await Promise.all([loadConfig(), loadCard()]); } catch (error) { ElMessage.error(error.message || '工卡编制界面加载失败'); } finally { loading.value = false; } });
defineExpose({ card, mode, readonly, activeTab, changeReason, duplicateMessage, classificationResult, classificationPending, save, checkRevision, applyTpc });
</script>

<template>
  <section class="task-card-editor" data-testid="task-card-editor-view" v-loading="loading">
    <el-card shadow="never">
      <template #header><div class="page-heading"><div><h1>{{ title }}</h1><p>Task Card Editor · {{ mode }}</p></div><el-tag :type="card.status === 'New' ? 'success' : 'info'">{{ card.status }}</el-tag></div></template>
      <el-alert v-if="showReviseNotice" title="当前版本只读，变更请先执行升版" type="warning" :closable="false" show-icon data-testid="revise-notice" />
      <el-alert v-else-if="!canEdit" title="当前身份无 card_edit 权限，编制内容只读" type="warning" :closable="false" show-icon data-testid="permission-readonly-notice" />
      <el-alert v-if="duplicateMessage" :title="duplicateMessage" type="error" :closable="false" data-testid="revision-duplicate" />
      <div class="editor-actions"><el-button @click="router.push({ name: 'task-card-list' })">返回</el-button>
        <el-button type="primary" :disabled="readonly || pendingRevision || !card.id" data-testid="open-classification" @click="classificationOpen = true">商务分类</el-button>
        <el-input v-if="!readonly" v-model="changeReason" placeholder="变更/升版原因" data-testid="change-reason" />
        <el-button v-if="!readonly" type="primary" :loading="saving" data-testid="save-card" @click="save">保存</el-button></div>
      <el-tabs v-model="activeTab" data-testid="editor-tabs">
        <el-tab-pane label="基础信息" name="metadata"><MetadataForm :model-value="card" :enums="enums" :stage-config="stageConfig" :readonly="readonly" :mode="mode" :organization-name="organizationName" :job-context="jobContext" @update:model-value="Object.assign(card, $event)" @check-revision="checkRevision" /></el-tab-pane>
        <el-tab-pane label="参考文件" name="references"><el-alert v-if="pendingRevision" title="请先保存新版本，再维护参考文件" type="info" :closable="false" /><ReferenceDocTable :rows="references" :readonly="authoringReadonly" @add="addReference" @remove="removeReference" @tpc-select="applyTpc" /></el-tab-pane>
        <el-tab-pane label="工序" name="steps"><el-alert v-if="!card.id" title="请先保存工卡后维护工序" type="info" :closable="false" /><ProcessStepList v-else :card-id="card.id" :rows="steps" :readonly="authoringReadonly" @refresh="refreshCard" /></el-tab-pane>
        <el-tab-pane label="关联工卡" name="relations"><el-alert v-if="!card.id" title="请先保存工卡后维护关联" type="info" :closable="false" /><CardRelationPanel v-else :card-id="card.id" :rows="card.relations || []" :readonly="authoringReadonly" />
          <template v-if="card.cardType === '05'"><el-divider content-position="left">Lot List 关联</el-divider><LotLinkPanel v-if="card.id" :card-id="card.id" :readonly="authoringReadonly" @update="refreshBom" /><el-divider content-position="left">BOM Base（IR 卡 + Lot List 两来源）</el-divider><BomBaseTable :rows="bomBases" /></template></el-tab-pane>
        <el-tab-pane label="审核记录" name="review"><el-alert v-if="pendingRevision" title="请先保存新版本，再提交审核" type="info" :closable="false" /><ReviewPanel v-else-if="card.id" :card-id="card.id" :status="card.status" :revision="card.revision" :card-type="card.cardType || ''" :classification-pending="classificationPending" :commercial-classification="card.commercialClassification || ''" @status-change="onStatusChange" @classification-required="onClassificationRequired" @released="onReleased" /><el-empty v-else description="保存后可查看审核记录" /></el-tab-pane>
        <el-tab-pane label="版本历史" name="history"><VersionHistoryPanel v-if="card.id" :card-id="card.id" /><el-empty v-else description="保存后可查看版本历史" /></el-tab-pane>
      </el-tabs>
    </el-card>
    <ClassificationConfirmDialog v-model="classificationOpen" :card-id="card.id" :card-type="card.cardType || ''" :classification-result="classificationResult" @derived="onClassificationDerived" @confirmed="onClassificationConfirmed" />
  </section>
</template>
<style scoped>.task-card-editor{min-width:980px}.page-heading{display:flex;align-items:center;justify-content:space-between}.page-heading h1{margin:0;color:#12395b;font-size:22px}.page-heading p{margin:3px 0 0;color:#909399;font-size:12px}.editor-actions,.step-actions{display:flex;align-items:center;gap:8px;margin:12px 0}.editor-actions .el-input{margin-left:auto;max-width:320px}.el-alert{margin-bottom:12px}</style>
