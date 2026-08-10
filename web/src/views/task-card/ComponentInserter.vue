<script setup>
import { componentLabel } from './processStepOptions.js';
defineProps({ types: { type: Array, default: () => [] }, readonly: Boolean });
const emit = defineEmits(['insert']);
</script>

<template>
  <section class="component-inserter" data-testid="component-inserter">
    <div class="component-grid">
      <el-button v-for="type in types" :key="type" plain :disabled="readonly"
        class="component-option" :data-component-type="type" @click="emit('insert', type)">
        {{ componentLabel(type) }}
      </el-button>
    </div>
  </section>
</template>

<style scoped>
.component-grid{display:grid;grid-template-columns:repeat(7,minmax(96px,1fr));gap:8px}.component-option{margin:0;min-height:38px}
</style>
