<script setup>
import { computed, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useRouter } from 'vue-router';
import { stepApi } from '../../api/stepApi.js';
import { usePermissionStore } from '../../stores/permission.js';
const props = defineProps({ cardId: [String, Number], rows: { type: Array, default: () => [] }, readonly: Boolean });
const emit = defineEmits(['refresh']); const router = useRouter(); const permissionStore = usePermissionStore();
const selected = ref([]); const expanded = ref(true); const importing = ref(false); const fileInput = ref();
const importMode = ref('append'); const importReason = ref(''); const importResult = ref(null);
const canEdit = computed(() => !props.readonly && permissionStore.hasPermission('card_edit'));
function open(row, mode) { router.push({ name: 'task-card-step', query: { cardId: props.cardId, ...(row?.id ? { stepId: row.id } : {}), mode: mode || (canEdit.value ? 'edit' : 'view') } }); }
function reasonFor(action, supplied) {
  const value = supplied ?? globalThis.prompt?.(`请输入${action}原因`);
  if (!String(value ?? '').trim()) { ElMessage.warning(`${action}原因必填`); return null; }
  return String(value).trim();
}
async function create(afterStepId = null) {
  try {
    const row = await stepApi.create(props.cardId, { descriptionZh: '', descriptionEn: '', ...(afterStepId ? { afterStepId, reason: '在指定工序后新增' } : {}) });
    emit('refresh'); open(row, 'edit');
  } catch (error) { ElMessage.error(error.message || '新增工序失败'); }
}
async function copy(row, suppliedReason) {
  const reason = reasonFor('复制工序', suppliedReason); if (!reason) return;
  try { await stepApi.copy(props.cardId, row.id, { reason }); ElMessage.success(`已在 ${row.processId} 后复制工序`); emit('refresh'); }
  catch (error) { ElMessage.error(error.message || '复制工序失败'); }
}
async function remove(row, suppliedReason) {
  if (props.rows.length <= 1) { ElMessage.warning('至少保留一道工序'); return; }
  const reason = reasonFor('删除工序', suppliedReason); if (!reason) return;
  try { await stepApi.remove(props.cardId, row.id, { reason }); ElMessage.success('工序已删除'); emit('refresh'); }
  catch (error) { ElMessage.error(error.message || '删除工序失败'); }
}
async function download() {
  try { const blob = await stepApi.downloadImportTemplate(props.cardId); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'process-steps-template.xlsx'; anchor.click(); URL.revokeObjectURL(url); }
  catch (error) { ElMessage.error(error.message || '模板下载失败'); }
}
async function importFile(event) {
  const file = event.target.files?.[0]; if (!file) return;
  if (importMode.value === 'replace') {
    if (!importReason.value.trim()) { ElMessage.warning('覆盖导入变更原因必填'); event.target.value = ''; return; }
    try { await ElMessageBox.confirm('覆盖导入将替换全部现有工序，是否继续？', '二次确认', { type: 'warning', confirmButtonText: '确认覆盖' }); }
    catch { event.target.value = ''; return; }
  }
  importing.value = true;
  try {
    importResult.value = await stepApi.importSteps(props.cardId, file, { mode: importMode.value, reason: importReason.value.trim() });
    ElMessage.success(`导入完成：模式 ${importResult.value.mode}，成功 ${importResult.value.successCount}，失败 ${importResult.value.failureCount}`); emit('refresh');
  } catch (error) { ElMessage.error(error.message || '模板导入失败'); }
  finally { importing.value = false; event.target.value = ''; }
}
async function move(row, offset, suppliedReason) {
  const ids = props.rows.map((item) => item.id); const from = ids.indexOf(row.id); const to = from + offset;
  if (from < 0 || to < 0 || to >= ids.length) return;
  const reason = reasonFor('调整工序顺序', suppliedReason); if (!reason) return;
  [ids[from], ids[to]] = [ids[to], ids[from]];
  try { await stepApi.reorder(props.cardId, { orderedStepIds: ids, reason }); emit('refresh'); }
  catch (error) { ElMessage.error(error.message || '排序失败'); }
}
function selectAll() { selected.value = selected.value.length === props.rows.length ? [] : props.rows.map((row) => row.id); }
defineExpose({ canEdit, selected, importMode, importReason, importResult, create, copy, remove, move, importFile });
</script>

