<script setup>
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { migrationApi } from '../../api/migrationApi.js';

const props = defineProps({ modelValue: Boolean });
const emit = defineEmits(['update:modelValue', 'completed']);
const file = ref(null);
const sourceChannel = ref('');
const loading = ref(false);
const preview = ref(null);
const rowsJson = ref('[]');
const report = ref(null);
const reasonLabels = { required_missing: '必填字段缺失', enum_invalid: '枚举值非法', duplicate: '编号/版本重复', database_constraint: '数据库约束', unexpected: '未分类错误' };
const isAssisted = computed(() => ['word', 'rtf'].includes(sourceChannel.value));
const reasonRows = computed(() => Object.entries(report.value?.byCategory || {}).map(([reason, count]) => ({ reason, label: reasonLabels[reason] || reason, count })));
const safePreviewHtml = computed(() => String(preview.value?.rawHtml || '')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*')/gi, '')
  .replace(/javascript:/gi, ''));
function close() { emit('update:modelValue', false); }
function detectChannel(name) {
  const extension = String(name).toLowerCase().split('.').pop();
  return ({ xlsx: 'excel', xls: 'excel', csv: 'csv', docx: 'word', rtf: 'rtf' })[extension] || '';
}
function selectFile(event) {
  file.value = event.target.files?.[0] || null;
  sourceChannel.value = detectChannel(file.value?.name);
  preview.value = null; report.value = null; rowsJson.value = '[]';
}
function candidateRows(result) {
  const prefix = `MIG-${Date.now()}`;
  return (result.candidateSteps || []).map((candidate, index) => ({
    task_no: `${prefix}-${String(index + 1).padStart(3, '0')}`,
    title: candidate.suggestedTitle || candidate.plainText || `迁移工卡 ${index + 1}`,
    card_type: '01', ac_type: '320', gear_type: 'MLG', stage: 'NRC', skill: 'AS',
    migration_preview_text: candidate.plainText,
  }));
}
async function canonicalReport(result) {
  if (!result?.batchId) return result;
  try { return await migrationApi.getReport(result.batchId); }
  catch { return result; }
}
async function importFile() {
  if (!file.value || !sourceChannel.value) { ElMessage.warning('请选择 Excel、CSV、Word 或 RTF 文件'); return; }
  loading.value = true;
  try {
    const result = await migrationApi.run(file.value, sourceChannel.value);
    if (isAssisted.value) {
      preview.value = result;
      rowsJson.value = JSON.stringify(candidateRows(result), null, 2);
      ElMessage.info('请核对并编辑候选数据，确认后才会写入');
    } else {
      report.value = await canonicalReport(result); emit('completed', report.value); ElMessage.success('迁移完成');
    }
  } catch (error) { ElMessage.error(error.message || '迁移处理失败'); }
  finally { loading.value = false; }
}
async function confirmPreview() {
  let rows;
  try { rows = JSON.parse(rowsJson.value); }
  catch { ElMessage.error('候选数据 JSON 格式无效'); return; }
  if (!Array.isArray(rows)) { ElMessage.error('候选数据必须是数组'); return; }
  loading.value = true;
  try {
    const result = await migrationApi.confirm({ sourceChannel: sourceChannel.value, sourceName: file.value?.name, rows });
    report.value = await canonicalReport(result); preview.value = null; emit('completed', report.value); ElMessage.success('人工确认迁移完成');
  } catch (error) { ElMessage.error(error.message || '确认迁移失败'); }
  finally { loading.value = false; }
}
watch(() => props.modelValue, (open) => { if (!open) return; file.value = null; sourceChannel.value = ''; preview.value = null; report.value = null; rowsJson.value = '[]'; });
defineExpose({ file, sourceChannel, preview, rowsJson, report, reasonRows, selectFile, importFile, confirmPreview });
</script>

<template>
  <el-dialog :model-value="modelValue" title="存量工卡迁移" width="860px" @close="close">
    <el-alert title="Excel/CSV 直接导入；Word/RTF 仅生成预览，人工编辑确认后写入" type="info" :closable="false" show-icon />
    <div class="upload-row"><input type="file" accept=".xlsx,.xls,.csv,.docx,.rtf" data-testid="migration-file" @change="selectFile" /><el-tag v-if="sourceChannel">{{ sourceChannel }}</el-tag><el-button type="primary" :loading="loading" data-testid="run-migration" @click="importFile">{{ isAssisted ? '生成预览' : '直接导入' }}</el-button></div>
    <section v-if="preview" data-testid="migration-preview">
      <h3>原文预览（{{ preview.candidateSteps?.length || 0 }} 段）</h3>
      <div class="raw-preview" v-html="safePreviewHtml" />
      <p>请编辑以下结构化候选数据；仅点击“确认迁移”后调用 /migrations/confirm。</p>
      <el-input v-model="rowsJson" type="textarea" :rows="14" data-testid="migration-rows-editor" />
      <el-button type="success" :loading="loading" data-testid="confirm-migration" @click="confirmPreview">确认迁移</el-button>
    </section>
    <section v-if="report" class="report" data-testid="migration-report">
      <h3>迁移结果报告</h3>
      <el-descriptions :column="3" border><el-descriptions-item label="总数">{{ report.batch?.totalCount ?? report.totalCount }}</el-descriptions-item><el-descriptions-item label="成功">{{ report.batch?.successCount ?? report.successCount }}</el-descriptions-item><el-descriptions-item label="失败">{{ report.batch?.failureCount ?? report.failureCount }}</el-descriptions-item></el-descriptions>
      <el-table :data="reasonRows" empty-text="无失败原因"><el-table-column prop="label" label="失败原因" /><el-table-column prop="reason" label="原因代码" /><el-table-column prop="count" label="数量" width="100" /></el-table>
    </section>
    <template #footer><el-button @click="close">关闭</el-button></template>
  </el-dialog>
</template>

<style scoped>.upload-row{display:flex;align-items:center;gap:10px;margin:16px 0}.upload-row input{flex:1}.raw-preview{max-height:180px;overflow:auto;padding:10px;border:1px solid #dcdfe6;background:#fafafa}.report,section{margin-top:16px}.report .el-table,.report .el-descriptions{margin-top:10px}section>.el-button{margin-top:10px}</style>
