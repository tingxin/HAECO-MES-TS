<script setup>
import { ref, watch } from 'vue';
import { cloneDefaultColumns, saveColumns } from './columnSettings.js';

const props = defineProps({ modelValue: Boolean, columns: { type: Array, default: cloneDefaultColumns } });
const emit = defineEmits(['update:modelValue', 'apply']);
const draft = ref(cloneDefaultColumns());
watch(() => props.modelValue, (opened) => {
  if (opened) draft.value = props.columns.map((column) => ({ ...column }));
});
function move(index, offset) {
  const target = index + offset;
  if (target < 0 || target >= draft.value.length) return;
  const next = [...draft.value];
  [next[index], next[target]] = [next[target], next[index]];
  draft.value = next;
}
function apply() {
  const value = draft.value.map((column) => ({ ...column }));
  saveColumns(value);
  emit('apply', value);
  emit('update:modelValue', false);
}
function reset() { draft.value = cloneDefaultColumns(); }
defineExpose({ draft, apply, reset });
</script>

<template>
  <el-dialog :model-value="modelValue" title="列设置" width="620px" @update:model-value="emit('update:modelValue', $event)">
    <el-alert title="可设置列显示、顺序与左右固定；保存后将写入本机浏览器。" type="info" :closable="false" />
    <div class="column-list" data-testid="column-settings-list">
      <div v-for="(column, index) in draft" :key="column.key" class="column-row" :data-testid="`column-${column.key}`">
        <el-checkbox v-model="column.visible">{{ column.label }}</el-checkbox>
        <el-select v-model="column.fixed" size="small" class="fixed-select">
          <el-option label="不固定" :value="false" /><el-option label="左固定" value="left" /><el-option label="右固定" value="right" />
        </el-select>
        <el-button size="small" :disabled="index === 0" @click="move(index, -1)">上移</el-button>
        <el-button size="small" :disabled="index === draft.length - 1" @click="move(index, 1)">下移</el-button>
      </div>
    </div>

    <template #footer>
      <el-button @click="reset">恢复默认</el-button>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" data-testid="save-columns" @click="apply">保存设置</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.column-list { display: grid; gap: 8px; margin-top: 16px; }
.column-row { display: grid; grid-template-columns: 1fr 110px 64px 64px; align-items: center; gap: 8px; padding: 7px 10px; border: 1px solid #ebeef5; border-radius: 4px; }
.fixed-select { width: 110px; }
</style>