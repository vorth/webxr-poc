import { THREE, initScene } from "./scene.js";
import { createSymmetryRuntime } from "./symmetry-runtime.js";
import { ARButton } from "three/addons/webxr/ARButton.js";

export const RANDOM_INSTANCE_COUNT = 10000;

const app = document.getElementById("app");
const messageEl = document.getElementById("message");
const hudDesc = document.querySelector("#hud p");
const groupSelectEl = document.getElementById("group-select");
const styleSelectEl = document.getElementById("style-select");
const regenerateButton = document.getElementById("regenerate");

const showMessage = (text) => {
  messageEl.textContent = text;
  messageEl.style.display = "block";
};

if (!navigator.gpu) {
  showMessage("WebGPU is not available in this browser. Use a recent Chromium-based browser with WebGPU enabled.");
  throw new Error("WebGPU not supported");
}

const { scene, camera, renderer, controls } = await initScene(app);


// Only enable AR if supported
async function setupAR() {
  if (navigator.xr && await navigator.xr.isSessionSupported?.('immersive-ar')) {
    document.body.appendChild(ARButton.createButton(renderer, {
      optionalFeatures: ['local-floor']
    }));
    // Toggle scene background/fog and orbit controls for AR passthrough
    const _origBackground = scene.background;
    const _origFog = scene.fog;
    renderer.xr.addEventListener('sessionstart', () => {
      scene.background = null;
      scene.fog = null;
      controls.enabled = false;
    });
    renderer.xr.addEventListener('sessionend', () => {
      scene.background = _origBackground;
      scene.fog = _origFog;
      controls.enabled = true;
    });
  }
}
setupAR();

const runtime = createSymmetryRuntime( scene );

runtime.registerSymmetryGroup("tilted-bars", [
  new THREE.Euler(1.0, 1.0, 0),
  new THREE.Euler(1.0, 2.0, 1.0),
  new THREE.Euler(0, 1.0, 3.0)
]);
runtime.registerStyle("tilted-bars", "rounded");
runtime.registerShape("tilted-bars", "rounded", "thin", new THREE.CylinderGeometry(0.12, 0.12, 2.0, 8));
runtime.registerShape("tilted-bars", "rounded", "wide", new THREE.CylinderGeometry(0.85, 0.85, 0.22, 10));
runtime.registerStyle("tilted-bars", "default");
runtime.registerShape("tilted-bars", "default", "thin", new THREE.BoxGeometry(0.22, 2.0, 0.22));
runtime.registerShape("tilted-bars", "default", "wide", new THREE.BoxGeometry(1.9, 0.24, 0.85));

runtime.registerSymmetryGroup("axis-aligned", [
  new THREE.Euler(0, 0, 0),
  new THREE.Euler(Math.PI * 0.5, 0, 0),
  new THREE.Euler(0, Math.PI * 0.5, 0)
]);
runtime.registerStyle("axis-aligned", "beams");
runtime.registerShape("axis-aligned", "beams", "column", new THREE.BoxGeometry(0.3, 2.2, 0.3));
runtime.registerShape("axis-aligned", "beams", "slab", new THREE.BoxGeometry(2.1, 0.2, 0.75));
runtime.registerStyle("axis-aligned", "planks");
runtime.registerShape("axis-aligned", "planks", "column", new THREE.CylinderGeometry(0.15, 0.15, 2.2, 8));
runtime.registerShape("axis-aligned", "planks", "slab", new THREE.BoxGeometry(2.5, 0.12, 1.0));

runtime.switchSymmetryGroup("tilted-bars");
populateRandomInstances(RANDOM_INSTANCE_COUNT);
refreshUI();

if (groupSelectEl) {
  groupSelectEl.addEventListener("change", (event) => {
    const groupId = event.target.value;
    try {
      runtime.switchSymmetryGroup(groupId);
      populateRandomInstances(RANDOM_INSTANCE_COUNT);
      refreshUI();
    } catch (error) {
      showMessage(error.message);
    }
  });
}

if (styleSelectEl) {
  styleSelectEl.addEventListener("change", (event) => {
    const styleId = event.target.value;
    try {
      runtime.switchStyle(styleId);
      refreshUI();
    } catch (error) {
      showMessage(error.message);
    }
  });
}

if (regenerateButton) {
  regenerateButton.addEventListener("click", () => {
    runtime.clearActiveInstances();
    populateRandomInstances(RANDOM_INSTANCE_COUNT);
  });
}

window.symmetryRuntime = {
  registerSymmetryGroup: runtime.registerSymmetryGroup,
  registerStyle: runtime.registerStyle,
  registerShape: runtime.registerShape,
  registerColor: runtime.registerColor,
  switchSymmetryGroup: runtime.switchSymmetryGroup,
  switchStyle: runtime.switchStyle,
  setDiscardInactiveShaders: runtime.setDiscardInactiveShaders,
  addInstance: runtime.addInstance,
  removeInstance: runtime.removeInstance,
  removeAllInstances: runtime.removeAllInstances
};

window.addEventListener("resize", onResize);

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

function onResize() {
  if (renderer.xr.isPresenting) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}


function refreshUI() {
  if (groupSelectEl) {
    const previous = groupSelectEl.value;
    groupSelectEl.innerHTML = "";
    for (const groupId of runtime.getGroupIds()) {
      const option = document.createElement("option");
      option.value = groupId;
      option.textContent = groupId;
      groupSelectEl.appendChild(option);
    }
    const activeGroupId = runtime.getActiveGroupId();
    if (activeGroupId) {
      groupSelectEl.value = activeGroupId;
    } else if (previous) {
      groupSelectEl.value = previous;
    }
  }

  if (styleSelectEl) {
    styleSelectEl.innerHTML = "";
    const activeGroup = runtime.getActiveGroupId() ? runtime.getActiveGroup() : null;
    if (!activeGroup) {
      styleSelectEl.disabled = true;
    } else {
      for (const styleId of activeGroup.styles.keys()) {
        const option = document.createElement("option");
        option.value = styleId;
        option.textContent = styleId;
        styleSelectEl.appendChild(option);
      }
      styleSelectEl.disabled = activeGroup.styles.size === 0;
      if (activeGroup.activeStyleId && activeGroup.styles.has(activeGroup.activeStyleId)) {
        styleSelectEl.value = activeGroup.activeStyleId;
      }
    }
  }

  if (hudDesc) {
    const activeGroup = runtime.getActiveGroupId() ? runtime.getActiveGroup() : null;
    if (activeGroup) {
      const styleText = activeGroup.activeStyleId ? `active style '${activeGroup.activeStyleId}'` : "no active style";
      hudDesc.textContent = `${activeGroup.id}: ${activeGroup.orientations.length} orientations, ${styleText}`;
    }
  }
}

function populateRandomInstances(count)
{
  const keys = runtime.listShapeKeys(runtime.getActiveGroup(), runtime.getActiveGroup().activeStyleId);
  if (keys.length === 0) {
    return;
  }

  for (let i = 0; i < count; i += 1) {
    const selection = keys[Math.floor(Math.random() * keys.length)];
    runtime.addInstance(selection.styleId, selection.shapeId, {
      position: randomPosition(),
      highlight: Math.random() < 0.05 ? 1.2 : 0
    });
  }
}
function randomPosition() {
  return new THREE.Vector3(
    THREE.MathUtils.randFloatSpread(36),
    THREE.MathUtils.randFloatSpread(10),
    THREE.MathUtils.randFloatSpread(36)
  );
}
