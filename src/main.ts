import './styles.css';
import { App } from './app/app';
import { installNativeGlue } from './app/nativeGlue';
import { installErrorLog, noticeCrashes } from './app/diagnostics';
import { importIncomingShares } from './app/share';
import { AssetCache } from './editor/assets';
import { clipboardAssets } from './editor/selection';
import { isNativeApp } from './platform';
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
  installErrorLog();
  const repo = await Repo.open();
  let settingsTimer = 0;
  const settings = new SettingsStore(await repo.loadSettings(), (s) => {
    clearTimeout(settingsTimer);
    settingsTimer = window.setTimeout(() => void repo.kvSet('settings', s), 300);
  });
  const assets = new AssetCache(repo);
  const stats = new StatsTracker(repo, await repo.loadStats());
  const app = new App(repo, settings, assets, stats);
  window.sumi = app;
  // Ask the browser not to evict our data under storage pressure.
  void navigator.storage?.persist?.().catch(() => {});
  if (location.hash.startsWith('#/share')) await importIncomingShares(app);
  else await app.route();
  // The APK ships its files inside the package: no service worker, updates come with the APK.
  if (isNativeApp()) {
    installNativeGlue(app);
    setTimeout(() => void noticeCrashes(), 1500);
  } else registerServiceWorker();
  // Weekly, when idle: drop images/PDFs no page references any more.
  const lastGc = (await repo.kvGet<number>('lastGc')) ?? 0;
  if (Date.now() - lastGc > 7 * 86400000) {
    // Only from the library: an open editor may still need a deleted image for undo.
    const run = () => {
      if (!/^#?\/?$/.test(location.hash)) return;
      void repo.collectAssets(clipboardAssets()).then(() => repo.kvSet('lastGc', Date.now())).catch(() => {});
    };
    if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 30000 });
    else setTimeout(run, 10000);
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  // Reload only when the user accepted an update — not when the first install claims the page.
  let updateRequested = false;
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
                updateRequested = true;
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
        if (reloaded || !updateRequested) return;
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
