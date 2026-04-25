import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export { THREE };

export async function initScene(appEl)
{
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f1929);
  scene.fog = new THREE.Fog(0x0f1929, 22, 85);

  const camera = new THREE.PerspectiveCamera(56, window.innerWidth / window.innerHeight, 0.1, 250);
  camera.position.set(16, 14, 16);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGPURenderer({ antialias: true });
  await renderer.init();
  renderer.xr.enabled = true;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  appEl.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.enableDamping = true;

  const ambient = new THREE.AmbientLight(0x8aa9d6, 0.45);
  const key = new THREE.DirectionalLight(0xf7f2e7, 1.2);
  key.position.set(12, 18, 10);
  scene.add(ambient, key);

  const grid = new THREE.GridHelper(50, 50, 0xffffff, 0xffffff);
  scene.add(grid);

  return {
    scene,
    camera,
    renderer,
    controls
  };
}
