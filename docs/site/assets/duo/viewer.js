(() => {
  const root = document.getElementById('duo-viewer');
  if (!root) return;
  const stage = document.getElementById('duo-stage');
  const status = document.getElementById('duo-status');
  const slider = document.getElementById('duo-fold');
  const output = document.getElementById('duo-angle');
  const start = root.querySelector('.duo-start');
  const buttons = [...root.querySelectorAll('[data-pose]')];
  const url = path => new URL(path, document.baseURI).href;
  const say = (zh, en) => { status.replaceChildren(); for (const [lang, text] of [['zh', zh], ['en', en]]) { const span = document.createElement('span'); span.lang = lang; span.textContent = text; status.append(span); } };
  let loading = false;
  let scene;
  const select = label => buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.pose === label)));
  const angle = value => { output.value = `${Math.round(value * 100)}%`; };

  async function load() {
    if (loading) return;
    loading = true;
    root.dataset.state = 'loading';
    start.disabled = true;
    say('正在加载 3D 模型…', 'Loading the 3D model…');
    let timeout;
    try {
      await Promise.race([initialize(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Loading timed out')), 45000); })]);
      root.dataset.state = 'ready';
      buttons.forEach(button => { button.disabled = false; });
      slider.disabled = false;
      say('点选姿态，拖动模型自由旋转', 'Choose a pose. Drag to rotate.');
    } catch (error) {
      root.dataset.state = 'error';
      start.hidden = true;
      say('3D 预览暂不可用，可在下方查看实际截图。', '3D is unavailable. View the app screenshot below.');
      console.warn('LinkShell Duo viewer:', error);
    } finally { clearTimeout(timeout); }
  }

  async function initialize() {
    const probe = document.createElement('canvas').getContext('webgl2');
    if (!probe) throw new Error('WebGL2 unavailable');
    probe.getExtension('WEBGL_lose_context')?.loseContext();
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url('assets/duo/graphics.js');
      script.onload = resolve;
      script.onerror = () => reject(new Error('Graphics runtime unavailable'));
      document.head.append(script);
    });
    const { Lotus: api, chunks, scripts } = window.LinkShellDuoGraphics;
    const { Lotus, THREE, MobX } = api;
    Lotus.settings.dprTest = () => Math.min(devicePixelRatio, 2);
    const loader = new THREE.TextureLoader();
    const entries = await Promise.all([
      ['landscape', 'assets/promo/iphone-duo-expanded-dark.png'],
      ['closed', 'assets/duo/closed.png'],
      ['portrait', 'assets/duo/portrait.png'],
      ['laptop', 'assets/duo/laptop.png'],
      ['standing', 'assets/duo/standing.png'],
    ].map(async ([name, path]) => {
      let map = await loader.loadAsync(url(path));
      // Inner-display UVs are landscape even when the physical device is upright.
      if (name === 'portrait' || name === 'laptop' || name === 'standing') {
        const canvas = document.createElement('canvas');
        canvas.width = map.image.height;
        canvas.height = map.image.width;
        const context = canvas.getContext('2d');
        if (name === 'standing') {
          // Tent mode turns the outer display clockwise; counter-rotate its landscape capture.
          context.translate(0, canvas.height);
          context.rotate(-Math.PI / 2);
        } else {
          context.translate(canvas.width, 0);
          context.rotate(Math.PI / 2);
        }
        context.drawImage(map.image, 0, 0);
        map.dispose();
        map = new THREE.CanvasTexture(canvas);
      }
      map.flipY = true;
      map.colorSpace = THREE.SRGBColorSpace;
      map.anisotropy = 4;
      return [name, map];
    }));
    const textures = Object.fromEntries(entries);
    let screenKeys = ['landscape', 'closed'];
    let zoom = 2.00;

    class ScreenWipe extends chunks.Wipe {
      constructor(args) {
        super(args);
        const material = args.material;
        const render = material.onBeforeRender;
        let previous;
        let motion = 0;
        material.onBeforeRender = (...params) => {
          const position = this.hingeScript?.position ?? 1;
          const delta = previous === undefined ? 0 : Math.abs(position - previous);
          previous = position;
          motion = Math.max(delta * 90, motion * .82);
          if (motion < .01) motion = 0;
          // App pixels follow the display UVs; wallpaper's planar projection distorts text.
          material.uniforms.transitionToCameraRest.value = 1;
          material.uniforms.wipeAmount.value = Math.min(1, motion) * Math.sin(Math.PI * position) * .4;
          render(...params);
          if (motion) Lotus.tryRequestAnimationFrame();
        };
      }
    }
    ScreenWipe.fields = chunks.Wipe.fields;
    class Screen extends api.Chunk {
      constructor({ component, data, material }) {
        super({ component, data, material, name: 'Wallpaper', instructions: [] });
        material.emissive = new THREE.Color(0xffffff);
        material.emissiveMap = textures.landscape;
        material.emissiveIntensity = 1;
        material.toneMapped = false;
        material.needsUpdate = true;
      }
    }
    Screen.fields = { ...api.ChunkFields };
    class ScreenRenderer { constructor() { this.ready = true; } destroy() {} }
    ScreenRenderer.supports = ['script'];
    ScreenRenderer.fields = {};
    class ScreenTransition extends scripts.FadeThroughBlack {
      async initFadeConfig() { this.TEXTURE_LOOKUP = {}; this.SCREEN_TEXTURES = textures; this.DARK = 0; this.BRIGHT = 1; }
      resolveTexture() { return screenKeys; }
      applyScreenTextures(keys) {
        [this.insideMesh, this.outsideMesh].forEach((mesh, index) => {
          mesh.material.emissiveMapTarget = textures[keys[index]];
          mesh.material.uniforms.enableFraming.value = true;
        });
      }
    }
    ScreenTransition.fields = scripts.FadeThroughBlack.fields;
    class CenteredCamera extends scripts.CameraMixerOffset {
      onLoop() {
        super.onLoop();
        if (!this.ready) return;
        const target = stage.clientWidth < 500 ? Math.min(zoom, 1.25) : zoom;
        this.camera.zoom += (target - this.camera.zoom) * .15;
        if (Math.abs(target - this.camera.zoom) < .001) this.camera.zoom = target;
        else Lotus.tryRequestAnimationFrame();
        this.camera.clearViewOffset();
      }
    }
    CenteredCamera.fields = scripts.CameraMixerOffset.fields;
    class DuoScene extends api.CustomScene {
      init() {
        Lotus.chunks.initialize({ ...chunks, Wipe: ScreenWipe, Wallpaper: Screen });
        Lotus.scripts.initialize({ ...scripts, WallpaperRenderer: ScreenRenderer, CameraMixerOffset: CenteredCamera, FadeThroughBlack: ScreenTransition });
        super.init();
      }
      create() {
        super.create();
        this.mainWeights = this.getComponentsByName('weights_main')[0].scripts.get('VariantWeightsMixer');
        this.poseWeights = this.getComponentsByName('weights_pt')[0].scripts.get('VariantWeights');
      }
      onPointerStart() {
        if (!this.mainWeights || this.freeOrbit) return;
        this.freeOrbit = true;
        root.dataset.pose = 'free';
        zoom = 1.65;
        const camera = this.getComponentsByName('camera_360')[0].scripts.get('InteractiveCamera');
        const open = this.getComponentByName('YvVAegQhHvoGyyp:Hinge').target > .6;
        camera.data.angles = open ? 'uKtkkwyBlvwChQg' : 'aPrkGWufFevjiao';
        this.states.set('angles', open ? 'front_Open' : 'front');
        this.mainWeights.mixSpring.targetValue = 0;
        select(null);
        Lotus.tryRequestAnimationFrame();
      }
      pose(label) {
        root.dataset.pose = label;
        zoom = { PT_Landscape: 2.00, PT_Portrait: 1.25, PT_Closed: 1.82, PT_Laptop: 2.00, PT_Tent: 2.40 }[label];
        this.freeOrbit = false;
        screenKeys = [label === 'PT_Portrait' ? 'portrait' : label === 'PT_Laptop' ? 'laptop' : 'landscape', label === 'PT_Tent' ? 'standing' : 'closed'];
        this.mainWeights.mixSpring.targetValue = 1;
        this.poseWeights.setWeightTargets([{ label, weight: 1 }]);
        Lotus.tryRequestAnimationFrame();
      }
      fold(value) {
        root.dataset.pose = 'fold';
        zoom = 2.00;
        this.freeOrbit = false;
        // Slider poses unfold the inner display in landscape; the closed outer display stays portrait.
        screenKeys = ['landscape', 'closed'];
        this.mainWeights.mixSpring.targetValue = 1;
        const points = value <= 1 / 3 ? [[0, 'PT_SliderClosed'], [1 / 3, 'PT_SliderLanding']] : [[1 / 3, 'PT_SliderLanding'], [1, 'PT_SliderOpen']];
        const t = (value - points[0][0]) / (points[1][0] - points[0][0]);
        this.poseWeights.setWeightTargets([{ label: points[0][1], weight: 1 - t }, { label: points[1][1], weight: t }]);
        Lotus.tryRequestAnimationFrame();
      }
    }
    const response = await fetch(url('assets/duo/apple/scenes/iPhoneDuo_US_M_avif.lsd'));
    if (!response.ok) throw new Error('Model unavailable');
    const data = await response.json();
    data.renderer.background = [1, 1, 1, 1];
    scene = await api.instance().loadScene({ data, element: stage, SceneClass: DuoScene, assetsPath: url('assets/duo/apple/') });
    await new Promise(resolve => {
      if (scene.created) return resolve();
      const dispose = MobX.reaction(() => scene.created, ready => { if (ready) { dispose(); resolve(); } });
    });
    scene.pose('PT_Landscape');
    stage.addEventListener('webglcontextlost', () => { root.dataset.state = 'error'; say('3D 预览已暂停，请刷新页面重试。', '3D paused. Reload the page to try again.'); }, true);
  }

  buttons.forEach(button => button.addEventListener('click', () => {
    if (!scene || root.dataset.state !== 'ready') return;
    const label = button.dataset.pose;
    scene.pose(label);
    select(label);
    slider.value = label === 'PT_Closed' ? '0' : label === 'PT_Laptop' ? '.5' : label === 'PT_Tent' ? '.333' : '1';
    angle(Number(slider.value));
  }));
  slider.addEventListener('input', () => {
    if (!scene || root.dataset.state !== 'ready') return;
    scene.fold(Number(slider.value));
    select(null);
    angle(Number(slider.value));
  });
  start.addEventListener('click', load);
  // Keep the landing page light; a reduced-motion preference leaves an explicit opt-in.
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches && 'IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); load(); }
    }, { rootMargin: '120px' });
    observer.observe(root);
  }
})();
