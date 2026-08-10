<script setup>
defineProps({ rows: { type: Array, default: () => [] }, loading: Boolean });
</script>

<template>
  <el-table :data="rows" :loading="loading" empty-text="暂无 BOM Base" data-testid="bom-base-table">
    <el-table-column prop="baseNumber" label="Base Number" min-width="180" />
    <el-table-column prop="source" label="来源" width="130">
      <template #default="{ row }">{{ row.source === 'ir_card' ? 'IR 卡' : 'Lot List' }}</template>
    </el-table-column>
    <el-table-column prop="lotNumber" label="Lot Number" min-width="160">
      <template #default="{ row }">{{ row.lotNumber || '—' }}</template>
    </el-table-column>
    <el-table-column prop="taskNo" label="Task Card No" min-width="160" />
    <el-table-column prop="taskTitle" label="Task Card Title" min-width="200" />
  </el-table>
</template>