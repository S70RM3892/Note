/** 受験ハブ: everything around the notes — strategy, planning, learning tools, health — on one screen. */
import type { App, View } from '../app/app';
import { h } from '../ui/dom';
import { icon } from '../ui/icons';
import { GROUPS, TOOLS, type ToolCtx } from './tools';

export class HubView implements View {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private cleanup: (() => void)[] = [];

  constructor(
    private app: App,
    private toolId?: string,
  ) {
    const tool = toolId ? TOOLS.find((t) => t.id === toolId) : undefined;
    this.body = h('div', { class: 'hub-body' });
    this.el = h(
      'div',
      { class: 'lib hub', 'data-testid': tool ? `hub-${tool.id}` : 'hub' },
      h(
        'header',
        { class: 'lib-head' },
        h('button', { class: 'icon-btn', 'aria-label': '戻る', 'data-testid': 'hub-back', onclick: () => app.go(tool ? '#/hub' : '#/') }, icon('back')),
        h('div', { class: 'brand' }, tool ? tool.title : '受験ハブ'),
        h('span', { class: 'spacer' }),
      ),
      h('div', { class: 'lib-scroll' }, this.body),
    );
    void app.hub.ready.then(() => this.render());
  }

  private ctx(): ToolCtx {
    return {
      app: this.app,
      hub: this.app.hub,
      refresh: () => this.render(),
      open: (id) => this.app.go(id ? `#/hub/${id}` : '#/hub'),
      onLeave: (fn) => this.cleanup.push(fn),
    };
  }

  private render() {
    this.runCleanup();
    const ctx = this.ctx();
    const tool = this.toolId ? TOOLS.find((t) => t.id === this.toolId) : undefined;
    if (tool) {
      this.body.replaceChildren(h('div', { class: 'hub-page' }, tool.render(ctx)));
      return;
    }
    this.body.replaceChildren(
      h(
        'div',
        { class: 'hub-page' },
        h('p', { class: 'muted hub-lead' }, 'ノートの外側：合格までの戦略・計画・暗記と情報Ⅰの道具・体調。数字は公式の資料から（各ページに出典）。'),
        GROUPS.map((g) =>
          h(
            'section',
            { class: 'hub-group' },
            h('h2', null, g.title),
            h(
              'div',
              { class: 'hub-grid' },
              TOOLS.filter((t) => t.group === g.id && (!t.available || t.available())).map((t) => {
                let summary: string | null = null;
                try {
                  summary = t.summary?.(ctx) ?? null;
                } catch (e) {
                  console.warn(t.id, e);
                }
                return h(
                  'button',
                  { class: 'hub-tile', 'data-testid': `hub-tile-${t.id}`, onclick: () => ctx.open(t.id) },
                  h('span', { class: 'hub-tile-icon' }, icon(t.icon, 20)),
                  h('span', { class: 'hub-tile-text' }, h('b', null, t.title), summary ? h('small', null, summary) : h('small', { class: 'muted' }, t.blurb)),
                );
              }),
            ),
          ),
        ),
      ),
    );
  }

  private runCleanup() {
    this.cleanup.splice(0).forEach((fn) => {
      try {
        fn();
      } catch {
        /* ignore */
      }
    });
  }

  destroy() {
    this.runCleanup();
    void this.app.hub.flush();
  }
}
