<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useRoute, useRouter } from 'vue-router';
import { taskCardApi } from '../../api/taskCardApi.js';
import { stepApi } from '../../api/stepApi.js';
import { configApi } from '../../api/configApi.js';
import { integrationApi } from '../../api/integrationApi.js';
import CaptureItemEditor from './CaptureItemEditor.vue';
import ComponentInserter from './ComponentInserter.vue';
import ProcessComponentEditor from './ProcessComponentEditor.vue';
import SignatureRequirementPanel from './SignatureRequirementPanel.vue';
import SafetyWarningEditor from './SafetyWarningEditor.vue';
import ProcessComponentPreview from './ProcessComponentPreview.vue';
import { usePermissionStore } from '../../stores/permission.js';
import { newComponent } from './processStepOptions.js';
import { hasStructuredTable, normalizeComponent } from './structuredPayload.js';
const route = useRoute(); const router = useRouter(); const permissionStore = usePermissionStore();
const cardId = computed(() => route.query.cardId ?? route.query.id); const stepId = computed(() => route.query.stepId);
const loading = ref(false); const saving = ref(false); const card = reactive({ status: 'New', referenceDocuments: [], steps: [] });
const step = reactive({ processId: '', skill: '', refDocId: null, descriptionZh: '', descriptionEn: '', captureItems: [], components: [], signatureRequirements: [], safetyWarning: '', visualCue: null, repairTips: '', isCritical: false });
const enums = ref({ componentType: [], signatureRole: [], skill: [] }); const processData = ref({}); const ppcData = ref({});
const templates = ref([]); const selectedTemplate = ref(); const templateName = ref(''); const changeReason = ref('');
const canAuthor = computed(() => String(route.query.mode || '') !== 'view' && card.status === 'New' && permissionStore.hasPermission('card_edit'));
const readonly = computed(() => !canAuthor.value);
const imageComponents = computed(() => step.components.filter((item) => item.type === 'image' && item.payload?.url));
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function assignStep(value = {}) {
  const next = clone(value); next.components = (next.components || []).map(normalizeComponent);
  Object.assign(step, { processId: '', skill: '', refDocId: null, descriptionZh: '', descriptionEn: '', captureItems: [], components: [], signatureRequirements: [], safetyWarning: '', visualCue: null, repairTips: '', isCritical: false }, next);
}
async function load() {
  if (!cardId.value) throw new Error('缺少 cardId，无法加载工序');
  const [detail, enumValues, templateRows] = await Promise.all([taskCardApi.get(cardId.value), configApi.getEnums(), stepApi.listTemplates()]);
  Object.assign(card, detail); enums.value = enumValues; templates.value = templateRows;
  const selected = detail.steps?.find((row) => String(row.id) === String(stepId.value)) ?? (!stepId.value ? null : undefined);
  if (stepId.value && !selected) throw new Error('工序不存在或不属于当前工卡'); assignStep(selected || {});
  const query = { cardId: cardId.value, ...(step.id ? { stepId: step.id } : {}), ...(detail.pid ? { pid: detail.pid } : {}) };
  const [pd, ppcRows] = await Promise.all([integrationApi.getProcessData(query), integrationApi.getPpcProcessData({ cardId: cardId.value, ...(step.id ? { stepId: step.id } : {}) })]);
  processData.value = pd || {}; ppcData.value = (ppcRows || []).find((row) => String(row.stepId) === String(step.id)) ?? ppcRows?.[0] ?? {};
}
function writablePayload(reason) {
  return { skill: step.skill || null, refDocId: step.refDocId || null, descriptionZh: step.descriptionZh, descriptionEn: step.descriptionEn, safetyWarning: step.safetyWarning, visualCue: clone(step.visualCue), repairTips: step.repairTips, isCritical: Boolean(step.isCritical), captureItems: clone(step.captureItems), components: clone(step.components).map((item, index) => ({ ...normalizeComponent(item), sortOrder: index + 1 })), signatureRequirements: clone(step.signatureRequirements), ...(reason ? { reason } : {}) };
}
async function save(showMessage = true, overrideReason = '') {
  if (readonly.value) return null; saving.value = true;
  try {
    const reason = overrideReason || changeReason.value.trim();
    if (step.id && !reason) { ElMessage.warning('保存已有工序前请填写变更原因'); return null; }
    const result = step.id ? await stepApi.update(cardId.value, step.id, writablePayload(reason)) : await stepApi.create(cardId.value, writablePayload());
    assignStep(result); if (showMessage) ElMessage.success('工序已保存');
    if (!stepId.value) await router.replace({ name: 'task-card-step', query: { cardId: cardId.value, stepId: result.id, mode: 'edit' } });
    return result;
  } catch (error) { ElMessage.error(error.message || '工序保存失败'); return null; }
  finally { saving.value = false; }
}
function insertComponent(type) {
  if (readonly.value) return;
  if (['tool', 'consumable'].includes(type) && hasStructuredTable(step.components, type)) {
    ElMessage.warning(`${type === 'tool' ? '工具' : '耗材'}表每道工序最多一个`); return;
  }
  step.components.push(newComponent(type, step.components.length + 1));
}
function updateComponent(index, value) { step.components[index] = value; }
function removeComponent(index) { step.components.splice(index, 1); }
async function saveTemplate() {
  const name = templateName.value.trim(); if (!name) return ElMessage.warning('请输入模板名称');
  const synced = await save(false, changeReason.value.trim() || '保存工序模板前同步内容'); if (!synced) return;
  try { const created = await stepApi.createTemplate({ name, stepId: step.id }); templates.value = await stepApi.listTemplates(); selectedTemplate.value = created.id; templateName.value = ''; ElMessage.success('工序模板已保存'); }
  catch (error) { ElMessage.error(error.message || '模板保存失败'); }
}
async function applyTemplate() {
  if (!selectedTemplate.value || !step.id || readonly.value) return;
  try { const result = await stepApi.applyTemplate(cardId.value, step.id, { templateId: selectedTemplate.value, reason: changeReason.value.trim() || '套用工序模板' }); assignStep(result); ElMessage.success('模板已应用并还原工序内容'); }
  catch (error) { ElMessage.error(error.message || '模板应用失败'); }
}
function back() { router.push({ name: 'task-card-editor', query: { mode: readonly.value ? 'view' : 'edit', id: cardId.value } }); }
onMounted(async () => { loading.value = true; try { await load(); } catch (error) { ElMessage.error(error.message || '工序加载失败'); } finally { loading.value = false; } });
defineExpose({ card, step, enums, readonly, processData, ppcData, templates, selectedTemplate, templateName, changeReason, save, insertComponent, saveTemplate, applyTemplate });
</script>
<template>
  <section class="step-editor" data-testid="process-step-editor-view" v-loading="loading">
    <el-page-header title="工卡编制" content="工序信息编辑" @back="back" />
    <el-alert v-if="readonly" title="仅 New 编制域可写；当前工卡工序以只读方式展示" type="warning" :closable="false" show-icon data-testid="step-readonly-notice" />
    <el-card shadow="never">
      <template #header><div class="card-heading"><strong>工序属性</strong><el-tag>{{ card.status }}</el-tag></div></template>
      <el-descriptions :column="3" border data-testid="readonly-properties">
        <el-descriptions-item label="Process ID"><span data-testid="process-id-value">{{ step.processId || '保存后自动生成' }}</span></el-descriptions-item>
        <el-descriptions-item label="Operation"><span data-testid="operation-value">{{ processData.operation ?? step.operation ?? '—' }}</span></el-descriptions-item>
        <el-descriptions-item label="PPC Work Category"><span data-testid="work-category-value">{{ ppcData.workCategory ?? step.workCategory ?? '—' }}</span></el-descriptions-item>
        <el-descriptions-item label="Estimated ManHours"><span data-testid="estimated-hours-value">{{ ppcData.estimatedManHours ?? step.estimatedManHours ?? '—' }}</span></el-descriptions-item>
        <el-descriptions-item label="Effective ManHours"><span data-testid="effective-hours-value">{{ step.effectiveManHours ?? '—' }}</span></el-descriptions-item>
        <el-descriptions-item label="Actual ManHours"><span data-testid="actual-hours-value">{{ step.actualManHours ?? '—' }}</span></el-descriptions-item>
      </el-descriptions>
      <el-form class="editable-properties" label-width="90px"><el-form-item label="Skill"><el-select v-model="step.skill" :disabled="readonly"><el-option v-for="value in enums.skill || []" :key="value" :label="value" :value="value" /></el-select></el-form-item><el-form-item label="Ref Doc"><el-select v-model="step.refDocId" clearable :disabled="readonly"><el-option v-for="doc in card.referenceDocuments || []" :key="doc.id" :label="`${doc.refNo || ''} ${doc.documentRevision || ''}`" :value="doc.id" /></el-select></el-form-item></el-form>
    </el-card>
    <el-card shadow="never"><template #header><strong>双语图文步骤描述</strong></template><div class="description-grid"><el-input v-model="step.descriptionZh" type="textarea" :rows="5" :disabled="readonly" placeholder="中文步骤描述" data-testid="description-zh" /><el-input v-model="step.descriptionEn" type="textarea" :rows="5" :disabled="readonly" placeholder="English step description" data-testid="description-en" /></div><div v-if="imageComponents.length" class="inline-images"><ProcessComponentPreview v-for="item in imageComponents" :key="item.id || item.payload.url" :component="item" compact /></div></el-card>
    <el-card shadow="never"><template #header><strong>数据采集项</strong></template><CaptureItemEditor v-model="step.captureItems" :types="enums.componentType || []" :readonly="readonly" /></el-card>
    <el-card shadow="never"><template #header><strong>工序组件</strong></template><ComponentInserter :types="enums.componentType || []" :used-types="step.components.map(item => item.type)" :readonly="readonly" @insert="insertComponent" /><ProcessComponentEditor v-for="(item,index) in step.components" :key="item.id || `${item.type}-${index}`" :model-value="item" :readonly="readonly" @update:model-value="updateComponent(index,$event)" @remove="removeComponent(index)" /></el-card>
    <el-card shadow="never"><template #header><strong>签署项</strong></template><SignatureRequirementPanel v-model="step.signatureRequirements" :roles="enums.signatureRole || []" :readonly="readonly" /></el-card>
    <el-card shadow="never"><template #header><strong>安全警示与维修提示</strong></template><SafetyWarningEditor :model-value="step" :readonly="readonly" @update:model-value="assignStep" /></el-card>
    <el-card shadow="never"><template #header><strong>工序模板</strong></template><div class="template-actions"><el-select v-model="selectedTemplate" placeholder="选择工序模板"><el-option v-for="item in templates" :key="item.id" :label="item.name" :value="item.id" /></el-select><el-button :disabled="readonly || !selectedTemplate || !step.id" data-testid="apply-template" @click="applyTemplate">应用模板</el-button><el-input v-if="!readonly" v-model="templateName" placeholder="模板名称" /><el-button v-if="!readonly" data-testid="save-template" @click="saveTemplate">保存为模板</el-button></div></el-card>
    <div class="footer-actions"><el-input v-if="!readonly && step.id" v-model="changeReason" placeholder="变更原因（保存已有工序必填）" data-testid="step-change-reason" /><el-button @click="back">返回</el-button><el-button v-if="!readonly" type="primary" :loading="saving" data-testid="save-step" @click="save()">保存工序</el-button></div>
  </section>
</template>
<style scoped>.step-editor{min-width:980px}.step-editor>.el-card{margin-top:14px}.step-editor>.el-alert{margin-top:12px}.card-heading,.footer-actions,.template-actions{display:flex;align-items:center;justify-content:space-between;gap:10px}.editable-properties{display:grid;grid-template-columns:1fr 2fr;gap:16px;margin-top:16px}.description-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.inline-images{display:flex;gap:12px;margin-top:12px}.inline-images figure{margin:0;width:220px}.inline-images .el-image{width:220px;height:140px}.inline-images figcaption{font-size:12px;color:#606266}.template-actions{justify-content:flex-start}.template-actions .el-select{width:260px}.template-actions .el-input{width:260px;margin-left:auto}.footer-actions{margin-top:16px;justify-content:flex-end}.footer-actions .el-input{max-width:420px;margin-right:auto}</style>
