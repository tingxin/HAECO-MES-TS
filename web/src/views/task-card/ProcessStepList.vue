<script setup>
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useRouter } from 'vue-router';
import { stepApi } from '../../api/stepApi.js';
const props = defineProps({ cardId: [String, Number], rows: { type: Array, default: () => [] }, readonly: Boolean });
const emit = defineEmits(['refresh']); const router = useRouter();
const selected = ref([]); const expanded = ref(true); const importing = ref(false); const fileInput = ref();
function open(row, mode) { router.push({ name: 'task-card-step', query: { cardId: props.cardId, ...(row?.id ? { stepId: row.id } : {}), mode: mode || (props.readonly ? 'view' : 'edit') } }); }
async function create() { try { const row = await stepApi.create(props.cardId, { descriptionZh: '', descriptionEn: '' }); emit('refresh'); open(row, 'edit'); } catch (error) { ElMessage.error(error.message || '新增工序失败'); } }
async function download() {
  try { const blob = await stepApi.downloadImportTemplate(props.cardId); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'process-steps-template.xlsx'; anchor.click(); URL.revokeObjectURL(url); }
  catch (error) { ElMessage.error(error.message || '模板下载失败'); }
}
async function importFile(event) {
  const file = event.target.files?.[0]; if (!file) return; importing.value = true;
  try { const result = await stepApi.importSteps(props.cardId, file); ElMessage.success(`导入完成：成功 ${result.successCount}，失败 ${result.failureCount}`); emit('refresh'); }
  catch (error) { ElMessage.error(error.message || '模板导入失败'); }
  finally { importing.value = false; event.target.value = ''; }
}
async function move(row, offset) {
  const ids = props.rows.map((item) => item.id); const from = ids.indexOf(row.id); const to = from + offset;
  if (from < 0 || to < 0 || to >= ids.length) return; [ids[from], ids[to]] = [ids[to], ids[from]];
  try { await stepApi.reorder(props.cardId, { orderedStepIds: ids, reason: '前端调整工序顺序' }); emit('refresh'); } catch (error) { ElMessage.error(error.message || '排序失败'); }
}
function selectAll() { selected.value = selected.value.length === props.rows.length ? [] : props.rows.map((row) => row.id); }
</script>

<template>
  <section data-testid="process-step-list">
    <div class="step-actions" data-testid="process-actions">
      <el-button type="primary" :disabled="readonly" data-testid="add-step" @click="create">新增插件</el-button>
      <el-button @click="download">模板下载</el-button>
      <el-button :disabled="readonly" :loading="importing" @click="fileInput?.click()">模板导入</el-button>
      <input ref="fileInput" class="hidden-file" type="file" accept=".xlsx,.xls" @change="importFile" />
      <el-button :disabled="readonly || !rows.length">排序</el-button>
      <el-button :disabled="!rows.length" @click="selectAll">全选</el-button>
      <el-button @click="expanded = !expanded">{{ expanded ? '折叠' : '展开' }}</el-button>
    </div>
    <el-table v-show="expanded" :data="rows" empty-text="暂无工序" data-testid="process-step-table" @selection-change="selected = $event.map((row) => row.id)">
      <el-table-column type="selection" width="46" />
      <el-table-column prop="processId" label="Process ID" width="130" />
      <el-table-column prop="skill" label="Skill" width="90" />
      <el-table-column prop="descriptionZh" label="中文描述" />
      <el-table-column prop="descriptionEn" label="English Description" />
      <el-table-column label="操作" width="190"><template #default="{row,$index}"><el-button link type="primary" @click="open(row)">{{ readonly ? '查看' : '编辑' }}</el-button><el-button link :disabled="readonly || $index===0" @click="move(row,-1)">上移</el-button><el-button link :disabled="readonly || $index===rows.length-1" @click="move(row,1)">下移</el-button></template></el-table-column>
    </el-table>
  </section>
</template>
<style scoped>.step-actions{display:flex;gap:8px;margin:12px 0}.hidden-file{display:none}</style>
