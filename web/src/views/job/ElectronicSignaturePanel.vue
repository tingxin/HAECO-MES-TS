<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { taskCardApi } from '../../api/taskCardApi.js';

const props = defineProps({
  cardId: { type: [Number, String], required: true }, jobId: { type: [Number, String], required: true },
  jobNo: { type: String, required: true }, processes: { type: Array, default: () => [] },
});
const archive = ref(null);
const loading = ref(false);
const signingId = ref(null);
const stampIds = reactive({});
const signedRecords = reactive({});
const requirements = computed(() => props.processes.flatMap((process) => {
  const rows = process.snapshot?.content?.signatureRequirements;
  return (Array.isArray(rows) ? rows : []).map((requirement) => ({ ...requirement, processId: process.processId }));
}));
const missingIds = computed(() => new Set((archive.value?.missing || []).map(({ requirement }) => String(requirement?.id))));
const archivedRecords = computed(() => Object.fromEntries((archive.value?.satisfied || []).map(({ requirement, signature }) => [String(requirement?.id), signature])));
function requirementId(requirement) { return requirement.id ?? requirement.signatureRequirementId; }
function recordFor(requirement) {
  const id = String(requirementId(requirement));
  return signedRecords[id] || archivedRecords.value[id] || null;
}
function isSigned(requirement) {
  const id = String(requirementId(requirement));
  if (signedRecords[id] || archivedRecords.value[id]) return true;
  return archive.value?.ok || (archive.value && !missingIds.value.has(id));
}
async function refreshArchive() {
  if (!props.cardId || !props.jobNo) return;
  loading.value = true;
  try { archive.value = await taskCardApi.getArchiveStatus(props.cardId, { jobNo: props.jobNo }); }
  catch (error) { ElMessage.error(error.message || '归档状态加载失败'); }
  finally { loading.value = false; }
}
async function sign(requirement) {
  const id = requirementId(requirement);
  if (requirement.stampRequired && !String(stampIds[id] || '').trim()) {
    ElMessage.warning('该签署项要求填写签章标识'); return;
  }
  signingId.value = id;
  try {
    const record = await taskCardApi.sign(props.cardId, {
      jobId: props.jobId, signatureRequirementId: id,
      ...(String(stampIds[id] || '').trim() ? { stampId: String(stampIds[id]).trim() } : {}),
    });
    signedRecords[String(id)] = record;
    await refreshArchive();
    ElMessage.success('电子签署完成');
  } catch (error) { ElMessage.error(error.message || '电子签署失败'); }
  finally { signingId.value = null; }
}
watch(() => [props.cardId, props.jobNo, props.processes], refreshArchive, { deep: true });
onMounted(refreshArchive);
defineExpose({ archive, requirements, signedRecords, stampIds, refreshArchive, sign });
</script>

<template>
  <el-card shadow="never" class="signature-panel" data-testid="electronic-signature-panel" v-loading="loading">
    <template #header><div class="panel-title"><b>电子签章</b><el-tag :type="archive?.ok ? 'success' : 'warning'" data-testid="archive-status">{{ archive?.ok ? '可归档' : `待签署 ${archive?.missing?.length ?? requirements.length} 项` }}</el-tag></div></template>
    <el-alert v-if="archive" :title="archive.message || (archive.ok ? '签署齐备，可无纸化归档' : '签署尚未齐备')" :type="archive.ok ? 'success' : 'warning'" :closable="false" show-icon />
    <el-table :data="requirements" empty-text="无签署要求" data-testid="signature-requirements">
      <el-table-column prop="processId" label="工序" width="90" /><el-table-column prop="signatureRole" label="签署角色" min-width="120" />
      <el-table-column label="要求" min-width="150"><template #default="{ row }"><el-tag v-if="row.stampRequired" size="small">签章</el-tag><el-tag v-if="row.dateRequired" size="small" type="info">日期</el-tag></template></el-table-column>
      <el-table-column label="签署人 / 完成日期" min-width="220"><template #default="{ row }"><template v-if="recordFor(row)"><div>{{ recordFor(row).signedBy }}</div><small>{{ recordFor(row).signedAt }}</small></template><span v-else>—</span></template></el-table-column>
      <el-table-column label="签章标识 / 操作" min-width="280"><template #default="{ row }"><div class="sign-action"><el-input v-if="row.stampRequired && !isSigned(row)" v-model="stampIds[requirementId(row)]" placeholder="签章标识" size="small" /><el-button v-if="!isSigned(row)" type="primary" size="small" :loading="signingId === requirementId(row)" :data-testid="`sign-${requirementId(row)}`" @click="sign(row)">签署</el-button><span v-else>{{ recordFor(row)?.stampId || '—' }}</span></div></template></el-table-column>
    </el-table>
  </el-card>
</template>

<style scoped>.panel-title,.sign-action{display:flex;align-items:center;justify-content:space-between;gap:8px}.signature-panel{margin-top:16px}.el-alert{margin-bottom:12px}.signed{color:#67c23a}.sign-action .el-input{max-width:170px}</style>
