<script setup>
import { ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { integrationApi } from '../../api/integrationApi.js';

const props = defineProps({ modelValue: Boolean });
const emit = defineEmits(['update:modelValue', 'select']);
const keyword = ref('');
const rows = ref([]);
const loading = ref(false);

async function search() {
  loading.value = true;
  try { rows.value = await integrationApi.searchTpcDocuments(keyword.value ? { keyword: keyword.value } : {}); }
  catch (error) { ElMessage.error(error.message || 'TPC 文档检索失败'); }
  finally { loading.value = false; }
}
function select(row) {
  emit('select', {
    documentType: row.documentType ?? row.docType,
    refNo: row.refNo,
    documentRevision: row.documentRevision ?? row.docRevision,
    documentDesc: row.documentDesc ?? row.docDesc,
  });
  emit('update:modelValue', false);
}
watch(() => props.modelValue, (open) => { if (open) search(); });
defineExpose({ keyword, rows, search, select });
</script>

<template>
  <el-dialog :model-value="modelValue" title="TPC 文档检索" width="760px" @update:model-value="emit('update:modelValue', $event)">
    <div class="lookup-bar"><el-input v-model="keyword" clearable placeholder="参考号或描述" data-testid="tpc-keyword" @keyup.enter="search" />
      <el-button type="primary" data-testid="tpc-search" @click="search">检索</el-button></div>
    <el-table :data="rows" v-loading="loading" data-testid="tpc-results">
      <el-table-column label="Document Type" width="140"><template #default="{ row }">{{ row.documentType ?? row.docType }}</template></el-table-column>
      <el-table-column prop="refNo" label="Ref No" width="150" />
      <el-table-column label="Revision" width="100"><template #default="{ row }">{{ row.documentRevision ?? row.docRevision }}</template></el-table-column>
      <el-table-column label="Description" min-width="190"><template #default="{ row }">{{ row.documentDesc ?? row.docDesc }}</template></el-table-column>
      <el-table-column label="操作" width="80"><template #default="{ row }"><el-button link type="primary" data-testid="tpc-select" @click="select(row)">选择</el-button></template></el-table-column>
    </el-table>
  </el-dialog>
</template>
<style scoped>.lookup-bar{display:flex;gap:8px;margin-bottom:12px}</style>