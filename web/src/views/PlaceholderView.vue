<script setup>
import { computed } from 'vue';
import { useRoute } from 'vue-router';

const route = useRoute();
const title = computed(() => route.meta.title ?? '页面');
const description = computed(() => route.meta.description ?? '业务界面将在后续任务中实现。');
</script>

<template>
  <el-card class="placeholder-card" shadow="never">
    <template #header>{{ title }}</template>
    <el-empty :description="description" :image-size="96" />
    <p v-if="route.params.jobNo" class="route-context">
      JOB No: <strong>{{ route.params.jobNo }}</strong>
    </p>
  </el-card>
</template>
