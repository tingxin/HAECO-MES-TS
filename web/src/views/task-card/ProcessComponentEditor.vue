<script setup>
import { computed } from 'vue';
import AttachmentUploader from './AttachmentUploader.vue';
import ImageAnnotationEditor from './ImageAnnotationEditor.vue';
import ProcessComponentPreview from './ProcessComponentPreview.vue';
import { componentLabel } from './processStepOptions.js';
import { structuredPayload } from './structuredPayload.js';
const props = defineProps({ modelValue: { type: Object, required: true }, readonly: Boolean });
const emit = defineEmits(['update:modelValue','remove','upload-error']);
const normalized = computed(() => structuredPayload(props.modelValue.type, props.modelValue.payload));
const fields = computed(() => props.modelValue.type === 'tool'
  ? [['partNo','Part No.'],['description','Description']]
  : [['partNo','Part No.'],['description','Description'],['qty','Qty'],['category','Category']]);
function setPayload(value) { emit('update:modelValue', { ...props.modelValue, payload: value }); }
function payload(patch) { setPayload({ ...(props.modelValue.payload || {}), ...patch }); }
function uploaded(file) { setPayload({ attachmentId: file.id, url: file.url, mimeType: file.mimeType, name: file.name, annotations: [] }); }
function options(value) { payload({ options: value.split('\n').map((v) => v.trim()).filter(Boolean) }); }
function updateRow(index, key, value) { const rows = normalized.value.rows.map((row) => ({ ...row })); rows[index][key] = value; setPayload({ rows }); }
function addRow() { const row = Object.fromEntries(fields.value.map(([key]) => [key, ''])); setPayload({ rows: [...normalized.value.rows, row] }); }
function removeRow(index) { setPayload({ rows: normalized.value.rows.filter((_row, rowIndex) => rowIndex !== index) }); }
</script>

<template>
  <el-card class="component-editor" shadow="never" :data-component-editor="modelValue.type">
    <template #header><div class="heading"><strong>{{ componentLabel(modelValue.type) }}</strong><el-button v-if="!readonly" type="danger" link @click="emit('remove')">删除整表/组件</el-button></div></template>
    <template v-if="modelValue.type === 'image'">
      <ImageAnnotationEditor v-if="normalized.url" :model-value="normalized" :readonly="readonly" @update:model-value="setPayload" />
      <AttachmentUploader v-if="!readonly" accept="image/*" @uploaded="uploaded" @error="emit('upload-error',$event)" />
    </template>
    <template v-else-if="['video','audio'].includes(modelValue.type)"><ProcessComponentPreview v-if="readonly" :component="modelValue" compact /><p v-else-if="modelValue.payload?.url">{{ modelValue.payload.name || modelValue.payload.url }}</p><AttachmentUploader v-if="!readonly" :accept="`${modelValue.type}/*`" @uploaded="uploaded" @error="emit('upload-error',$event)" /></template>
    <template v-else-if="['tool','consumable'].includes(modelValue.type)">
      <table class="structured-table" data-testid="structured-payload-editor"><thead><tr><th v-for="([key,label]) in fields" :key="key">{{ label }}</th><th v-if="!readonly">操作</th></tr></thead>
        <tbody><tr v-for="(row,index) in normalized.rows" :key="index"><td v-for="([key]) in fields" :key="key"><el-input :model-value="row[key]" :disabled="readonly" @update:model-value="updateRow(index,key,$event)" /></td><td v-if="!readonly"><el-button link type="danger" @click="removeRow(index)">删除行</el-button></td></tr></tbody></table>
      <el-empty v-if="!normalized.rows.length" description="暂无行" :image-size="40" /><el-button v-if="!readonly" size="small" data-testid="add-structured-row" @click="addRow">添加行</el-button>
    </template>
    <template v-else-if="modelValue.type === 'range'"><el-input-number :model-value="modelValue.payload?.min" :disabled="readonly" @update:model-value="payload({min:$event})" /><span>—</span><el-input-number :model-value="modelValue.payload?.max" :disabled="readonly" @update:model-value="payload({max:$event})" /><el-input :model-value="modelValue.payload?.unit" :disabled="readonly" placeholder="单位" @update:model-value="payload({unit:$event})" /></template>
    <template v-else-if="modelValue.type === 'custom'"><el-input :model-value="(modelValue.payload?.options || []).join('\n')" type="textarea" :disabled="readonly" placeholder="每行一个选项" @update:model-value="options" /></template>
    <template v-else-if="modelValue.type === 'table'"><el-input :model-value="modelValue.payload?.caption" :disabled="readonly" placeholder="表格标题" @update:model-value="payload({caption:$event})" /></template>
    <template v-else><el-input :model-value="modelValue.payload?.label ?? modelValue.payload?.content ?? modelValue.payload?.name" :disabled="readonly" placeholder="组件内容/标签" @update:model-value="payload(modelValue.type === 'text' ? {content:$event} : {label:$event})" /></template>
  </el-card>
</template>
<style scoped>
.component-editor{margin:8px 0}.heading{display:flex;justify-content:space-between;align-items:center}.component-editor :deep(.el-input){min-width:120px}.component-editor :deep(.el-input-number){margin-right:8px}.structured-table{width:100%;border-collapse:collapse;margin-bottom:8px}.structured-table th,.structured-table td{border:1px solid #dcdfe6;padding:5px;text-align:left}.structured-table th{background:#f5f7fa}
</style>
