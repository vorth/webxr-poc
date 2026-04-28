import { THREE, setupRendering } from "./scene.js";


const app = document.getElementById("app");

const { symmetryRenderer } = await setupRendering(app);


export const RANDOM_INSTANCE_COUNT = 1000;

const messageEl = document.getElementById("message");
const hudDesc = document.querySelector("#hud p");
const groupSelectEl = document.getElementById("group-select");
const styleSelectEl = document.getElementById("style-select");
const regenerateButton = document.getElementById("regenerate");

const showMessage = (text) => {
  messageEl.textContent = text;
  messageEl.style.display = "block";
};

// if (!navigator.gpu) {
//   showMessage("WebGPU is not available in this browser. Use a recent Chromium-based browser with WebGPU enabled.");
//   throw new Error("WebGPU not supported");
// }

const scale = 0.03; // geometries here were not designed for AR scale, so we apply a global scale factor to make them fit better in AR viewing. This is optional and can be adjusted as needed.

// Register default color palette
symmetryRenderer.registerColor(new THREE.Vector3(0,0,1)); // blue
symmetryRenderer.registerColor(new THREE.Vector3(1,0,0)); // red
symmetryRenderer.registerColor(new THREE.Vector3(0.4,0,1));   // purple
symmetryRenderer.registerColor(new THREE.Vector3(1,1,0));   // yellow
symmetryRenderer.registerColor(new THREE.Vector3(0,1,0));   // green
  
symmetryRenderer.registerSymmetryGroup("tilted-bars", [
  new THREE.Euler(1.0, 1.0, 0),
  new THREE.Euler(1.0, 2.0, 1.0),
  new THREE.Euler(0, 1.0, 3.0)
]);
symmetryRenderer.registerStyle("tilted-bars", "rounded");
symmetryRenderer.registerShape("tilted-bars", "rounded", "thin", new THREE.CylinderGeometry(0.12 * scale, 0.12 * scale, 2.0 * scale, 28));
symmetryRenderer.registerShape("tilted-bars", "rounded", "wide", new THREE.CylinderGeometry(0.85 * scale, 0.85 * scale, 0.22 * scale, 28));
symmetryRenderer.registerStyle("tilted-bars", "default");
symmetryRenderer.registerShape("tilted-bars", "default", "thin", new THREE.BoxGeometry(0.22 * scale, 2.0 * scale, 0.22 * scale));
symmetryRenderer.registerShape("tilted-bars", "default", "wide", new THREE.BoxGeometry(1.9 * scale, 0.24 * scale, 0.85 * scale));

symmetryRenderer.registerSymmetryGroup("axis-aligned", [
  new THREE.Euler(0, 0, 0),
  new THREE.Euler(Math.PI * 0.5, 0, 0),
  new THREE.Euler(0, Math.PI * 0.5, 0)
]);
symmetryRenderer.registerStyle("axis-aligned", "beams");
symmetryRenderer.registerShape("axis-aligned", "beams", "column", new THREE.BoxGeometry(0.3 * scale, 2.2 * scale, 0.3 * scale));
symmetryRenderer.registerShape("axis-aligned", "beams", "slab", new THREE.BoxGeometry(2.1 * scale, 0.2 * scale, 0.75 * scale));
symmetryRenderer.registerStyle("axis-aligned", "planks");
symmetryRenderer.registerShape("axis-aligned", "planks", "column", new THREE.CylinderGeometry(0.15 * scale, 0.15 * scale, 2.2 * scale, 28));
symmetryRenderer.registerShape("axis-aligned", "planks", "slab", new THREE.BoxGeometry(2.5 * scale, 0.12 * scale, 1.0 * scale));

symmetryRenderer.switchSymmetryGroup("axis-aligned");
populateRandomInstances(RANDOM_INSTANCE_COUNT);
refreshUI();

if (groupSelectEl) {
  groupSelectEl.addEventListener("change", (event) => {
    const groupId = event.target.value;
    try {
      symmetryRenderer.switchSymmetryGroup(groupId);
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
      symmetryRenderer.switchStyle(styleId);
      refreshUI();
    } catch (error) {
      showMessage(error.message);
    }
  });
}

if (regenerateButton) {
  regenerateButton.addEventListener("click", () => {
    symmetryRenderer.clearActiveInstances();
    populateRandomInstances(RANDOM_INSTANCE_COUNT);
  });
}

function refreshUI() {
  if (groupSelectEl) {
    const previous = groupSelectEl.value;
    groupSelectEl.innerHTML = "";
    for (const groupId of symmetryRenderer.getGroupIds()) {
      const option = document.createElement("option");
      option.value = groupId;
      option.textContent = groupId;
      groupSelectEl.appendChild(option);
    }
    const activeGroupId = symmetryRenderer.getActiveGroupId();
    if (activeGroupId) {
      groupSelectEl.value = activeGroupId;
    } else if (previous) {
      groupSelectEl.value = previous;
    }
  }

  if (styleSelectEl) {
    styleSelectEl.innerHTML = "";
    const activeGroup = symmetryRenderer.getActiveGroupId() ? symmetryRenderer.getActiveGroup() : null;
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
    const activeGroup = symmetryRenderer.getActiveGroupId() ? symmetryRenderer.getActiveGroup() : null;
    if (activeGroup) {
      const styleText = activeGroup.activeStyleId ? `active style '${activeGroup.activeStyleId}'` : "no active style";
      hudDesc.textContent = `${activeGroup.id}: ${activeGroup.orientations.length} orientations, ${styleText}`;
    }
  }
}

function populateRandomInstances(count)
{
  const keys = symmetryRenderer.listShapeKeys(symmetryRenderer.getActiveGroup(), symmetryRenderer.getActiveGroup().activeStyleId);
  if (keys.length === 0) {
    return;
  }

  for (let i = 0; i < count; i += 1) {
    const selection = keys[Math.floor(Math.random() * keys.length)];
    symmetryRenderer.addInstance(selection.styleId, selection.shapeId, {
      position: randomPosition(),
      highlight: Math.random() < 0.05 ? 0.35 : 0
    });
  }
}
function randomPosition() {
  return new THREE.Vector3(
    THREE.MathUtils.randFloatSpread(1),
    THREE.MathUtils.randFloatSpread(0.3),
    THREE.MathUtils.randFloatSpread(1)
  );
}
