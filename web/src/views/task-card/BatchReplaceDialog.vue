<script setup>
import { reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { taskCardApi } from '../../api/taskCardApi.js';

const props = defineProps({ modelValue: Boolean, cards: { type: Array, default: () => [] } });
const emit = defineEmits(['update:modelValue', 'completed']);
const form = reactive({ field: 'title', from: '', to: '', reason: '' });
const errorText = ref('');
const submitting = ref(false);
const result = ref(null);
watch(() => props.modelValue, (opened) => { if (opened) { errorText.value = ''; result.value = null; } });
async function submit() {
  errorText.value = '';
  if (!form.reason.trim()) { errorText.value = '替换原因必填'; return; }
  submitting.value = true;
  try {
    result.value = await taskCardApi.batchReplace({ ids: props.cards.map(({ id }) => id), ...form, reason: form.reason.trim() });
    ElMessage.success(`替换完成：成功 ${result.value.affectedCount || 0} 张`);
    emit('completed', result.value);
  } catch (error) { ElMessage.error(error.message || '批量替换失败'); }
  finally { submitting.value = false; }
}
const outcomeText = (value) => ({ replaced: '已替换', unaffected: '无匹配', rejected_not_editable: '状态不允许' }[value] || value);
const feedbackText = (item) => item.message || item.rejectionMessage || (item.outcome === 'replaced' ? '替换成功' : item.outcome === 'unaffected' ? '未匹配原值' : '-');
defineExpose({ form, result, submit });
</script>

<template>
  <el-dialog :model-value="modelValue" title="批量替换" width="720px" @update:model-value="emit('update:modelValue', $event)">
    <el-alert title="仅新增（New）工卡可被替换；审核中、生效、已被取代、作废状态将逐张拒绝并反馈。" type="warning" :closable="false" />
    <el-form label-width="90px" class="dialog-form">
      <el-form-item label="字段"><el-select v-model="form.field" data-testid="replace-field">
        <el-option label="标题" value="title" /><el-option label="A/C Type" value="acType" /><el-option label="Gear Type" value="gearType" />
        <el-option label="Stage" value="stage" /><el-option label="Skill" value="skill" /><el-option label="Ctrl Code" value="ctrlCode" />
      </el-select></el-form-item>
      <el-form-item label="原值"><el-input v-model="form.from" data-testid="replace-from" /></el-form-item>
      <el-form-item label="新值"><el-input v-model="form.to" data-testid="replace-to" /></el-form-item>
      <el-form-item label="原因" required><el-input v-model="form.reason" type="textarea" data-testid="replace-reason" /></el-form-item>
      <p v-if="errorText" class="form-error" data-testid="replace-error">{{ errorText }}</p>
    </el-form>

    <el-table v-if="result?.items?.length" :data="result.items" size="small" data-testid="replace-results">
      <el-table-column label="工卡" min-width="160"><template #default="{ row }">{{ row.card?.taskNo || row.card?.id }}</template></el-table-column>
      <el-table-column label="结果" width="130"><template #default="{ row }"><el-tag :type="row.outcome === 'replaced' ? 'success' : row.outcome === 'unaffected' ? 'info' : 'danger'">{{ outcomeText(row.outcome) }}</el-tag></template></el-table-column>
      <el-table-column label="反馈" min-width="220"><template #default="{ row }">{{ feedbackText(row) }}</template></el-table-column>
    </el-table>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">关闭</el-button>
      <el-button type="primary" :loading="submitting" data-testid="replace-submit" @click="submit">执行替换</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.dialog-form { margin-top: 16px; }
.form-error { margin: -8px 0 12px 90px; color: #f56c6c; font-size: 13px; }
</style>