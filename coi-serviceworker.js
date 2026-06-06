/*! coi-serviceworker v0.1.7 + vertcut-transcode-guard - Guido Zuidhof and contributors, licensed under MIT.
    Регистрация cross-origin-isolated SW: на статических хостингах (GitHub Pages,
    Vercel-без-конфига, Netlify-без-конфига и т.п.), которые не выставляют
    COOP/COEP-заголовки, этот SW перехватывает все fetch-ответы и сам подкладывает
    нужные заголовки. После первой регистрации страница перезагружается, и
    SharedArrayBuffer становится доступен — FFmpeg.wasm и Whisper запускаются.

    === vertcut-transcode-guard (r8) ===
    Дополнительно: пока идёт AV1 → H.264 транскод, SW перехватывает top-level
    навигацию (F5 / Ctrl+R / Ctrl+W / клик по ссылке) и показывает "hold-on"
    страницу с прогрессом и кнопкой "Прервать". Это НЕ спасает транскод от
    убийства процесса (для этого нужен Web Worker) — но даёт пользователю
    осознанный выбор "прервать и перезагрузить" вместо тихой потери работы. */
let coepCredentialless = false;

// === vertcut-transcode-guard state ===
// state.active = true пока main-page сообщает о работе транскода
// state.progress / state.phase обновляются с каждым onProgress
// state.clientId — id клиента, который ведёт транскод (для relay abort)
let transcodeState = {
    active: false,
    progress: 0,
    phase: 'idle',
    fileName: '',
    elapsedMs: 0,
    clientId: null,
    startedTs: 0,
};

