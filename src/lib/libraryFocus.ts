import { useEditor } from '../store/editor';

let searchInput: HTMLInputElement | null = null;

export function registerLibrarySearch(el: HTMLInputElement | null) {
  searchInput = el;
}

/** Opens the parts library and focuses its search box. */
export function focusLibrarySearch() {
  useEditor.getState().setLibraryOpen(true);
  requestAnimationFrame(() => {
    searchInput?.focus();
    searchInput?.select();
  });
}
