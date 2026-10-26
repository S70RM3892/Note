import './styles.css';
import { App } from './app/app';
import { importIncomingShares } from './app/share';
import { AssetCache } from './editor/assets';
import { Repo } from './store/repo';
import { SettingsStore } from './store/settings';
import { StatsTracker } from './study/stats';
import { h } from './ui/dom';

declare global {
  interface Window {
    sumi?: App;
  }
}

async function boot() {
  const repo = await Repo.open();
  const settings = new SettingsStore(await repo.loadSettings(), (s) => void repo.kvSet('settings', s));
  const assets = new AssetCache(repo);
  const stats = new StatsTracker(repo, await repo.loadStats());
  const app = new App(repo, settings, assets, stats);
  window.sumi = app;
  // Ask the browser not to evict our data under storage pressure.
  void navigator.storage?.persist?.().catch(() => {});
  if (location.hash.startsWith('#/share')) await importIncomingShares(app);
  else await app.route();
  void repo.collectAssets().catch(() => {});
  registerServiceWorker();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  navigator.serviceWorker
    .register('./sw.js')
    .then((reg) => {
      const offer = (w: ServiceWorker) => {
        const bar = h(
          'div',
          { class: 'update-bar' },
          h('span', null, '新しいバージョンがあります'),
          h(
            'button',
            {
              class: 'btn primary small',
              onclick: async () => {
                await window.sumi?.flush();
                w.postMessage('skipWaiting');
              },
            },
            '更新',
          ),
        );
        document.body.appendChild(bar);
      };
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
        });
      });
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded) return;
        reloaded = true;
        location.reload();
      });
      // Check for updates when the app comes back to the foreground.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void reg.update().catch(() => {});
      });
    })
    .catch((e) => console.warn('SW registration failed', e));
}

boot().catch((e) => {
  console.error(e);
  document.getElementById('app')!.replaceChildren(
    h('div', { class: 'empty' }, h('h2', null, '起動に失敗しました'), h('p', null, String(e?.message ?? e))),
  );
});
