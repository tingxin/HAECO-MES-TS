<script setup>
import AttachmentUploader from './AttachmentUploader.vue';
import { componentLabel } from './processStepOptions.js';
const props = defineProps({ modelValue: { type: Object, required: true }, readonly: Boolean });
const emit = defineEmits(['update:modelValue','remove','upload-error']);
function payload(patch) { emit('update:modelValue', { ...props.modelValue, payload: { ...(props.modelValue.payload || {}), ...patch } }); }
function uploaded(file) { payload({ attachmentId: file.id, url: file.url, mimeType: file.mimeType, name: file.name }); }
function options(value) { payload({ options: value.split('\n').map((v) => v.trim()).filter(Boolean) }); }
</script>

<template>
  <el-card class="component-editor" shadow="never" :data-component-editor="modelValue.type">
    <template #header><div class="heading"><strong>{{ componentLabel(modelValue.type) }}</strong><el-button v-if="!readonly" type="danger" link @click="emit('remove')">删除</el-button></div></template>
    <template v-if="['image','video','audio'].includes(modelValue.type)"><p v-if="modelValue.payload?.url">{{ modelValue.payload.name || modelValue.payload.url }}</p><AttachmentUploader v-if="!readonly" :accept="`${modelValue.type}/*`" @uploaded="uploaded" @error="emit('upload-error',$event)" /></template>
    <template v-else-if="['tool','consumable'].includes(modelValue.type)"><el-input :model-value="modelValue.payload?.name" :disabled="readonly" placeholder="名称 / 编号" @update:model-value="payload({name:$event})" /><el-input :model-value="modelValue.payload?.details" :disabled="readonly" placeholder="规格、数量与说明" @update:model-value="payload({details:$event})" /></template>
    <template v-else-if="modelValue.type === 'range'"><el-input-number :model-value="modelValue.payload?.min" :disabled="readonly" @update:model-value="payload({min:$event})" /><span>—</span><el-input-number :model-value="modelValue.payload?.max" :disabled="readonly" @update:model-value="payload({max:$event})" /><el-input :model-value="modelValue.payload?.unit" :disabled="readonly" placeholder="单位" @update:model-value="payload({unit:$event})" /></template>
    <template v-else-if="modelValue.type === 'custom'"><el-input :model-value="(modelValue.payload?.options || []).join('\n')" type="textarea" :disabled="readonly" placeholder="每行一个选项" @update:model-value="options" /></template>
    <template v-else-if="modelValue.type === 'table'"><el-input :model-value="modelValue.payload?.caption" :disabled="readonly" placeholder="表格标题" @update:model-value="payload({caption:$event})" /></template>
    <template v-else><el-input :model-value="modelValue.payload?.label ?? modelValue.payload?.content ?? modelValue.payload?.name" :disabled="readonly" placeholder="组件内容/标签" @update:model-value="payload(modelValue.type === 'text' ? {content:$event} : {label:$event})" /></template>
  </el-card>
</template>
<style scoped>.component-editor{margin:8px 0}.heading{display:flex;justify-content:space-between;align-items:center}.component-editor :deep(.el-input){max-width:420px;margin-right:8px}.component-editor :deep(.el-input-number){margin-right:8px}</style>
