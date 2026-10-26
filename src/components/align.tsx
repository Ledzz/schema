import { AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalDistributeCenter, AlignStartHorizontal, AlignStartVertical, AlignVerticalDistributeCenter } from 'lucide-react';
import type { AlignMode } from '../lib/schematic/ops';

/** Align and distribute commands for the Edit menu and the inspector, with how many items each needs. */
export const ALIGN_ACTIONS: { mode: AlignMode; label: string; min: number; icon: React.ReactNode }[] = [
  { mode: 'left', label: 'Align left', min: 2, icon: <AlignStartVertical className="h-3.5 w-3.5" /> },
  { mode: 'center', label: 'Align centres horizontally', min: 2, icon: <AlignCenterVertical className="h-3.5 w-3.5" /> },
  { mode: 'right', label: 'Align right', min: 2, icon: <AlignEndVertical className="h-3.5 w-3.5" /> },
  { mode: 'top', label: 'Align top', min: 2, icon: <AlignStartHorizontal className="h-3.5 w-3.5" /> },
  { mode: 'middle', label: 'Align middles vertically', min: 2, icon: <AlignCenterHorizontal className="h-3.5 w-3.5" /> },
  { mode: 'bottom', label: 'Align bottom', min: 2, icon: <AlignEndHorizontal className="h-3.5 w-3.5" /> },
  { mode: 'distribute-x', label: 'Distribute horizontally', min: 3, icon: <AlignHorizontalDistributeCenter className="h-3.5 w-3.5" /> },
  { mode: 'distribute-y', label: 'Distribute vertically', min: 3, icon: <AlignVerticalDistributeCenter className="h-3.5 w-3.5" /> },
];
