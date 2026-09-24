// main.js — entry point: 3D engine -> the TTD game (Game.js: world simulation, 3D view, camera,
// HUD) -> frame loop (Sound3D hears from where the camera is). window.app = { game, camera, view } —
// for the console and for tests driving the page.

function updateLoadingProgress(percent) {
    const bar = /** @type {HTMLElement | null} */ (document.querySelector('.loading-progress'));
    if (bar) bar.style.width = percent + '%';
}

// The loading screen goes away when the first world is on screen.
function hideLoader() {
    updateLoadingProgress(100);
    setTimeout(() => {
        const screen = document.getElementById('loading-screen');
        if (screen) screen.style.display = 'none';
    }, 300);
}

function showBootError(text) {
    console.error(text);
    const el = document.querySelector('.loading-text');
    if (el) el.textContent = text;
}

function startGame() {
    if (window.app) return;                 // guard against a repeated start
    if (typeof SimplexNoise === 'undefined') { showBootError('No libs/simplex-noise.js'); return; }
    const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('world3d'));
    updateLoadingProgress(40);
    if (!World3D.init(canvas)) { showBootError('3D unavailable: no libs/babylon.js or WebGL'); return; }
    UI.init(canvas);
    const game = new Game(canvas);
    window.app = { game, camera: game.camera, view: game.view };
    updateLoadingProgress(70);

    let last = performance.now();
    World3D.engine.runRenderLoop(() => {
        const now = performance.now(), dt = (now - last) / 1000;
        last = now;
        game.update(Math.min(0.1, dt));
        game.camera.update(dt);
        Sound3D.update(game.camera);
        World3D.renderFrame();
    });
    window.addEventListener('resize', () => World3D.resize());
    game.ready.then(hideLoader);
}

window.onload = () => startGame();
