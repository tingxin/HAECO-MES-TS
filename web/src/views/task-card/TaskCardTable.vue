<script setup>
import { computed } from 'vue';
import { DEFAULT_COLUMNS } from './columnSettings.js';

const props = defineProps({
  rows: { type: Array, default: () => [] },
  columns: { type: Array, default: () => DEFAULT_COLUMNS },
  loading: Boolean,
  canRead: Boolean,
  canEdit: Boolean,
  canVoid: Boolean,
  canPrint: Boolean,
});
const emit = defineEmits(['selection-change', 'edit', 'copy', 'revise', 'detail', 'print', 'void']);
const visibleColumns = computed(() => props.columns.filter(({ visible }) => visible));
const statusLabels = { New: '新增', UnderReview: '审核中', Effective: '生效', Superseded: '已被取代', Void: '作废' };
const statusTypes = { New: 'info', UnderReview: 'warning', Effective: 'success', Superseded: 'info', Void: 'danger' };
const revisionText = (value) => String(Number.isFinite(Number(value)) ? Number(value) : 0).padStart(2, '0');
const valueOf = (row, key) => {
  if (key === 'isFai') return row.isFai === true || Number(row.isFai) === 1 ? '是' : '否';
  if (key === 'revision') return revisionText(row.revision);
  return row[key] ?? '-';
};
defineExpose({ visibleColumns, revisionText });
</script>

<template>
  <div class="task-card-table" data-testid="task-card-table">
    <el-table v-if="rows.length" v-loading="loading" :data="rows" row-key="id" @selection-change="emit('selection-change', $event)">
      <el-table-column type="selection" width="48" fixed="left" />
      <el-table-column v-for="column in visibleColumns" :key="column.key" :label="column.label"
        :prop="column.key" :width="column.width" :min-width="column.minWidth" :fixed="column.fixed">
        <template #default="{ row }">
          <el-tag v-if="column.key === 'stage' && row.stage === 'WFD'" type="danger" effect="dark" data-testid="wfd-badge">WFD · 待删除</el-tag>
          <el-tag v-else-if="column.key === 'status'" :type="statusTypes[row.status] || 'info'">{{ statusLabels[row.status] || row.status }}</el-tag>
          <span v-else :data-testid="column.key === 'revision' ? 'revision-value' : undefined">{{ valueOf(row, column.key) }}</span>
        </template>
      </el-table-column>

      <el-table-column label="操作" width="390" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" :disabled="!canRead" data-testid="row-detail" @click="emit('detail', row)">详情</el-button>
          <el-button v-if="row.status === 'Effective'" link type="warning" :disabled="!canEdit" data-testid="effective-edit" @click="emit('revise', row)">升版后编辑</el-button>
          <el-button v-else link type="primary" :disabled="!canEdit || row.status !== 'New'" data-testid="row-edit" @click="emit('edit', row)">编辑</el-button>
          <el-button link type="primary" :disabled="!canEdit" data-testid="row-copy" @click="emit('copy', row)">复制</el-button>
          <el-button link type="primary" :disabled="!canEdit" data-testid="row-revise" @click="emit('revise', row)">升版</el-button>
          <el-button link type="primary" :disabled="!canPrint" data-testid="row-print" @click="emit('print', row)">打印</el-button>
          <el-button link type="danger" :disabled="!canVoid || !['New', 'Effective'].includes(row.status)" data-testid="row-void" @click="emit('void', row)">作废</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-empty v-else description="暂无符合条件的工卡；当前筛选条件已保留" :image-size="80" data-testid="task-card-empty" />
  </div>
</template>

<style scoped>
.task-card-table { min-height: 280px; }
.task-card-table :deep(.el-table__cell) { padding: 8px 0; }
</style>