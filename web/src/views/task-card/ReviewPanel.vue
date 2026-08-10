<script setup>
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { reviewApi } from '../../api/reviewApi.js';
import { taskCardApi } from '../../api/taskCardApi.js';
import { classificationApi } from '../../api/classificationApi.js';
import { usePermissionStore } from '../../stores/permission.js';
const props = defineProps({
  cardId: [String, Number], status: String, revision: Number, classificationPending: Boolean,
  commercialClassification: { type: String, default: '' },
});
const emit = defineEmits(['status-change', 'classification-required', 'released']);
const permissionStore = usePermissionStore();
const reviewComment = ref(''); const changeReason = ref(''); const reviews = ref([]); const changes = ref([]); const failedChecks = ref([]);
const releasing = ref(false);
const canRelease = computed(() => props.status === 'Effective' && permissionStore.hasPermission('card_release'));
const commentMissing = computed(() => !reviewComment.value.trim());
async function load() {
  if (!props.cardId) return;
  [reviews.value, changes.value] = await Promise.all([reviewApi.list(props.cardId), taskCardApi.listChangeRecords(props.cardId)]);
}
async function submit() {
  failedChecks.value = [];
  if (props.classificationPending) {
    emit('classification-required');
    ElMessage.warning('商务分类候选尚未确认');
    return;
  }
  try {
    if (!props.commercialClassification) {
      const derivation = await classificationApi.derive(props.cardId);
      if (derivation?.requiresManualConfirmation || (!derivation?.classification && derivation?.candidates?.length)) {
        emit('classification-required', derivation);
        ElMessage.warning('商务分类候选尚未确认');
        return;
      }
    }
    const card = await reviewApi.submit(props.cardId, { changeReason: changeReason.value });
    emit('status-change', card);
  } catch (error) {
    failedChecks.value = error.data?.failedChecks || [];
    ElMessage.error(error.message || '提交审核失败');
  }
}
async function decide(action) {
  if (commentMissing.value) return;
  const card = await reviewApi[action](props.cardId, reviewComment.value.trim()); reviewComment.value = ''; await load(); emit('status-change', card);
}
async function releaseToJob() {
  if (!canRelease.value || releasing.value) return;
  releasing.value = true;
  try {
    const result = await taskCardApi.release(props.cardId);
    ElMessage.success(result.message || '发布成功');
    emit('released', result);
  } catch (error) {
    ElMessage.error(error.message || '发布至工包失败');
  } finally {
    releasing.value = false;
  }
}
onMounted(load);
defineExpose({ reviewComment, changeReason, reviews, changes, failedChecks, releasing, canRelease, submit, decide, releaseToJob, load });
</script>

<template>
  <div data-testid="review-panel">
    <el-alert v-if="classificationPending" title="商务分类候选尚未确认，不能提交审核" type="warning" :closable="false" data-testid="classification-pending" />
    <div v-if="status === 'New'" class="review-actions"><el-input v-model="changeReason" placeholder="提交/变更原因" data-testid="review-change-reason" />
      <el-button type="primary" :disabled="classificationPending" data-testid="submit-review" @click="submit">提交审核</el-button></div>
    <div v-if="status === 'UnderReview'" class="review-actions"><el-input v-model="reviewComment" type="textarea" placeholder="审核意见（必填）" data-testid="review-comment" />
      <el-button type="success" :disabled="commentMissing" data-testid="approve-review" @click="decide('approve')">批准</el-button>
      <el-button type="danger" :disabled="commentMissing" data-testid="reject-review" @click="decide('reject')">驳回</el-button></div>
    <div v-if="canRelease" class="review-actions">
      <el-button type="primary" :loading="releasing" data-testid="release-to-job" @click="releaseToJob">发布至工包并进入 JOB</el-button>
    </div>
    <el-alert v-if="failedChecks.length" type="error" :closable="false" data-testid="review-failures">
      <template #title>提交审核未通过</template><ul><li v-for="(item,index) in failedChecks" :key="index">({{ item.check || String.fromCharCode(97 + index) }}) {{ item.label || item.code || '校验项' }}：{{ item.message || item.reason || item }}</li></ul>
    </el-alert>
    <h3>审核记录（Revision {{ revision }}）</h3>
    <el-table :data="reviews" empty-text="暂无审核记录" data-testid="review-records"><el-table-column prop="cardRevision" label="版本" width="80" /><el-table-column prop="action" label="动作" width="90" /><el-table-column prop="reviewer" label="审核人" /><el-table-column prop="comment" label="意见" /><el-table-column prop="reviewedAt" label="时间" /></el-table>
    <h3>变更记录</h3>
    <el-table :data="changes" empty-text="暂无变更记录" data-testid="change-records"><el-table-column prop="field" label="字段" /><el-table-column prop="oldValue" label="变更前" /><el-table-column prop="newValue" label="变更后" /><el-table-column prop="changeType" label="变更类型" /><el-table-column prop="reason" label="原因" /></el-table>
  </div>
</template>
<style scoped>.review-actions{display:flex;align-items:flex-start;gap:8px;margin-bottom:12px}.review-actions .el-input{max-width:520px}h3{margin:18px 0 8px;color:#12395b}</style>