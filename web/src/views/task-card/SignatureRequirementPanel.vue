<script setup>
import { ref } from 'vue';
const props = defineProps({ modelValue: { type: Array, default: () => [] }, roles: { type: Array, default: () => [] }, readonly: Boolean });
const emit = defineEmits(['update:modelValue']); const selectedRoles = ref([]);
function update(index, patch) { emit('update:modelValue', props.modelValue.map((row,i) => i === index ? { ...row, ...patch } : row)); }
function addRoles() {
  const existing = new Set(props.modelValue.map((row) => row.signatureRole));
  const additions = selectedRoles.value.filter((role) => !existing.has(role)).map((signatureRole, offset) => ({ signatureRole, stampRequired: false, dateRequired: true, sortOrder: props.modelValue.length + offset + 1 }));
  emit('update:modelValue', [...props.modelValue, ...additions]); selectedRoles.value = [];
}
function remove(index) { emit('update:modelValue', props.modelValue.filter((_,i) => i !== index)); }
</script>

<template>
  <section data-testid="signature-panel">
    <div v-if="!readonly" class="role-picker"><el-select v-model="selectedRoles" multiple placeholder="选择一个或多个签署角色" data-testid="signature-role-select"><el-option v-for="role in roles" :key="role" :label="role" :value="role" /></el-select><el-button type="primary" plain @click="addRoles">添加角色</el-button></div>
    <div v-for="(row,index) in modelValue" :key="row.id || `${row.signatureRole}-${index}`" class="signature-row">
      <strong>{{ row.signatureRole }}</strong>
      <el-checkbox :model-value="Boolean(row.stampRequired)" :disabled="readonly" @update:model-value="update(index,{stampRequired:$event})">要求盖章</el-checkbox>
      <el-checkbox :model-value="row.dateRequired !== false && row.dateRequired !== 0" :disabled="readonly" @update:model-value="update(index,{dateRequired:$event})">要求完成日期</el-checkbox>
      <el-input-number :model-value="Number(row.sortOrder || index+1)" :min="1" :disabled="readonly" controls-position="right" @update:model-value="update(index,{sortOrder:$event})" />
      <el-button v-if="!readonly" type="danger" link @click="remove(index)">删除</el-button>
    </div>
  </section>
</template>
<style scoped>.role-picker,.signature-row{display:flex;gap:12px;align-items:center;margin-bottom:10px}.role-picker .el-select{width:360px}.signature-row strong{min-width:130px}.signature-row .el-input-number{width:110px}</style>
