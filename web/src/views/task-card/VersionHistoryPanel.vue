<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { taskCardApi } from '../../api/taskCardApi.js';
import { usePermissionStore } from '../../stores/permission.js';
import { printTriples } from '../output/printRenderer.js';
import ProcessComponentPreview from './ProcessComponentPreview.vue';

const props = defineProps({ cardId: [String, Number] });
const permissionStore = usePermissionStore();
const loading = ref(false); const versions = ref([]); const selectedId = ref();
const snapshot = ref(null); const difference = ref(null);
const canPrint = computed(() => permissionStore.hasPermission('card_print_export'));
const orderedVersions = computed(() => [...versions.value].sort((a, b) => Number(b.revision) - Number(a.revision)));
const selectedVersion = computed(() => orderedVersions.value.find((row) => String(row.id) === String(selectedId.value)) || null);
const reviews = computed(() => selectedVersion.value?.reviews || snapshot.value?.reviews || []);
const diffGroups = computed(() => {
  const diff = difference.value?.diff || {};
  return [
    ['抬头字段', diff.headerChanges || []], ['参考文件新增', diff.referenceDocuments?.added || []],
    ['参考文件删除', diff.referenceDocuments?.removed || []], ['参考文件变更', diff.referenceDocuments?.changed || []],
    ['工序新增', diff.steps?.added || []], ['工序删除', diff.steps?.removed || []], ['工序内容变更', diff.steps?.changed || []],
  ];
});
function display(value) { return value == null || value === '' ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value); }
async function loadVersions() {
  if (!props.cardId) return;
  loading.value = true;
  try {
    versions.value = await taskCardApi.listVersions(props.cardId);
    selectedId.value = orderedVersions.value[0]?.id;
    if (selectedId.value != null) await loadVersion(selectedId.value);
  } catch (error) { ElMessage.error(error.message || '版本历史加载失败'); }
  finally { loading.value = false; }
}
async function loadVersion(id) {
  if (id == null) return;
  selectedId.value = id; loading.value = true;
  try {
    [snapshot.value, difference.value] = await Promise.all([
      taskCardApi.getVersionSnapshot(props.cardId, id), taskCardApi.getVersionDiff(props.cardId, id),
    ]);
  } catch (error) { ElMessage.error(error.message || '历史版本详情加载失败'); }
  finally { loading.value = false; }
}
async function printVersion() {
  if (!selectedId.value || !canPrint.value) return;
  try { printTriples(await taskCardApi.printVersion(props.cardId, selectedId.value)); }
  catch (error) { ElMessage.error(error.message || '历史版本打印失败'); }
}
watch(() => props.cardId, loadVersions);
onMounted(loadVersions);
defineExpose({ versions, orderedVersions, selectedId, snapshot, difference, loadVersions, loadVersion, printVersion });
</script>
<template>
  <section v-loading="loading" data-testid="version-history-panel">
    <el-empty v-if="!orderedVersions.length && !loading" description="暂无版本历史" />
    <template v-else>
      <el-table :data="orderedVersions" highlight-current-row row-key="id" data-testid="version-list" @current-change="row => row && loadVersion(row.id)">
        <el-table-column prop="revision" label="Revision" width="90" /><el-table-column prop="revisionDate" label="修订日期" width="120" />
        <el-table-column prop="status" label="状态" width="120" /><el-table-column prop="changeReason" label="变更原因" min-width="180" />
        <el-table-column prop="createdBy" label="编制人" width="130" />
        <el-table-column label="操作" width="120"><template #default="{row}"><el-button link type="primary" @click.stop="loadVersion(row.id)">查看</el-button></template></el-table-column>
      </el-table>
      <div v-if="snapshot" class="history-actions"><b>Rev.{{ snapshot.revision }} 完整只读快照</b><el-button type="primary" :disabled="!canPrint" data-testid="history-print" @click="printVersion">打印此版本</el-button></div>
      <el-descriptions v-if="snapshot" :column="3" border data-testid="version-snapshot">
        <el-descriptions-item v-for="key in ['taskNo','title','revision','date','status','cardType','stage','acType','gearType']" :key="key" :label="key">{{ display(snapshot[key]) }}</el-descriptions-item>
      </el-descriptions>
      <el-collapse v-if="snapshot" class="snapshot-aggregates">
        <el-collapse-item :title="`参考文件 (${snapshot.referenceDocuments?.length || 0})`" name="refs"><pre>{{ JSON.stringify(snapshot.referenceDocuments || [], null, 2) }}</pre></el-collapse-item>
        <el-collapse-item :title="`工序 (${snapshot.steps?.length || 0})`" name="steps">
          <article v-for="step in snapshot.steps || []" :key="step.id" class="history-step">
            <h4>{{ step.processId }} · {{ step.descriptionZh }}</h4><p>{{ step.descriptionEn }}</p>
            <ProcessComponentPreview v-for="component in step.components || []" :key="component.id || component.sortOrder" :component="component" />
            <pre>采集项：{{ JSON.stringify(step.captureItems || [], null, 2) }}
签署项：{{ JSON.stringify(step.signatureRequirements || [], null, 2) }}
安全警示：{{ display(step.safetyWarning) }}</pre>
          </article>
        </el-collapse-item>
        <el-collapse-item :title="`关联记录 (${snapshot.relations?.length || 0})`" name="relations"><pre>{{ JSON.stringify(snapshot.relations || [], null, 2) }}</pre></el-collapse-item>
      </el-collapse>
      <h3>与直接前一版本差异 <small>Rev.{{ difference?.previousRevision ?? '首版' }} → Rev.{{ difference?.revision ?? '—' }}</small></h3>
      <div data-testid="version-diff"><section v-for="([label,rows]) in diffGroups" :key="label"><b>{{ label }} ({{ rows.length }})</b><pre v-if="rows.length">{{ JSON.stringify(rows, null, 2) }}</pre></section></div>
      <h3>此版本审核记录</h3>
      <el-table :data="reviews" empty-text="暂无审核记录" data-testid="version-reviews">
        <el-table-column prop="action" label="动作" /><el-table-column prop="reviewer" label="审核人"><template #default="{row}">{{ row.reviewer ?? row.reviewedBy ?? row.operatorId ?? '—' }}</template></el-table-column>
        <el-table-column prop="comment" label="审核意见"><template #default="{row}">{{ row.comment ?? row.reviewComment ?? '—' }}</template></el-table-column>
        <el-table-column prop="createdAt" label="审核时间"><template #default="{row}">{{ row.createdAt ?? row.reviewedAt ?? row.timestamp ?? '—' }}</template></el-table-column>
      </el-table>
    </template>
  </section>
</template>
<style scoped>
.history-actions{display:flex;align-items:center;justify-content:space-between;margin:14px 0 8px}.snapshot-aggregates{margin:12px 0}.snapshot-aggregates pre,#version-diff pre{white-space:pre-wrap;max-height:280px;overflow:auto}.history-step{padding:8px 0;border-bottom:1px solid #ebeef5}.history-step h4{margin:0;color:#12395b}[data-testid=version-diff]{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}[data-testid=version-diff] section{border:1px solid #ebeef5;padding:8px}h3{margin:16px 0 8px;color:#12395b}h3 small{font-weight:normal;color:#909399}
</style>
