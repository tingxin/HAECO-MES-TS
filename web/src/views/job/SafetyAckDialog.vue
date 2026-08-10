<script setup>
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { jobApi } from '../../api/jobApi.js';

const props = defineProps({ modelValue: Boolean, process: { type: Object, default: null } });
const emit = defineEmits(['update:modelValue', 'acknowledged']);
const accepted = ref(false);
const saving = ref(false);
const content = computed(() => props.process?.snapshot?.content || {});
const warningText = computed(() => {
  const warning = content.value.safetyWarning;
  if (warning && typeof warning === 'object') return warning.content || warning.text || JSON.stringify(warning);
  return warning || '该工序标记为关键工序，请核对工序内容并确认安全警示。';
});
watch(() => props.modelValue, (open) => { if (open) accepted.value = false; });
function close() { emit('update:modelValue', false); }
async function confirm() {
  if (!accepted.value || !props.process?.id) return;
  saving.value = true;
  try {
    const acknowledgement = await jobApi.acknowledgeSafety(props.process.id);
    emit('acknowledged', { processId: props.process.id, acknowledgement });
    ElMessage.success('安全警示已确认');
    close();
  } catch (error) { ElMessage.error(error.message || '安全确认失败'); }
  finally { saving.value = false; }
}
defineExpose({ accepted, warningText, confirm });
</script>

<template>
  <el-dialog :model-value="modelValue" title="关键工序安全确认" width="620px" @close="close">
    <el-alert title="确认后方可进入执行" type="warning" :closable="false" show-icon />
    <div class="warning" data-testid="safety-warning-text">{{ warningText }}</div>
    <el-checkbox v-model="accepted" data-testid="safety-accepted">我已完整查看并理解上述安全警示</el-checkbox>
    <template #footer><el-button @click="close">取消</el-button><el-button type="primary" :loading="saving" :disabled="!accepted" data-testid="confirm-safety" @click="confirm">确认并记录</el-button></template>
  </el-dialog>
</template>

<style scoped>.warning{margin:14px 0;padding:14px;white-space:pre-wrap;line-height:1.7;background:#fff7e6;border-left:4px solid #e6a23c;color:#7d4e00}</style>
