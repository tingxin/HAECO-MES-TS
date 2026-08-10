import { config } from '@vue/test-utils';

config.global.stubs = {
  transition: false,
  'transition-group': false,
};

Object.defineProperty(globalThis.URL, 'createObjectURL', { configurable: true, value: () => 'blob:test' });
Object.defineProperty(globalThis.URL, 'revokeObjectURL', { configurable: true, value: () => {} });

class ResizeObserverMock { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = ResizeObserverMock;
globalThis.matchMedia = globalThis.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));