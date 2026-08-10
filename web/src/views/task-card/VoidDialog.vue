<script setup>
import { ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { taskCardApi } from '../../api/taskCardApi.js';

const props = defineProps({ modelValue: Boolean, cards: { type: Array, default: () => [] } });
const emit = defineEmits(['update:modelValue', 'completed']);
const reason = ref('');
const errorText = ref('');
const checking = ref(false);
const submitting = ref(false);
const prechecks = ref([]);
const results = ref([]);
watch(() => props.modelValue, async (opened) => {
  if (!opened) return;
  reason.value = ''; errorText.value = ''; results.value = []; prechecks.value = [];
  checking.value = true;
  try {
    prechecks.value = await Promise.all(props.cards.map(async (card) => ({ card, check: await taskCardApi.getVoidPrecheck(card.id) })));
  } catch (error) { ElMessage.error(error.message || '作废前置校验失败'); }
  finally { checking.value = false; }
});
const blockingCount = (check) => check?.blockingRefs?.length ?? Object.values(check?.referenceHits || {}).flat().length;
async function submit() {
  errorText.value = '';
  if (!reason.value.trim()) { errorText.value = '作废原因必填'; return; }
  submitting.value = true;
  const settled = await Promise.allSettled(props.cards.map((card) => taskCardApi.voidCard(card.id, { reason: reason.value.trim() })));
  results.value = settled.map((entry, index) => ({ card: props.cards[index], ok: entry.status === 'fulfilled', message: entry.status === 'fulfilled' ? '已作废' : entry.reason?.message || '失败' }));
  const succeeded = results.value.filter(({ ok }) => ok).length;
  ElMessage.success(`作废完成：成功 ${succeeded} 张`);
  emit('completed', results.value);
  submitting.value = false;
}
defineExpose({ reason, prechecks, results, submit });
</script>

<template>
  <el-dialog :model-value="modelValue" title="作废工卡" width="720px" @update:model-value="emit('update:modelValue', $event)">
    <el-alert title="仅新增（New）或生效（Effective）状态可进入作废流程；WFD 本身不会自动作废。" type="warning" :closable="false" />
    <div v-loading="checking" class="precheck-list" data-testid="void-prechecks">
      <div v-for="item in prechecks" :key="item.card.id" class="result-row">
        <strong>{{ item.card.taskNo }}</strong>
        <el-tag :type="blockingCount(item.check) ? 'danger' : 'success'">{{ blockingCount(item.check) ? `阻止项 ${blockingCount(item.check)}` : '校验通过' }}</el-tag>
      </div>
    </div>
    <el-form label-width="90px"><el-form-item label="作废原因" required><el-input v-model="reason" type="textarea" data-testid="void-reason" /></el-form-item></el-form>
    <p v-if="errorText" class="form-error" data-testid="void-error">{{ errorText }}</p>
    <div v-if="results.length" data-testid="void-results"><div v-for="item in results" :key="item.card.id" class="result-row"><span>{{ item.card.taskNo }}</span><el-tag :type="item.ok ? 'success' : 'danger'">{{ item.message }}</el-tag></div></div>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">关闭</el-button>
      <el-button type="danger" :loading="submitting" :disabled="checking" data-testid="void-submit" @click="submit">确认作废</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.precheck-list { min-height: 48px; margin: 14px 0; }
.result-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 10px; border-bottom: 1px solid #ebeef5; }
.form-error { margin: -8px 0 12px 90px; color: #f56c6c; font-size: 13px; }
</style>