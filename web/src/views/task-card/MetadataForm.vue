<script setup>
import { computed, reactive, watch } from 'vue';

const props = defineProps({
  modelValue: { type: Object, default: () => ({}) }, enums: { type: Object, default: () => ({}) },
  stageConfig: { type: Object, default: () => ({}) }, readonly: Boolean, mode: { type: String, default: 'edit' },
  organizationName: { type: String, default: '' }, jobContext: { type: Object, default: null },
});
const emit = defineEmits(['update:modelValue', 'check-revision']);
const form = reactive({});
let syncingFromParent = false;
watch(() => props.modelValue, (value) => {
  syncingFromParent = true;
  for (const key of Object.keys(form)) if (!(key in (value || {}))) delete form[key];
  Object.assign(form, value || {});
  syncingFromParent = false;
}, { deep: true, immediate: true, flush: 'sync' });
watch(form, (value) => {
  if (!syncingFromParent) emit('update:modelValue', { ...value });
}, { deep: true, flush: 'sync' });
const options = (name) => props.enums[name] || [];
const stageOptions = computed(() => {
  const configured = props.stageConfig?.byCardType?.[form.cardType]?.selectableStages;
  return configured?.length ? configured : options('stage');
});
const isIr = computed(() => form.cardType === '04');
const stageWarning = computed(() => {
  if (!form.cardType || !form.stage || stageOptions.value.includes(form.stage)) return '';
  return `${form.cardType} 类型允许的 Stage：${stageOptions.value.join('、')}`;
});
const revisionReadonly = computed(() => props.readonly || !['add', 'revise'].includes(props.mode));
function changeCardType(value) {
  const cfg = props.stageConfig?.byCardType?.[value];
  if (cfg?.defaultStage && !cfg.selectableStages?.includes(form.stage)) form.stage = cfg.defaultStage;
}
const executionFields = [
  ['owner', 'OWNER'], ['jobTargetDate', 'JOB TARGET DATE'], ['checkType', 'Check'], ['inboundGearPn', 'INBOUND GEAR P/N'],
  ['inboundSn', 'S/N'], ['csNo', 'CSNo.'], ['workOrder', 'WORK ORDER'], ['outboundGearPn', 'OUTBOUND GEAR P/N'],
];
const processFields = [['partNo', 'PART No'], ['partSn', 'PART S/N'], ['partDesc', 'PART DES.'], ['operationType', 'Operation Type']];
defineExpose({ form, stageOptions, stageWarning, isIr });
</script>

