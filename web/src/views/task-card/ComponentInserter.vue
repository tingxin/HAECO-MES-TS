<script setup>
import { computed } from 'vue';
import { componentLabel } from './processStepOptions.js';
const props = defineProps({ types: { type: Array, default: () => [] }, readonly: Boolean, usedTypes: { type: Array, default: () => [] } });
const emit = defineEmits(['insert']);
const unavailable = computed(() => new Set(props.usedTypes.filter((type) => ['tool', 'consumable'].includes(type))));
function disabled(type) { return props.readonly || unavailable.value.has(type); }
function reason(type) { return unavailable.value.has(type) ? `${componentLabel(type)}每道工序最多一个` : ''; }
</script>

<template>
  <section class="component-inserter" data-testid="component-inserter">
    <div class="component-grid">
      <el-button v-for="type in types" :key="type" plain :disabled="disabled(type)" :title="reason(type)"
        class="component-option" :data-component-type="type" @click="emit('insert', type)">
        {{ componentLabel(type) }}
      </el-button>
    </div>
  </section>
</template>

<style scoped>
.component-grid{display:grid;grid-template-columns:repeat(7,minmax(96px,1fr));gap:8px}.component-option{margin:0;min-height:38px}
</style>
