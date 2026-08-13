<script setup>
import { computed, ref, watch } from 'vue';
import { normalizeAnnotations, structuredPayload } from './structuredPayload.js';

const props = defineProps({ modelValue: { type: Object, default: () => ({}) }, readonly: Boolean });
const emit = defineEmits(['update:modelValue']);
const tool = ref('rect');
const color = ref('#f56c6c');
const draft = ref([]);
const drawing = ref(null);
const history = ref([]);
const svg = ref(null);
let lastEmittedAnnotations = null;

watch(() => props.modelValue, (value) => {
  const incoming = JSON.stringify(normalizeAnnotations(value?.annotations));
  if (incoming === lastEmittedAnnotations) { lastEmittedAnnotations = null; return; }
  draft.value = normalizeAnnotations(value?.annotations);
  history.value = [];
}, { immediate: true, deep: true });

const allAnnotations = computed(() => drawing.value ? [...draft.value, drawing.value] : draft.value);
function emitPayload() {
  const annotations = normalizeAnnotations(draft.value);
  lastEmittedAnnotations = JSON.stringify(annotations);
  emit('update:modelValue', { ...structuredPayload('image', props.modelValue), annotations });
}
function saveHistory() { history.value.push(JSON.parse(JSON.stringify(draft.value))); }
function relativePoint(event) {
  const rect = svg.value?.getBoundingClientRect();
  if (!rect?.width || !rect?.height) return [0, 0];
  return [Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))];
}
function pointerDown(event) {
  if (props.readonly) return;
  const start = relativePoint(event);
  if (tool.value === 'text') {
    const value = globalThis.prompt?.('请输入标注文字')?.trim();
    if (!value) return;
    saveHistory(); draft.value.push({ id: `annotation-${Date.now()}`, type: 'text', points: [start], color: color.value, text: value }); emitPayload();
    return;
  }
  drawing.value = { id: `annotation-${Date.now()}`, type: tool.value, points: [start, start], color: color.value };
  svg.value?.setPointerCapture?.(event.pointerId);
}
function pointerMove(event) {
  if (!drawing.value) return;
  const next = relativePoint(event);
  if (drawing.value.type === 'pen') drawing.value.points.push(next);
  else drawing.value.points.splice(1, 1, next);
}
function pointerUp(event) {
  if (!drawing.value) return;
  pointerMove(event); saveHistory(); draft.value.push(drawing.value); drawing.value = null; emitPayload();
}
function undo() {
  if (props.readonly || !history.value.length) return;
  draft.value = history.value.pop(); drawing.value = null; emitPayload();
}
function reset() {
  if (props.readonly || !draft.value.length) return;
  saveHistory(); draft.value = []; drawing.value = null; emitPayload();
}
function path(annotation) { return annotation.points.map(([x, y]) => `${x * 100},${y * 100}`).join(' '); }
function line(annotation) { const [a = [0, 0], b = a] = annotation.points; return { x1: a[0] * 100, y1: a[1] * 100, x2: b[0] * 100, y2: b[1] * 100 }; }
defineExpose({ tool, color, draft, history, pointerDown, pointerMove, pointerUp, undo, reset });
</script>
<template>
  <section class="annotation-editor" data-testid="image-annotation-editor">
    <div v-if="!readonly" class="toolbar">
      <el-radio-group v-model="tool" size="small" data-testid="annotation-tools">
        <el-radio-button value="rect">矩形</el-radio-button><el-radio-button value="pen">自由画笔</el-radio-button>
        <el-radio-button value="arrow">箭头</el-radio-button><el-radio-button value="text">文字</el-radio-button>
      </el-radio-group>
      <input v-model="color" type="color" aria-label="标注颜色" data-testid="annotation-color" />
      <el-button size="small" :disabled="!history.length" data-testid="annotation-undo" @click="undo">撤销</el-button>
      <el-button size="small" :disabled="!draft.length" data-testid="annotation-reset" @click="reset">重置原图</el-button>
    </div>
    <div v-if="modelValue.url" class="canvas">
      <img :src="modelValue.url" :alt="modelValue.name || '工序图片'" />
      <svg ref="svg" viewBox="0 0 100 100" preserveAspectRatio="none" :class="{ editable: !readonly }"
        data-testid="annotation-overlay" @pointerdown="pointerDown" @pointermove="pointerMove" @pointerup="pointerUp" @pointercancel="drawing = null">
        <defs><marker id="annotation-arrow" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto"><path d="M0,0 L5,2.5 L0,5 z" fill="context-stroke" /></marker></defs>
        <template v-for="annotation in allAnnotations" :key="annotation.id">
          <rect v-if="annotation.type === 'rect'" :x="Math.min(line(annotation).x1,line(annotation).x2)" :y="Math.min(line(annotation).y1,line(annotation).y2)" :width="Math.abs(line(annotation).x2-line(annotation).x1)" :height="Math.abs(line(annotation).y2-line(annotation).y1)" fill="none" :stroke="annotation.color" vector-effect="non-scaling-stroke" />
          <polyline v-else-if="annotation.type === 'pen'" :points="path(annotation)" fill="none" :stroke="annotation.color" stroke-linecap="round" vector-effect="non-scaling-stroke" />
          <line v-else-if="annotation.type === 'arrow'" v-bind="line(annotation)" :stroke="annotation.color" marker-end="url(#annotation-arrow)" vector-effect="non-scaling-stroke" />
          <text v-else-if="annotation.type === 'text'" :x="line(annotation).x1" :y="line(annotation).y1" :fill="annotation.color" font-size="4">{{ annotation.text }}</text>
        </template>
      </svg>
    </div>
    <el-empty v-else description="请先上传原图" :image-size="50" />
  </section>
</template>
<style scoped>
.annotation-editor{max-width:720px}.toolbar{display:flex;align-items:center;gap:8px;margin-bottom:8px}.toolbar input[type=color]{width:36px;height:30px;border:1px solid #dcdfe6;border-radius:4px;padding:2px}.canvas{position:relative;display:inline-block;max-width:100%;line-height:0;background:#f5f7fa}.canvas img{display:block;max-width:100%;max-height:440px}.canvas svg{position:absolute;inset:0;width:100%;height:100%;touch-action:none}.canvas svg.editable{cursor:crosshair}.canvas :deep(rect),.canvas :deep(polyline),.canvas :deep(line){stroke-width:2px}
</style>
