<script setup>
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { classificationApi } from '../../api/classificationApi.js';

const props = defineProps({
  modelValue: Boolean,
  cardId: [String, Number],
  cardType: { type: String, default: '' },
  classificationResult: { type: Object, default: null },
});
const emit = defineEmits(['update:modelValue', 'confirmed', 'derived']);
const result = ref(null); const choice = ref(null); const selectedKey = ref(''); const loading = ref(false);
const candidates = computed(() => result.value?.candidates || []);
const recommendation = computed(() => props.cardType === '11' ? null : result.value?.recommendedClassification || null);
const isPending = computed(() => result.value?.status === 'requires_confirmation');

function evidence(candidate) {
  if (Array.isArray(candidate?.sources) && candidate.sources.length) return candidate.sources;
  return [{ hitTier: candidate?.hitTier ?? null, sourceRef: candidate?.sourceRef ?? null, outsourceSubtype: candidate?.outsourceSubtype ?? null }];
}
function selectionOptions(candidate) {
  if (candidate?.classification !== 'Outsource') return [{ ...candidate, outsourceSubtype: null }];
  const subtypes = candidate.outsourceSubtypes?.length
    ? candidate.outsourceSubtypes
    : [...new Set(evidence(candidate).map((source) => source.outsourceSubtype).filter(Boolean))];
  return (subtypes.length ? subtypes : [candidate.outsourceSubtype]).filter(Boolean).map((outsourceSubtype) => ({ ...candidate, outsourceSubtype }));
}
const choices = computed(() => candidates.value.flatMap(selectionOptions));
function candidateKey(candidate) {
  const sources = evidence(candidate).map((source) => [source.hitTier, source.sourceRef, source.outsourceSubtype].map((value) => value ?? '').join(':')).join('|');
  return [candidate.classification, candidate.outsourceSubtype ?? '', sources].join('::');
}
function selectChoice(key) {
  selectedKey.value = key;
  choice.value = choices.value.find((candidate) => candidateKey(candidate) === key) || null;
}
function applyResult(value) {
  result.value = value || null;
  const recommended = recommendation.value;
  const initial = recommended
    ? choices.value.find((candidate) => candidate.classification === recommended
      && (candidate.classification !== 'Outsource' || candidate.outsourceSubtype)) || null
    : null;
  choice.value = initial;
  selectedKey.value = initial ? candidateKey(initial) : '';
}
async function derive() {
  if (!props.cardId) return null;
  loading.value = true;
  try {
    const derived = await classificationApi.derive(props.cardId);
    applyResult(derived); emit('derived', derived); return derived;
  } catch (error) { ElMessage.error(error.message || '商务分类派生失败'); return null; }
  finally { loading.value = false; }
}
async function prepare() {
  if (!props.cardId) return;
  if (props.classificationResult?.status === 'requires_confirmation') { applyResult(props.classificationResult); return; }
  loading.value = true;
  try {
    const latest = await classificationApi.latest(props.cardId);
    if (latest?.status === 'requires_confirmation') { applyResult(latest); return; }
  } catch (error) { ElMessage.error(error.message || '读取最新商务分类失败'); }
  finally { loading.value = false; }
  await derive();
}
async function confirm() {
  if (!choice.value || !isPending.value) return;
  const derivationResultId = result.value?.resultId ?? result.value?.id;
  if (derivationResultId === null || derivationResultId === undefined) { ElMessage.error('缺少派生结果标识，请重新派生'); return; }
  const payload = { derivationResultId, classification: choice.value.classification };
  if (choice.value.classification === 'Outsource') payload.outsourceSubtype = choice.value.outsourceSubtype;
  try {
    const confirmed = await classificationApi.confirm(props.cardId, payload);
    emit('confirmed', confirmed); emit('update:modelValue', false);
  } catch (error) { ElMessage.error(error.message || '分类确认失败'); }
}
watch(() => props.modelValue, (open) => { if (open) prepare(); }, { immediate: true });
defineExpose({ result, choice, selectedKey, candidates, choices, recommendation, derive, prepare, confirm });
</script>

<template>
  <el-dialog :model-value="modelValue" title="商务执行工卡分类" width="720px" @update:model-value="emit('update:modelValue', $event)">
    <div v-loading="loading" data-testid="classification-dialog">
      <el-descriptions v-if="result" :column="1" border>
        <el-descriptions-item label="状态">{{ result.status || '—' }}</el-descriptions-item>
        <el-descriptions-item label="派生结果">{{ result.classification || '待人工确认' }}</el-descriptions-item>
        <el-descriptions-item v-if="recommendation" label="推荐分类"><span data-testid="classification-recommendation">{{ recommendation }}</span></el-descriptions-item>
      </el-descriptions>
      <el-alert v-if="isPending" title="存在多个候选，必须确认其一后方可提交审核" type="warning" :closable="false" />
      <el-radio-group v-if="choices.length" :model-value="selectedKey" class="candidate-list" data-testid="classification-candidates" @change="selectChoice">
        <el-radio v-for="candidate in choices" :key="candidateKey(candidate)" :value="candidateKey(candidate)" class="candidate-item">
          <span class="candidate-title">{{ candidate.classification }}<template v-if="candidate.outsourceSubtype"> / {{ candidate.outsourceSubtype }}</template></span>
          <el-tag v-if="recommendation === candidate.classification" size="small" type="success">推荐</el-tag>
          <small>首次层级：{{ candidate.hitTier || evidence(candidate)[0]?.hitTier || '—' }}</small>
          <ul class="source-list">
            <li v-for="source in evidence(candidate)" :key="[candidate.classification, candidate.outsourceSubtype || '', source.hitTier || '', source.sourceRef || '', source.outsourceSubtype || ''].join(':')">
              hitTier={{ source.hitTier || '—' }}；sourceRef={{ source.sourceRef || '—' }}；outsourceSubtype={{ source.outsourceSubtype || '—' }}
            </li>
          </ul>
        </el-radio>
      </el-radio-group>
    </div>
    <template #footer><el-button @click="emit('update:modelValue', false)">取消</el-button><el-button type="primary" :disabled="!choice || !isPending" data-testid="confirm-classification" @click="confirm">确认</el-button></template>
  </el-dialog>
</template>

<style scoped>
.candidate-list { display: flex; flex-direction: column; align-items: stretch; margin-top: 12px; }
.candidate-item { height: auto; margin: 0 0 10px; padding: 10px; border: 1px solid #dcdfe6; border-radius: 4px; }
.candidate-title { margin-right: 8px; font-weight: 600; }
.candidate-item small { display: block; margin: 4px 0 0 24px; color: #606266; }
.source-list { margin: 4px 0 0 38px; padding: 0; color: #909399; font-size: 12px; white-space: normal; }
</style>
