<script setup>
import { reactive, ref } from 'vue';
import TpcLookupDialog from './TpcLookupDialog.vue';

const props = defineProps({ rows: { type: Array, default: () => [] }, readonly: Boolean });
const emit = defineEmits(['add', 'remove', 'tpc-select']);
const tpcOpen = ref(false);
const draft = reactive({ docType: '', refNo: '', docRevision: '', ataChapter: '', documentDesc: '' });
function applyTpc(doc) {
  Object.assign(draft, { docType: doc.documentType, refNo: doc.refNo, docRevision: doc.documentRevision, documentDesc: doc.documentDesc });
  emit('tpc-select', doc);
}
function add() {
  if (!draft.docType || !draft.refNo || !draft.docRevision) return;
  emit('add', { docType: draft.docType, refNo: draft.refNo, docRevision: draft.docRevision, ataChapter: draft.ataChapter });
  Object.assign(draft, { docType: '', refNo: '', docRevision: '', ataChapter: '', documentDesc: '' });
}
defineExpose({ draft, applyTpc, add });
</script>

<template>
  <div data-testid="reference-doc-table">
    <div v-if="!readonly" class="doc-entry">
      <el-input v-model="draft.docType" placeholder="文件类型" data-testid="reference-doc-type" />
      <el-input v-model="draft.refNo" placeholder="参考号" data-testid="reference-ref-no" />
      <el-input v-model="draft.docRevision" placeholder="版本号" data-testid="reference-revision" />
      <el-input v-model="draft.ataChapter" placeholder="ATA 章节号" data-testid="reference-ata" />
      <el-button data-testid="open-tpc" @click="tpcOpen = true">TPC 检索</el-button>
      <el-button type="primary" data-testid="add-reference" @click="add">新增</el-button>
    </div>
    <el-alert v-if="draft.documentDesc" :title="draft.documentDesc" type="info" :closable="false" data-testid="tpc-document-desc" />
    <el-table :data="rows" empty-text="暂无参考文件">
      <el-table-column prop="docType" label="文件类型" />
      <el-table-column prop="refNo" label="参考号" />
      <el-table-column prop="docRevision" label="版本号" />
      <el-table-column prop="ataChapter" label="ATA 章节号" />
      <el-table-column v-if="!readonly" label="操作" width="90"><template #default="{ row }"><el-button link type="danger" @click="emit('remove', row)">删除</el-button></template></el-table-column>
    </el-table>
    <TpcLookupDialog v-model="tpcOpen" @select="applyTpc" />
  </div>
</template>
<style scoped>.doc-entry{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr)) auto auto;gap:8px;margin-bottom:12px}</style>