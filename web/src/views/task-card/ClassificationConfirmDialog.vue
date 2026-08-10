<script setup>
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { classificationApi } from '../../api/classificationApi.js';
const props = defineProps({ modelValue: Boolean, cardId: [String, Number] });
const emit = defineEmits(['update:modelValue', 'confirmed', 'derived']);
const result = ref(null); const choice = ref(''); const loading = ref(false);
const candidates = computed(() => result.value?.candidates || []);
async function derive() {
  if (!props.cardId) return;
  loading.value = true;
  try { result.value = await classificationApi.derive(props.cardId); choice.value = result.value.classification || ''; emit('derived', result.value); }
  catch (error) { ElMessage.error(error.message || '商务分类派生失败'); }
  finally { loading.value = false; }
}
async function confirm() {
  if (!choice.value) return;
  try { const confirmed = await classificationApi.confirm(props.cardId, { classification: choice.value }); emit('confirmed', confirmed); emit('update:modelValue', false); }
  catch (error) { ElMessage.error(error.message || '分类确认失败'); }
}
watch(() => props.modelValue, (open) => { if (open) derive(); });
defineExpose({ result, choice, candidates, derive, confirm });
</script>

<template>
  <el-dialog :model-value="modelValue" title="商务执行工卡分类" width="620px" @update:model-value="emit('update:modelValue', $event)">
    <div v-loading="loading" data-testid="classification-dialog">
      <el-descriptions v-if="result" :column="1" border>
        <el-descriptions-item label="派生结果">{{ result.classification || '待人工确认' }}</el-descriptions-item>
        <el-descriptions-item label="命中层级">{{ result.hitTier || '—' }}</el-descriptions-item>
        <el-descriptions-item label="派生依据">{{ result.sourceRef || '—' }}</el-descriptions-item>
      </el-descriptions>
      <el-alert v-if="candidates.length" title="存在多个候选，必须确认其一后方可提交审核" type="warning" :closable="false" />
      <el-radio-group v-if="candidates.length" v-model="choice" class="candidate-list" data-testid="classification-candidates">
        <el-radio v-for="candidate in candidates" :key="candidate.classification || candidate" :value="candidate.classification || candidate">
          <span>{{ candidate.classification || candidate }}</span>
          <small v-if="candidate.sourceRef">依据：{{ candidate.sourceRef }}</small>
        </el-radio>
      </el-radio-group>
    </div>
    <template #footer><el-button @click="emit('update:modelValue', false)">取消</el-button><el-button type="primary" :disabled="!choice" data-testid="confirm-classification" @click="confirm">确认</el-button></template>
  </el-dialog>
</template>

<style scoped>
.candidate-list { display: flex; flex-direction: column; align-items: flex-start; margin-top: 12px; }
.candidate-list small { display: block; margin-left: 8px; color: #909399; }
</style>