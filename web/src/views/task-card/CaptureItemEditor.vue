<script setup>
import { componentLabel } from './processStepOptions.js';
const props = defineProps({ modelValue: { type: Array, default: () => [] }, types: { type: Array, default: () => [] }, readonly: Boolean });
const emit = defineEmits(['update:modelValue']);
function update(index, patch) { const rows = props.modelValue.map((row, i) => i === index ? { ...row, ...patch } : row); emit('update:modelValue', rows); }
function add() { emit('update:modelValue', [...props.modelValue, { type: props.types[0] || 'text', itemKey: '', required: false, config: {} }]); }
function remove(index) { emit('update:modelValue', props.modelValue.filter((_, i) => i !== index)); }
</script>

<template>
  <section data-testid="capture-item-editor">
    <div v-for="(item,index) in modelValue" :key="item.id || index" class="capture-row">
      <el-input :model-value="item.itemKey" placeholder="采集项名称（如 P/N、S/N）" :disabled="readonly" @update:model-value="update(index,{itemKey:$event})" />
      <el-select :model-value="item.type" :disabled="readonly" data-testid="capture-type" @update:model-value="update(index,{type:$event})">
        <el-option v-for="type in types" :key="type" :label="componentLabel(type)" :value="type" />
      </el-select>
      <el-checkbox :model-value="Boolean(item.required)" :disabled="readonly" @update:model-value="update(index,{required:$event})">必填</el-checkbox>
      <el-input disabled :placeholder="`${item.itemKey || '采集值'}（执行时输入${item.required ? '，必填' : ''}）`" data-testid="capture-preview" />
      <el-button v-if="!readonly" type="danger" link @click="remove(index)">删除</el-button>
    </div>
    <el-button v-if="!readonly" type="primary" plain data-testid="add-capture" @click="add">新增采集项</el-button>
  </section>
</template>
<style scoped>.capture-row{display:grid;grid-template-columns:1.3fr 1fr auto 1.4fr auto;gap:8px;align-items:center;margin-bottom:8px}</style>
