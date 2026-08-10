<script setup>
import { computed } from 'vue';
import { toSVG } from '@bwip-js/browser';

const props = defineProps({ value: { type: String, default: '' }, type: { type: String, default: 'CODE128' } });
const isQr = computed(() => String(props.type).toUpperCase().includes('QR'));
const barcodeSvg = computed(() => {
  if (!props.value) return '';
  try {
    return toSVG({
      bcid: isQr.value ? 'qrcode' : 'code128',
      text: props.value,
      scale: isQr.value ? 3 : 2,
      height: isQr.value ? undefined : 10,
      includetext: false,
      paddingwidth: 2,
      paddingheight: 2,
      backgroundcolor: 'FFFFFF',
    });
  } catch {
    return '';
  }
});
</script>

<template>
  <figure class="barcode" data-testid="barcode-view" :aria-label="`工序码 ${value}`">
    <div v-if="barcodeSvg" class="barcode-svg" :data-testid="isQr ? 'qr-code' : 'bar-code'" v-html="barcodeSvg" />
    <div v-else class="barcode-unavailable">无法生成条码</div>
    <figcaption>{{ value || '—' }}</figcaption>
  </figure>
</template>

<style scoped>
.barcode{display:inline-flex;flex-direction:column;align-items:center;gap:4px;margin:0}.barcode-svg{display:flex;max-width:280px;max-height:84px;overflow:hidden;background:#fff}.barcode-svg :deep(svg){display:block;width:auto;max-width:100%;height:64px}.barcode-unavailable{padding:8px;color:#909399;border:1px dashed #dcdfe6}figcaption{font:11px monospace;color:#303133}
</style>