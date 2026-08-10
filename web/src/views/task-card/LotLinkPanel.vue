<script setup>
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { bomApi } from '../../api/bomApi.js';
const props = defineProps({ cardId: [String, Number], readonly: Boolean });
const emit = defineEmits(['update']);
const links = ref([]);
const draft = reactive({ lotNumber: '', lotListRef: '' });
async function load() { if (props.cardId) links.value = await bomApi.listLotLinks(props.cardId); }
async function add() {
  if (!props.cardId || !draft.lotNumber.trim() || !draft.lotListRef.trim()) return;
  try { await bomApi.addLotLink(props.cardId, { ...draft }); Object.assign(draft, { lotNumber: '', lotListRef: '' }); await load(); emit('update'); }
  catch (error) { ElMessage.error(error.message || 'Lot List 关联失败'); }
}
async function remove(id) { await bomApi.deleteLotLink(props.cardId, id); await load(); emit('update'); }
onMounted(load);
defineExpose({ links, draft, load, add, remove });
</script>

<template>
  <div data-testid="lot-link-panel">
    <div v-if="!readonly" class="lot-entry"><el-input v-model="draft.lotNumber" placeholder="Lot Number" data-testid="lot-number" />
      <el-input v-model="draft.lotListRef" placeholder="Lot List Ref" data-testid="lot-list-ref" /><el-button type="primary" @click="add">关联</el-button></div>
    <el-table :data="links" empty-text="暂无 Lot List 关联">
      <el-table-column prop="lotNumber" label="Lot Number" />
      <el-table-column prop="lotListRef" label="Lot List Ref" />
      <el-table-column v-if="!readonly" label="操作" width="90"><template #default="{ row }"><el-button link type="danger" @click="remove(row.id)">删除</el-button></template></el-table-column>
    </el-table>
  </div>
</template>
<style scoped>.lot-entry{display:flex;gap:8px;margin-bottom:12px}.lot-entry .el-input{max-width:220px}</style>