<template>
  <section data-testid="process-step-list">
    <div class="step-actions" data-testid="process-actions">
      <el-button type="primary" :disabled="!canEdit" data-testid="add-step" @click="create()">新增插件</el-button>
      <el-button @click="download">模板下载</el-button>
      <el-select v-model="importMode" :disabled="!canEdit" class="import-mode" data-testid="import-mode"><el-option label="追加 append" value="append" /><el-option label="覆盖 replace" value="replace" /></el-select>
      <el-input v-if="importMode === 'replace'" v-model="importReason" :disabled="!canEdit" placeholder="覆盖导入变更原因（必填）" data-testid="import-reason" />
      <el-button :disabled="!canEdit" :loading="importing" data-testid="import-steps" @click="fileInput?.click()">模板导入</el-button>
      <input ref="fileInput" class="hidden-file" type="file" accept=".xlsx,.xls" @change="importFile" />
      <el-button :disabled="!rows.length" @click="selectAll">全选</el-button>
      <el-button @click="expanded = !expanded">{{ expanded ? '折叠' : '展开' }}</el-button>
    </div>
    <el-alert v-if="!canEdit && !readonly" title="当前身份无 card_edit 权限，工序编排只读" type="warning" :closable="false" />
    <el-table v-show="expanded" :data="rows" empty-text="暂无工序" data-testid="process-step-table" @selection-change="selected = $event.map((row) => row.id)">
      <el-table-column type="selection" width="46" /><el-table-column prop="processId" label="Process ID" width="110" /><el-table-column prop="skill" label="Skill" width="90" />
      <el-table-column prop="descriptionZh" label="中文描述" /><el-table-column prop="descriptionEn" label="English Description" />
      <el-table-column label="操作" width="370"><template #default="{row,$index}">
        <el-button link type="primary" @click="open(row)">{{ canEdit ? '编辑' : '查看' }}</el-button>
        <el-button link :disabled="!canEdit" data-testid="insert-after-step" @click="create(row.id)">后插</el-button>
        <el-button link :disabled="!canEdit" data-testid="copy-step" @click="copy(row)">复制</el-button>
        <el-button link :disabled="!canEdit || $index===0" @click="move(row,-1)">上移</el-button>
        <el-button link :disabled="!canEdit || $index===rows.length-1" @click="move(row,1)">下移</el-button>
        <el-button link type="danger" :disabled="!canEdit || rows.length <= 1" :title="rows.length <= 1 ? '至少保留一道工序' : '删除工序'" data-testid="delete-step" @click="remove(row)">删除</el-button>
      </template></el-table-column>
    </el-table>
    <el-card v-if="importResult" shadow="never" class="import-result" data-testid="import-result">
      <b>{{ importResult.mode }}：成功 {{ importResult.successCount }} / 失败 {{ importResult.failureCount }} / 总数 {{ importResult.totalCount }}</b>
      <el-table :data="importResult.records || []" size="small"><el-table-column prop="rowNo" label="行" width="70" /><el-table-column prop="status" label="状态" width="100" /><el-table-column prop="processId" label="Process ID" /><el-table-column prop="failureReason" label="失败原因" /></el-table>
    </el-card>
  </section>
</template>
<style scoped>.step-actions{display:flex;align-items:center;gap:8px;margin:12px 0;flex-wrap:wrap}.hidden-file{display:none}.import-mode{width:150px}.step-actions>.el-input{width:260px}.import-result{margin-top:12px}</style>
