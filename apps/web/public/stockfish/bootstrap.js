/* eslint-env worker */
/* Bootstrap worker: loads Stockfish wasm into this worker and forwards UCI
 * messages between the main thread and the engine.
 *
 * Main thread → us:  string UCI commands (and the literal '__init__' to boot)
 * Us → main thread:  string UCI replies (info lines, bestmove, etc.)
 *                    plus diagnostic messages prefixed '__bootstrap__'
 */

function diag(msg) {
  postMessage('__bootstrap__:' + msg);
}

self.onerror = function (e) {
  diag('worker.onerror: ' + (e && (e.message || e)));
};

let sf = null;
const queued = [];
let initStarted = false;

function init() {
  if (initStarted) return;
  initStarted = true;

  diag(
    'crossOriginIsolated=' +
      String(typeof self.crossOriginIsolated !== 'undefined' ? self.crossOriginIsolated : 'unknown') +
      ' SAB=' +
      (typeof SharedArrayBuffer !== 'undefined') +
      ' wasm=' +
      (typeof WebAssembly !== 'undefined'),
  );

  try {
    importScripts('/stockfish/stockfish.js');
  } catch (e) {
    diag('importScripts failed: ' + (e && e.message));
    return;
  }

  if (typeof Stockfish !== 'function') {
    diag('Stockfish factory missing after importScripts');
    return;
  }

  // Resolve absolute URLs for stockfish.js, stockfish.wasm, stockfish.worker.js.
  // Inside this bootstrap worker, `document.currentScript` is undefined, so
  // Emscripten can't auto-detect where its files live. Without these the
  // pthread workers spawn but never finish loading (e.g., they receive
  // `urlOrBlob: undefined` and silently fail to importScripts).
  const stockfishJsUrl = new URL('stockfish.js', self.location.href).href;
  const moduleOverrides = {
    mainScriptUrlOrBlob: stockfishJsUrl,
    locateFile: function (path) {
      return new URL(path, self.location.href).href;
    },
  };
  diag('using stockfish.js at ' + stockfishJsUrl);

  let factoryReturn;
  try {
    factoryReturn = Stockfish(moduleOverrides);
  } catch (e) {
    diag('Stockfish() threw: ' + (e && e.message));
    return;
  }

  if (!factoryReturn || typeof factoryReturn.then !== 'function') {
    diag('Stockfish() did not return a Promise (got ' + typeof factoryReturn + ')');
    return;
  }

  factoryReturn
    .then(function (engine) {
      sf = engine;
      sf.addMessageListener(function (line) {
        postMessage(line);
      });
      for (const m of queued) sf.postMessage(m);
      queued.length = 0;
      diag('ready');
      postMessage('__ready__');
    })
    .catch(function (e) {
      diag('Stockfish promise rejected: ' + (e && (e.message || e)));
    });
}

self.onmessage = function (e) {
  const msg = e.data;
  if (msg === '__init__') {
    init();
    return;
  }
  if (sf) sf.postMessage(msg);
  else queued.push(msg);
};
