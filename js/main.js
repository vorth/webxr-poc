import { THREE, setupRendering } from "./scene.js";
import { createWorker } from "./worker.js";
import { HTMLMesh } from 'three/addons/interactive/HTMLMesh.js';
import { InteractiveGroup } from 'three/addons/interactive/InteractiveGroup.js';


const app = document.getElementById("app");


const { symmetryRenderer, scene, renderer, camera, addFrameCallback } = await setupRendering( app );

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
// symmetryRenderer.registerColor(new THREE.Vector3(0,0,1)); // blue
symmetryRenderer.registerColor(new THREE.Vector3(1,0,0)); // red
symmetryRenderer.registerColor(new THREE.Vector3(0.4,0,1));   // purple
// symmetryRenderer.registerColor(new THREE.Vector3(1,1,0));   // yellow
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

const RANDOM_INSTANCE_COUNT = 400;
populateRandomInstances(RANDOM_INSTANCE_COUNT);

refreshUI();

if (groupSelectEl) {
  groupSelectEl.addEventListener("change", (event) => {
    const groupId = event.target.value;
    try {
      symmetryRenderer.clearActiveInstances();
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
    THREE.MathUtils.randFloatSpread(0.5),
    THREE.MathUtils.randFloatSpread(0.3),
    THREE.MathUtils.randFloatSpread(0.5)
  );
}

// --- In-scene HTML panel with 3 buttons ---
const BTN_NORMAL = '#4a90d9';
const BTN_HOVER  = '#74b3ff';
const panel = document.createElement( 'div' );
panel.style.cssText = 'width:220px;background:#1a1a2e;padding:14px;border-radius:10px;font-family:sans-serif;';
[
  { label: 'Action A', id: 'btn-a' },
  { label: 'Action B', id: 'btn-b' },
  { label: 'Action C', id: 'btn-c' },
].forEach( ( { label, id } ) => {
  const btn = document.createElement( 'button' );
  btn.id = id;
  btn.textContent = label;
  btn.style.cssText = `display:block;width:100%;margin:5px 0;padding:8px 0;font-size:16px;cursor:pointer;border:none;border-radius:6px;background:${BTN_NORMAL};color:#fff;`;
  btn.addEventListener( 'click', () => console.log( `${label} clicked` ) );
  panel.appendChild( btn );
} );
document.body.appendChild( panel );
panel.style.position = 'absolute';
panel.style.top = '-9999px'; // keep off-screen but in DOM so HTMLMesh can render it

// Mirrors htmlevent()'s own coordinate math: UV → viewport-absolute → which button?
function getButtonAtUV( uv ) {
  const panelRect = panel.getBoundingClientRect();
  const x = uv.x * panelRect.width  + panelRect.left;
  const y = ( 1 - uv.y ) * panelRect.height + panelRect.top;
  for ( const btn of panel.querySelectorAll( 'button' ) ) {
    const r = btn.getBoundingClientRect();
    if ( x > r.left && x < r.right && y > r.top && y < r.bottom ) return btn;
  }
  return null;
}

const interactiveGroup = new InteractiveGroup();
interactiveGroup.listenToXRControllerEvents( renderer.xr.getController( 0 ) );
interactiveGroup.listenToXRControllerEvents( renderer.xr.getController( 1 ) );
// interactiveGroup is added/removed on AR session start/end, not immediately

const htmlMesh = new HTMLMesh( panel );
htmlMesh.position.set( 0, 0.1, -0.9 );
htmlMesh.scale.setScalar( 2 );
interactiveGroup.add( htmlMesh );

let _hoveredButton = null;
renderer.xr.addEventListener( 'sessionstart', () => scene.add( interactiveGroup ) );
renderer.xr.addEventListener( 'sessionend', () => {
  interactiveGroup.removeFromParent();
  if ( _hoveredButton ) { _hoveredButton.style.background = BTN_NORMAL; _hoveredButton = null; }
} );

// Controller ray lines + hit dots + button hover
const _raycaster = new THREE.Raycaster();
const _controllers = [ renderer.xr.getController( 0 ), renderer.xr.getController( 1 ) ];
const _rayGeo = new THREE.BufferGeometry().setFromPoints( [ new THREE.Vector3( 0, 0, 0 ), new THREE.Vector3( 0, 0, -1 ) ] );
const _rayMat = new THREE.LineBasicMaterial( { color: 0xffffff, transparent: true, opacity: 0.6 } );
const _dotGeo = new THREE.SphereGeometry( 0.006, 8, 6 );
const _dotMat = new THREE.MeshBasicMaterial( { color: 0xffffff } );
const DEFAULT_RAY_LENGTH = 2.0;
for ( const controller of _controllers ) {
  const ray = new THREE.Line( _rayGeo, _rayMat );
  ray.name = 'ray';
  ray.scale.z = DEFAULT_RAY_LENGTH;
  ray.visible = false;
  controller.add( ray );
  const dot = new THREE.Mesh( _dotGeo, _dotMat );
  dot.name = 'dot';
  dot.visible = false;
  controller.add( dot );
}
addFrameCallback( () => {
  const presenting = renderer.xr.isPresenting;
  let hitUV = null;
  for ( const controller of _controllers ) {
    const ray = controller.getObjectByName( 'ray' );
    const dot = controller.getObjectByName( 'dot' );
    if ( !ray || !dot ) continue;
    if ( !presenting ) { ray.visible = false; dot.visible = false; continue; }
    controller.updateMatrixWorld();
    _raycaster.setFromXRController( controller );
    const hits = _raycaster.intersectObjects( interactiveGroup.children, true );
    if ( hits.length > 0 ) {
      const dist = hits[ 0 ].distance;
      ray.scale.z = dist;
      ray.visible = true;
      dot.position.set( 0, 0, -dist );
      dot.visible = true;
      if ( hitUV === null && hits[ 0 ].uv ) hitUV = hits[ 0 ].uv;
    } else {
      ray.visible = false;
      dot.visible = false;
    }
  }
  // Update button hover based on which button (if any) the first hitting controller points at
  const newHovered = hitUV ? getButtonAtUV( hitUV ) : null;
  if ( newHovered !== _hoveredButton ) {
    if ( _hoveredButton ) _hoveredButton.style.background = BTN_NORMAL;
    if ( newHovered ) newHovered.style.background = BTN_HOVER;
    _hoveredButton = newHovered;
  }
} );
// --- end in-scene panel ---

const { subscribeFor, postMessage } = createWorker();

const message = {
  type: "URL_PROVIDED",
  payload: {
    url: "https://raw.githubusercontent.com/vorth/vzome-sharing/main/2026/01/20/04-44-10-077Z-JK-CRF-tet-first/JK-CRF-tet-first.vZome",
    config: {
      preview: true,
      showScenes: "none",
      camera: true,
      lighting: true,
      design: true,
      labels: false,
      showSettings: true,
      download: true,
      useSpinner: false,
      url: "https://raw.githubusercontent.com/vorth/vzome-sharing/main/2026/01/20/04-44-10-077Z-JK-CRF-tet-first/JK-CRF-tet-first.vZome",
      load: {
        camera: true,
        lighting: true,
        design: true,
      },
      snapshot: -1,
    },
  },
};

subscribeFor( 'SCENE_RENDERED', ( payload ) => {
  console.log( 'SCENE_RENDERED payload:', payload );
  const shapes = payload?.scene?.shapes;
  if ( !shapes ) return;
  const GROUP_ID = "vzome-icosahedral";
  const STYLE_ID = "vzome-mesh";

  const scale = 0.008; // geometries here were not designed for AR scale, so we apply a global scale factor to make them fit better in AR viewing. This is optional and can be adjusted as needed.

  // Collect all unique orientations and colors across every instance
  const orientations = Array.from( { length: 60 }, () => new THREE.Matrix4() ); // ordered list of Matrix4 for registerSymmetryGroup
  const colorIndexMap = new Map();        // hex string → colorIndex
  for ( const shape of Object.values( shapes ) ) {
    for ( const instance of shape.instances ) {
      let orientation = instance.orientation;
      if ( orientation < 0 )
        orientation = 0; // vZome uses -1 for "no rotation", but our shader expects a valid index, so we treat it as the identity orientation at index 0
      orientations[ orientation ] = new THREE.Matrix4().fromArray( instance.rotation ) .transpose();
      if ( !colorIndexMap.has( instance.color ) ) {
        const c = new THREE.Color( instance.color );
        const idx = symmetryRenderer.registerColor( new THREE.Vector3( c.r, c.g, c.b ) );
        colorIndexMap.set( instance.color, idx );
      }
    }
  }

  // Register the new symmetry group and style
  symmetryRenderer.registerSymmetryGroup( GROUP_ID, orientations );
  symmetryRenderer.registerStyle( GROUP_ID, STYLE_ID );

  // Build and register a THREE.BufferGeometry for each shape
  for ( const shape of Object.values( shapes ) ) {
    const positions = [];
    for ( const v of shape.vertices ) {
      positions.push( v.x * scale, v.y * scale, v.z * scale );
    }
    const indices = [];
    for ( const face of shape.faces ) {
      const verts = face.vertices;
      // Fan-triangulate each polygon from its first vertex
      for ( let i = 1; i < verts.length - 1; i++ ) {
        indices.push( verts[0], verts[i], verts[i + 1] );
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute( 'position', new THREE.BufferAttribute( new Float32Array( positions ), 3 ) );
    geometry.setIndex( indices );
    geometry.computeVertexNormals();
    symmetryRenderer.registerShape( GROUP_ID, STYLE_ID, shape.id, geometry );
  }

  // Switch to the new group (builds GPU resources over the registered shapes)
  symmetryRenderer.switchSymmetryGroup( GROUP_ID );

  // Add each instance to its shape
  for ( const shape of Object.values( shapes ) ) {
    for ( const instance of shape.instances ) {
      const [ px, py, pz ] = instance.position;
      let orientation = instance.orientation;
      if ( orientation < 0 )
        orientation = 0; // vZome uses -1 for "no rotation", but our shader expects a valid index, so we treat it as the identity orientation at index 0
      symmetryRenderer.addInstance( STYLE_ID, shape.id, {
        position: new THREE.Vector3( px * scale, py * scale, pz * scale ),
        orientationIndex: orientation,
        colorIndex: colorIndexMap.get( instance.color ),
      } );
    }
  }
  refreshUI();
} );

postMessage( message );
