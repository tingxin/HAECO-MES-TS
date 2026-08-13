<script setup>
import { computed } from 'vue';
import ImageAnnotationEditor from './ImageAnnotationEditor.vue';
import { componentLabel } from './processStepOptions.js';
import { structuredPayload } from './structuredPayload.js';
const props = defineProps({ component: { type: Object, required: true }, compact: Boolean });
const payload = computed(() => structuredPayload(props.component.type, props.component.payload));
const fields = computed(() => props.component.type === 'tool'
  ? [['partNo', 'Part No.'], ['description', 'Description']]
  : [['partNo', 'Part No.'], ['description', 'Description'], ['qty', 'Qty'], ['category', 'Category']]);
</script>
<template>
  <section class="component-preview" :data-preview-type="component.type">
    <strong v-if="!compact">{{ componentLabel(component.type) }}</strong>
    <ImageAnnotationEditor v-if="component.type === 'image'" :model-value="payload" readonly />
    <table v-else-if="['tool','consumable'].includes(component.type)" data-testid="structured-payload-table">
      <thead><tr><th v-for="([key,label]) in fields" :key="key">{{ label }}</th></tr></thead>
      <tbody><tr v-for="(row,index) in payload.rows" :key="index"><td v-for="([key]) in fields" :key="key">{{ row[key] || '—' }}</td></tr></tbody>
    </table>
    <video v-else-if="component.type === 'video' && payload.url" :src="payload.url" controls />
    <audio v-else-if="component.type === 'audio' && payload.url" :src="payload.url" controls />
    <p v-else class="plain">{{ payload.content ?? payload.label ?? payload.name ?? JSON.stringify(payload) }}</p>
  </section>
</template>
<style scoped>
.component-preview{margin:8px 0}.component-preview>strong{display:block;margin-bottom:5px;color:#303133}.component-preview table{width:100%;border-collapse:collapse}.component-preview th,.component-preview td{border:1px solid #dcdfe6;padding:6px;text-align:left}.component-preview video{max-width:480px}.plain{white-space:pre-wrap;margin:4px 0}
</style>