function buildHoldOnPage() {
    // Self-contained HTML: progress + abort button + polling. Никаких
    // внешних ресурсов, чтобы SW мог ответить на любой навигационный
    // запрос без сетевых зависимостей.
    return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VertCut — идёт конвертация</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0;
    min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    background: linear-gradient(135deg, #1a0b2e 0%, #2d1b4e 50%, #1a0b2e 100%);
    color: #e8e6f0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .card {
    max-width: 480px; width: calc(100% - 32px);
    background: rgba(30, 20, 50, 0.85);
    border: 1px solid rgba(255, 61, 110, 0.3);
    border-radius: 16px;
    padding: 32px 24px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 61, 110, 0.1);
  }
  h1 { margin: 0 0 8px; font-size: 20px; font-weight: 700; }
  .sub { color: #b0a8c5; font-size: 14px; margin-bottom: 20px; }
  .file { color: #ff3d6e; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; word-break: break-all; }
  .progress-track {
    height: 8px; background: rgba(255, 255, 255, 0.08); border-radius: 4px;
    overflow: hidden; margin: 16px 0 8px;
  }
  .progress-fill {
    height: 100%; background: linear-gradient(90deg, #ff7a18, #ff3d6e);
    width: 0%; transition: width 300ms ease-out;
  }
  .meta { display: flex; justify-content: space-between; font-size: 13px; color: #b0a8c5; margin-top: 6px; }
  .meta .phase { color: #fff; font-weight: 600; }
  .btns { display: flex; gap: 12px; margin-top: 24px; }
  button {
    flex: 1; padding: 12px 16px; border-radius: 8px; border: 0;
    font-size: 14px; font-weight: 600; cursor: pointer;
    transition: transform 100ms, box-shadow 200ms;
  }
  button:active { transform: scale(0.97); }
  .btn-wait { background: rgba(255, 255, 255, 0.08); color: #fff; }
  .btn-wait:hover { background: rgba(255, 255, 255, 0.15); }
  .btn-abort { background: linear-gradient(90deg, #ff3d6e, #d62a5c); color: #fff; }
  .btn-abort:hover { box-shadow: 0 4px 16px rgba(255, 61, 110, 0.4); }
  .note { font-size: 11px; color: #6b5b8a; margin-top: 20px; line-height: 1.5; }
  .pulse { animation: pulse 1.5s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
</style>
</head>
<body>
<div class="card">
  <h1>🎬 Идёт конвертация видео</h1>
  <div class="sub">Файл: <span class="file" id="fname">—</span></div>
  <div class="progress-track"><div class="progress-fill pulse" id="pfill"></div></div>
  <div class="meta">
    <span class="phase" id="phase">encoding</span>
    <span id="pct">0%</span>
  </div>
  <div class="meta" style="margin-top: 2px;">
    <span>Прошло: <span id="elapsed">0s</span></span>
    <span>Состояние: <span id="state">active</span></span>
  </div>
  <div class="btns">
    <button class="btn-wait" id="btn-wait">Дождаться</button>
    <button class="btn-abort" id="btn-abort">Прервать и перезагрузить</button>
  </div>
  <div class="note">
    Если закроете вкладку или убьёте процесс — транскод потеряется
    (WebCodecs работает в main-thread, отдельный Worker пока не используется).
    Лучше дождаться или прервать.
  </div>
</div>
<script>
  const fmtPct = p => Math.round(p * 100) + '%';
  const fmtElapsed = ms => {
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  };

  // Polling state: запрашиваем у SW текущий state каждые 250мс
  let pollTimer = null;
  let aborted = false;

  async function poll() {
    if (aborted) return;
    try {
      const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (!sw) {
        // SW не контролирует — fallback: редирект через 3 секунды
        document.getElementById('state').textContent = 'no controller';
        return;
      }
      const ch = new MessageChannel();
      const stateP = new Promise(resolve => {
        ch.port1.onmessage = (ev) => resolve(ev.data);
      });
      sw.postMessage({ type: 'hold-on-poll' }, [ch.port2]);
      const state = await Promise.race([
        stateP,
        new Promise(r => setTimeout(() => r(null), 1000)),
      ]);
      if (!state) return;
      applyState(state);
    } catch (e) {
      console.error('[hold-on] poll failed', e);
    }
  }

  function applyState(state) {
    document.getElementById('fname').textContent = state.fileName || '—';
    const phase = state.phase === 'muxing' ? 'Muxing…'
                : state.phase === 'done' ? 'Готово'
                : 'Encoding…';
    document.getElementById('phase').textContent = phase;
    document.getElementById('pct').textContent = fmtPct(state.progress);
    document.getElementById('pfill').style.width = fmtPct(state.progress);
    document.getElementById('elapsed').textContent = fmtElapsed(state.elapsedMs);

    if (!state.active) {
      // Транскод завершён (или был прерван) → пропускаем навигацию
      document.getElementById('state').textContent = 'done — перезагрузка…';
      document.getElementById('pfill').classList.remove('pulse');
      // Небольшая задержка чтобы юзер увидел «Готово»
      setTimeout(() => {
        // Reload текущего URL — SW теперь не перехватит, т.к. active=false
        // (но если user жал «Дождаться» — мы держим reload до явного клика)
      }, 1500);
    }
  }

  document.getElementById('btn-wait').addEventListener('click', () => {
    document.getElementById('state').textContent = 'waiting — закройте или ждите';
  });

  document.getElementById('btn-abort').addEventListener('click', async () => {
    aborted = true;
    if (pollTimer) clearInterval(pollTimer);
    document.getElementById('state').textContent = 'aborting…';
    try {
      const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (sw) {
        const ch = new MessageChannel();
        const ackP = new Promise(resolve => { ch.port1.onmessage = e => resolve(e.data); });
        sw.postMessage({ type: 'hold-on-abort' }, [ch.port2]);
        await Promise.race([ackP, new Promise(r => setTimeout(() => r(null), 1500))]);
      }
    } catch (e) {
      console.error('[hold-on] abort failed', e);
    }
    // Даём SW время на relay-abort, потом перезагружаем
    setTimeout(() => { window.location.reload(); }, 500);
  });

  // Старт polling
  poll();
  pollTimer = setInterval(poll, 500);
</script>
</body>
</html>`;
}

function isHoldOnRequest(r) {
    // Top-level navigation: method=GET, mode=navigate, destination=document
    return r.method === 'GET'
        && (r.mode === 'navigate' || r.destination === 'document');
}

if (typeof window === 'undefined') {
    // === SW context ===
    self.addEventListener("install", () => self.skipWaiting());
    self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

    self.addEventListener("message", (ev) => {
        if (!ev.data) return;
        const data = ev.data;
        if (data.type === "deregister") {
            self.registration
                .unregister()
                .then(() => self.clients.matchAll())
                .then((clients) => clients.forEach((client) => client.navigate(client.url)));
        } else if (data.type === "coepCredentialless") {
            coepCredentialless = data.value;
        } else if (data.type === "transcode-state") {
            // Main page шлёт обновления состояния транскода
            transcodeState.active = !!data.active;
            transcodeState.progress = data.progress || 0;
            transcodeState.phase = data.phase || 'idle';
            transcodeState.fileName = data.fileName || '';
            transcodeState.elapsedMs = data.elapsedMs || 0;
            // Capture clientId из event.source (auto-generated by browser).
            // Это надёжнее, чем main page слать свой id (его нельзя получить).
            if (ev.source && ev.source.id) {
                transcodeState.clientId = ev.source.id;
            }
            if (transcodeState.active && !transcodeState.startedTs) {
                transcodeState.startedTs = Date.now();
            }
            if (!transcodeState.active) {
                transcodeState.startedTs = 0;
                transcodeState.clientId = null;
            }
        } else if (data.type === "hold-on-poll") {
            // Hold-on page опрашивает state
            if (ev.ports && ev.ports[0]) {
                ev.ports[0].postMessage({
                    active: transcodeState.active,
                    progress: transcodeState.progress,
                    phase: transcodeState.phase,
                    fileName: transcodeState.fileName,
                    elapsedMs: transcodeState.elapsedMs,
                });
            }
        } else if (data.type === "hold-on-abort") {
            // Hold-on page просит прервать транскод → relay к main page
            (async () => {
                try {
                    const allClients = await self.clients.matchAll({ includeUncontrolled: true });
                    // Ищем клиент с активным транскодом
                    const target = allClients.find(c => c.id === transcodeState.clientId)
                                || allClients[0];
                    if (target) {
                        target.postMessage({ type: 'transcode-abort-request' });
                    }
                    // Снимаем блокировку чтобы navigation прошла
                    transcodeState.active = false;
                    if (ev.ports && ev.ports[0]) {
                        ev.ports[0].postMessage({ ok: true });
                    }
                } catch (e) {
                    if (ev.ports && ev.ports[0]) {
                        ev.ports[0].postMessage({ ok: false, error: String(e) });
                    }
                }
            })();
        }
    });

    self.addEventListener("fetch", function (event) {
        const r = event.request;

        // === r8: vertcut-transcode-guard ===
        // Если идёт транскод, перехватываем top-level навигацию и показываем
        // hold-on page. Это НЕ спасает работу от kill процесса, но даёт
        // пользователю осознанный выбор (прервать и перезагрузить vs ждать).
        if (transcodeState.active && isHoldOnRequest(r)) {
            event.respondWith(
                new Response(buildHoldOnPage(), {
                    status: 200,
                    statusText: "OK",
                    headers: {
                        "Content-Type": "text/html; charset=utf-8",
                        "Cache-Control": "no-store, no-cache, must-revalidate",
                    },
                })
            );
            return;
        }

        if (r.cache === "only-if-cached" && r.mode !== "same-origin") {
            return;
        }

        const request = (coepCredentialless && r.mode === "no-cors")
            ? new Request(r, {
                credentials: "omit",
            })
            : r;
        event.respondWith(
            fetch(request)
                .then((response) => {
                    if (response.status === 0) {
                        return response;
                    }

                    const newHeaders = new Headers(response.headers);
                    newHeaders.set("Cross-Origin-Embedder-Policy",
                        coepCredentialless ? "credentialless" : "require-corp"
                    );
                    if (!coepCredentialless) {
                        newHeaders.set("Cross-Origin-Resource-Policy", "cross-origin");
                    }
                    newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");

                    return new Response(response.body, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: newHeaders,
                    });
                })
                .catch((e) => console.error(e))
        );
    });

} else {
    // === Main page registration logic ===
    (() => {
        const reloadedBySelf = window.sessionStorage.getItem("coiReloadedBySelf");
        window.sessionStorage.removeItem("coiReloadedBySelf");
        const coepDegrading = (reloadedBySelf == "coepdegrade");

        const coi = {
            shouldRegister: () => !reloadedBySelf,
            shouldDeregister: () => false,
            coepCredentialless: () => true,
            coepDegrade: () => true,
            doReload: () => window.location.reload(),
            quiet: false,
            ...window.coi
        };

        const n = navigator;

        if (n.serviceWorker && n.serviceWorker.controller) {
            n.serviceWorker.controller.postMessage({
                type: "coepCredentialless",
                value: (coepDegrading || !coi.coepCredentialless()) ? false : true,
            });

            if (coi.shouldDeregister()) {
                n.serviceWorker.controller.postMessage({ type: "deregister" });
            }
        }

        if (window.crossOriginIsolated !== false || !coi.shouldRegister()) return;

        if (!window.isSecureContext) {
            !coi.quiet && console.log("COOP/COEP Service Worker not registered, a secure context is required.");
            return;
        }

        if (!n.serviceWorker) {
            !coi.quiet && console.error("COOP/COEP Service Worker not registered, perhaps due to private mode.");
            return;
        }

        n.serviceWorker.register(window.document.currentScript.src).then(
            (registration) => {
                !coi.quiet && console.log("COOP/COEP Service Worker registered", registration.scope);

                registration.addEventListener("updatefound", () => {
                    !coi.quiet && console.log("Reloading page to make use of updated COOP/COEP Service Worker.");
                    window.sessionStorage.setItem("coiReloadedBySelf", "updatedworker");
                    coi.doReload();
                });

                if (registration.active && !n.serviceWorker.controller) {
                    !coi.quiet && console.log("Reloading page to make use of COOP/COEP Service Worker.");
                    window.sessionStorage.setItem("coiReloadedBySelf", "notcontrolling");
                    coi.doReload();
                }
            },
            (err) => {
                !coi.quiet && console.error("COOP/COEP Service Worker failed to register:", err);
                if (coi.coepDegrade()) {
                    window.sessionStorage.setItem("coiReloadedBySelf", "coepdegrade");
                    coi.doReload();
                }
            }
        );
    })();
}
