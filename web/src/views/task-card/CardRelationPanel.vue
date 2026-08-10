<script setup>
import { onMounted, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { taskCardApi } from '../../api/taskCardApi.js';
const DOC_TYPES = ['CR', 'PC', 'LT', 'BH', 'TS', 'SC', 'NR', 'PR', 'EN', 'SW', 'TA'];
const props = defineProps({ cardId: [String, Number], rows: { type: Array, default: () => [] }, readonly: Boolean });
const emit = defineEmits(['update']);
const relations = ref([...props.rows]);
const draft = reactive({ execDocType: 'CR', relatedDocNo: '' });
async function load() { if (props.cardId) relations.value = await taskCardApi.listRelations(props.cardId); }
async function add() {
  if (!props.cardId || !draft.relatedDocNo.trim()) return;
  try { await taskCardApi.addRelation(props.cardId, { ...draft, options: { origin: 'manual' } }); draft.relatedDocNo = ''; await load(); emit('update', relations.value); }
  catch (error) { ElMessage.error(error.message || '关联失败'); }
}
async function remove(id) { await taskCardApi.deleteRelation(props.cardId, id); await load(); emit('update', relations.value); }
watch(() => props.rows, (rows) => { relations.value = [...rows]; }, { deep: true });
onMounted(load);
defineExpose({ relations, draft, load, add, remove });
</script>

<template>
  <div data-testid="card-relation-panel">
    <div v-if="!readonly" class="relation-entry"><el-select v-model="draft.execDocType" data-testid="relation-type"><el-option v-for="type in DOC_TYPES" :key="type" :value="type" /></el-select>
      <span class="sr-only" data-testid="relation-type-values">{{ DOC_TYPES.join(',') }}</span>
      <el-input v-model="draft.relatedDocNo" placeholder="关联单据编号" data-testid="relation-doc-no" /><el-button type="primary" @click="add">关联</el-button></div>
    <el-table :data="relations" empty-text="暂无关联工卡">
      <el-table-column prop="execDocType" label="单据类型" width="110" />
      <el-table-column prop="relatedDocNo" label="单据编号" min-width="150" />
      <el-table-column prop="origin" label="来源" width="100"><template #default="{ row }">{{ row.origin === 'auto' ? '自动' : '人工' }}</template></el-table-column>
      <el-table-column label="关键信息快照" min-width="320"><template #default="{ row }"><code data-testid="relation-snapshot">{{ JSON.stringify(row.keyInfoSnapshot || {}) }}</code></template></el-table-column>
      <el-table-column v-if="!readonly" label="操作" width="90"><template #default="{ row }"><el-button link type="danger" @click="remove(row.id)">删除</el-button></template></el-table-column>
    </el-table>
  </div>
</template>
<style scoped>.relation-entry{display:flex;gap:8px;margin-bottom:12px}.relation-entry .el-select{width:120px}.relation-entry .el-input{max-width:280px}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}code{white-space:normal}</style>