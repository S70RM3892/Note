import type { App } from '../../app/app';
import type { IconName } from '../../ui/icons';
import type { HubStore } from '../data';
import { HEALTH_TOOLS } from './health';
import { INFO_TOOLS } from './info';
import { LEARN_TOOLS } from './learn';
import { PLAN_TOOLS } from './plan';
import { STRATEGY_TOOLS } from './strategy';

export interface ToolCtx {
  app: App;
  hub: HubStore;
  /** Draw the page again from the store. */
  refresh(): void;
  /** Go to another tool (or the hub). */
  open(id?: string): void;
  /** Run when the page is left (stop audio, timers…). */
  onLeave(fn: () => void): void;
}

export interface Tool {
  id: string;
  group: string;
  title: string;
  /** What it is, on the tile before it holds anything. */
  blurb: string;
  icon: IconName;
  /** One line of current state for the tile. */
  summary?(ctx: ToolCtx): string | null;
  render(ctx: ToolCtx): HTMLElement;
  available?(): boolean;
}

export const GROUPS = [
  { id: 'strategy', title: '合格戦略' },
  { id: 'plan', title: '計画と振り返り' },
  { id: 'learn', title: '覚える・解く' },
  { id: 'info', title: '情報Ⅰ' },
  { id: 'health', title: '体調・睡眠' },
];

export const TOOLS: Tool[] = [...STRATEGY_TOOLS, ...PLAN_TOOLS, ...LEARN_TOOLS, ...INFO_TOOLS, ...HEALTH_TOOLS];
