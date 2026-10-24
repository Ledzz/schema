import { create } from 'zustand';
import type { WebMcpStatus } from '../lib/webmcp';

export const useWebMcp = create<{ status: WebMcpStatus | null; set: (s: WebMcpStatus) => void }>()((set) => ({
  status: null,
  set: (status) => set({ status }),
}));
