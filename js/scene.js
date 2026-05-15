import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { XRButton } from "three/addons/webxr/XRButton.js";
import { createText } from 'three/addons/webxr/Text2D.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';
import { OculusHandModel } from 'three/addons/webxr/OculusHandModel.js';
import { OculusHandPointerModel } from 'three/addons/webxr/OculusHandPointerModel.js';

import { createSymmetryRenderer } from "./symmetry-renderer.js";

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

  // Offer AR with VR fallback
  let symmetryRenderer;
  let instructionText = null;
  let rightInstructionText = null;
  let needsInitialPlacement = false;
  async function setupXR() {
    // only show the button if at least VR is supported. 
    if (navigator.xr && await navigator.xr.isSessionSupported?.('immersive-vr')) {
      document.body.appendChild(XRButton.createButton(renderer, {
        optionalFeatures: [ 'local-floor', 'hand-tracking', ],
      }));

      instructionText = createText( 'Grip to move the model', 0.03 );
      scene.add( instructionText );
      instructionText.visible = false;

      rightInstructionText = createText( 'Grip to move the model', 0.03 );
      scene.add( rightInstructionText );
      rightInstructionText.visible = false;

      const _origBackground = scene.background;
      const _origFog = scene.fog;
      const _origFov = camera.fov;
      const _origCameraPos = camera.position.clone();
      const _origControlsTarget = controls.target.clone();
      renderer.xr.addEventListener('sessionstart', () => {
        const isAR = renderer.xr.getSession()?.environmentBlendMode !== 'opaque';
        if (isAR) {
          scene.background = null;
          scene.fog = null;
        }
        controls.enabled = false;
        instructionText.visible = true;
        rightInstructionText.visible = true;
        needsInitialPlacement = true;
      });
      renderer.xr.addEventListener('sessionend', () => {
        scene.background = _origBackground;
        scene.fog = _origFog;
        camera.fov = _origFov;
        camera.position.copy( _origCameraPos );
        controls.target.copy( _origControlsTarget );
        controls.enabled = true;
        instructionText.visible = false;
        rightInstructionText.visible = false;
        symmetryRenderer.setOrigin( new THREE.Vector3(0, 0, 0) );
        onResize();
      });
    }
  }
  setupXR();
  
  symmetryRenderer = createSymmetryRenderer( scene );
  
  const controllerModelFactory = new XRControllerModelFactory();
  const handModelFactory = new XRHandModelFactory();
  for (let i = 0; i < 2; i++) {
    const controller = renderer.xr.getController( i );
    controller.addEventListener( 'connected', (event) => {
      if (event.data.handedness === 'left' && instructionText) {
        controller.add( instructionText );
        instructionText.position.set( 0, 0.1, 0 );
        instructionText.rotation.set( -Math.PI / 6, Math.PI / 6, 0 );
      }
      if (event.data.handedness === 'right' && rightInstructionText) {
        controller.add( rightInstructionText );
        rightInstructionText.position.set( 0, 0.1, 0 );
        rightInstructionText.rotation.set( -Math.PI / 6, -Math.PI / 6, 0 );
      }
    });
    controller.addEventListener( 'squeezestart', () => {
      controller.attach( symmetryRenderer.originGroup );
    });
    controller.addEventListener( 'squeezeend', () => {
      scene.attach( symmetryRenderer.originGroup );
      if (instructionText) instructionText.visible = false;
      if (rightInstructionText) rightInstructionText.visible = false;
    });
    scene.add( controller );

    const controllerGrip = renderer.xr.getControllerGrip( i );
    controllerGrip.add( controllerModelFactory.createControllerModel( controllerGrip ) );
    scene.add( controllerGrip );

    const hand = renderer.xr.getHand( i );
    hand.add(handModelFactory.createHandModel(hand, 'mesh'));
    // const handPointer = new OculusHandPointerModel( hand, controller );
    // hand.add( handPointer );
    scene.add( hand );
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