<template>
  <el-form :model="form" label-width="145px" data-testid="metadata-form">
    <el-alert v-if="stageWarning" :title="stageWarning" type="warning" :closable="false" data-testid="stage-combination-warning" />
    <el-row :gutter="16">
      <el-col :span="8"><el-form-item label="Organization"><span class="readonly-value" data-testid="organization-name">{{ organizationName || '—' }}</span></el-form-item></el-col>
      <el-col :span="8"><el-form-item label="Task No"><el-input v-model="form.taskNo" :disabled="readonly || mode === 'revise'" data-testid="task-no" /></el-form-item></el-col>
      <el-col :span="8"><el-form-item label="Title"><el-input v-model="form.title" :disabled="readonly" data-testid="title" /></el-form-item></el-col>
      <el-col :span="8"><el-form-item label="Revision"><el-input-number v-model="form.revision" :min="1" :disabled="revisionReadonly" data-testid="revision" @blur="emit('check-revision')" /></el-form-item></el-col>
      <el-col :span="8"><el-form-item label="Date"><el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" :disabled="readonly" data-testid="date" /></el-form-item></el-col>
      <el-col :span="8"><el-form-item label="A/C Type"><el-select v-model="form.acType" :disabled="readonly" data-testid="ac-type"><el-option v-for="value in options('acType')" :key="value" :value="value" /></el-select></el-form-item></el-col>
      <el-col :span="8"><el-form-item label="Gear Type"><el-select v-model="form.gearType" :disabled="readonly" data-testid="gear-type"><el-option v-for="value in options('gearType')" :key="value" :value="value" /></el-select></el-form-item></el-col>
      <el-col :span="8"><el-form-item label="WBS / 工卡类型"><el-select v-model="form.cardType" :disabled="readonly" data-testid="card-type" @change="changeCardType"><el-option v-for="value in options('cardType')" :key="value" :value="value" :label="value" /></el-select></el-form-item></el-col>
      <el-col :span="8"><el-form-item label="Stage"><el-select v-model="form.stage" :disabled="readonly" data-testid="stage-select"><el-option v-for="value in stageOptions" :key="value" :value="value" /></el-select><span class="sr-only" data-testid="stage-option-values">{{ stageOptions.join(',') }}</span></el-form-item></el-col>
      <el-col :span="8"><el-form-item label="Skill"><el-select v-model="form.skill" :disabled="readonly" data-testid="skill"><el-option v-for="value in options('skill')" :key="value" :value="value" /></el-select></el-form-item></el-col>
      <el-col :span="8"><el-form-item label="Ctrl Code"><el-select v-model="form.ctrlCode" :disabled="readonly" data-testid="ctrl-code"><el-option v-for="value in options('ctrlCode')" :key="value" :value="value" /></el-select></el-form-item></el-col>
      <el-col :span="8"><el-form-item label="Created By"><el-input v-model="form.createdBy" :disabled="readonly" data-testid="created-by" /></el-form-item></el-col>
      <el-col :span="8"><el-form-item label="NDT Reviewer"><el-input v-model="form.ndtReviewer" :disabled="readonly" data-testid="ndt-reviewer" /></el-form-item></el-col>
      <el-col :span="8"><el-form-item label="ATA Chapter"><el-input v-model="form.ataChapter" :disabled="readonly" data-testid="ata-chapter" /></el-form-item></el-col>
      <el-col :span="8"><el-form-item label="Check Type"><el-input v-model="form.checkType" :disabled="readonly" data-testid="check-type" /></el-form-item></el-col>
      <el-col :span="8"><el-form-item label="FAI"><el-switch v-model="form.isFai" :disabled="readonly" data-testid="is-fai" /></el-form-item></el-col>
      <el-col :span="8"><el-form-item label="Template Type"><el-input v-model="form.templateType" :disabled="readonly" data-testid="template-type" /></el-form-item></el-col>
      <template v-if="isIr"><el-col :span="8"><el-form-item label="Base Number"><el-input v-model="form.baseNumber" :disabled="readonly" data-testid="base-number" /></el-form-item></el-col>
        <el-col :span="8"><el-form-item label="IPC Item No"><el-input v-model="form.ipcItemNo" :disabled="readonly" data-testid="ipc-item-no" /></el-form-item></el-col></template>
      <el-col :span="8"><el-form-item label="Document Type"><el-input v-model="form.documentType" :disabled="readonly" data-testid="document-type" /></el-form-item></el-col>
      <el-col :span="8"><el-form-item label="Ref No"><el-input v-model="form.refNo" :disabled="readonly" data-testid="document-ref-no" /></el-form-item></el-col>
      <el-col :span="8"><el-form-item label="Document Revision"><el-input v-model="form.documentRevision" :disabled="readonly" data-testid="document-revision" /></el-form-item></el-col>
      <el-col :span="24"><el-form-item label="Document Desc"><el-input v-model="form.documentDesc" :disabled="readonly" data-testid="document-desc" /></el-form-item></el-col>
    </el-row>
    <template v-if="jobContext">
      <el-divider content-position="left">JOB 执行字段（只读）</el-divider>
      <el-descriptions :column="4" border data-testid="execution-fields">
        <el-descriptions-item v-for="([key,label]) in executionFields" :key="key" :label="label"><span :data-testid="`job-${key}`">{{ jobContext[key] ?? '—' }}</span></el-descriptions-item>
      </el-descriptions>
      <el-divider content-position="left">Process Card 字段（只读）</el-divider>
      <el-descriptions :column="4" border data-testid="process-card-fields">
        <el-descriptions-item v-for="([key,label]) in processFields" :key="key" :label="label"><span :data-testid="`process-${key}`">{{ jobContext[key] ?? '—' }}</span></el-descriptions-item>
      </el-descriptions>
    </template>
  </el-form>
</template>
<style scoped>.readonly-value{display:inline-block;min-height:32px;color:#303133}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}.el-select,.el-input,.el-date-editor{width:100%}</style>