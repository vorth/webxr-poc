import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { ARButton } from "three/addons/webxr/ARButton.js";
import { createSymmetryRenderer } from "./symmetry-renderer.js";
import { createText } from 'three/addons/webxr/Text2D.js';

export { THREE };

export async function setupRendering( appEl )
{
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8090a0);
  scene.fog = new THREE.Fog(0x0f1929, 22, 85);

  const camera = new THREE.PerspectiveCamera(56, window.innerWidth / window.innerHeight, 0.001, 7);
  camera.position.set( 0.4, 0.3, 0.4 );
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: true });
  await renderer.init();
  renderer.xr.enabled = true;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  appEl.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.enableDamping = true;

  const ambient = new THREE.AmbientLight(0xffffff, 0.45);
  const key = new THREE.DirectionalLight(0xffffff, 1.2);
  key.position.set( 0.3, 0.6, 0.5 ).normalize();
  scene.add(ambient, key);

  // const grid = new THREE.GridHelper(50, 50, 0xffffff, 0xffffff);
  // scene.add(grid);

  // Only enable AR if supported
  let symmetryRenderer;
  let instructionText = null;
  let needsInitialPlacement = false;
  async function setupAR() {
    if (navigator.xr && await navigator.xr.isSessionSupported?.('immersive-ar')) {
      document.body.appendChild(ARButton.createButton(renderer, {
        optionalFeatures: ['local-floor']
      }));

      instructionText = createText( 'Grip to move the model', 0.03 );
      scene.add( instructionText );
      instructionText.visible = false;

      // Toggle scene background/fog and orbit controls for AR passthrough
      const _origBackground = scene.background;
      const _origFog = scene.fog;
      renderer.xr.addEventListener('sessionstart', () => {
        scene.background = null;
        scene.fog = null;
        controls.enabled = false;
        instructionText.visible = true;
        needsInitialPlacement = true;
      });
      renderer.xr.addEventListener('sessionend', () => {
        scene.background = _origBackground;
        scene.fog = _origFog;
        controls.enabled = true;
        instructionText.visible = false;
        symmetryRenderer.setOrigin( new THREE.Vector3(0, 0, 0) );
      });
    }
  }
  setupAR();
  
  symmetryRenderer = createSymmetryRenderer( scene );
  
  for (let i = 0; i < 2; i++) {
    const controller = renderer.xr.getController( i );
    controller.addEventListener( 'squeezestart', () => {
      controller.attach( symmetryRenderer.originGroup );
    });
    controller.addEventListener( 'squeezeend', () => {
      scene.attach( symmetryRenderer.originGroup );
      if (instructionText) instructionText.visible = false;
    });
    scene.add( controller );
  }

  window.addEventListener("resize", onResize);
  
  const _forward = new THREE.Vector3();
  const _viewerPos = new THREE.Vector3();
  const _viewerQuat = new THREE.Quaternion();
  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
    if (needsInitialPlacement && renderer.xr.isPresenting) {
      const xrCamera = renderer.xr.getCamera();
      xrCamera.getWorldPosition(_viewerPos);
      xrCamera.getWorldQuaternion(_viewerQuat);
      _forward.set(0, 0, -1).applyQuaternion(_viewerQuat);
      symmetryRenderer.setOrigin(
        _viewerPos.clone()
          .addScaledVector(_forward, 0.7)
          .add(new THREE.Vector3(0, -0.2, 0))
      );
      if (instructionText) {
        instructionText.position.copy(_viewerPos).addScaledVector(_forward, 0.6);
        instructionText.quaternion.copy(_viewerQuat);
      }
      needsInitialPlacement = false;
    }
  });
  
  function onResize() {
    if (renderer.xr.isPresenting) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }

  return {
    scene,
    camera,
    renderer,
    controls,
    symmetryRenderer,
  };
}
