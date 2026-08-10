import { defineStore } from 'pinia';

export const useTaskCardStore = defineStore('taskCard', {
  state: () => ({
    current: null,
    selectedRows: [],
    filters: {},
  }),
  actions: {
    setCurrent(card) {
      this.current = card;
    },
    setSelectedRows(rows) {
      this.selectedRows = Array.isArray(rows) ? rows : [];
    },
    reset() {
      this.current = null;
      this.selectedRows = [];
      this.filters = {};
    },
  },
});
