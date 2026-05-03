import { THREE, setupRendering } from "./scene.js";
import { createWorker } from "./worker.js";
import { HTMLMesh } from 'three/addons/interactive/HTMLMesh.js';
import { InteractiveGroup } from 'three/addons/interactive/InteractiveGroup.js';


const app = document.getElementById("app");


const { symmetryRenderer, scene, renderer, camera, addFrameCallback } = await setupRendering( app );

const messageEl = document.getElementById("message");
const hudDesc = document.querySelector("#hud p");

const showMessage = (text) => {
  messageEl.textContent = text;
  messageEl.style.display = "block";
};

// if (!navigator.gpu) {
//   showMessage("WebGPU is not available in this browser. Use a recent Chromium-based browser with WebGPU enabled.");
//   throw new Error("WebGPU not supported");
// }

const config = {
  preview: true,
  showScenes: "none",
  camera: true,
  lighting: true,
  design: true,
  labels: false,
  showSettings: true,
  download: true,
  useSpinner: false,
  load: {
    camera: true,
    lighting: true,
    design: true,
  },
  snapshot: -1,
};

let loadingUrl = null;

const loadModel = ( url ) => {
  // showMessage( "Loading model..." );
  // if url is in symmetryRenderer.getGroupIds, just switch to it instead of re-loading and re-processing the same model again
  if ( symmetryRenderer.getGroupIds().includes( url ) ) {
    symmetryRenderer.switchSymmetryGroup( url );
    return;
  }
  loadingUrl = url;
  postMessage( {
    type: "URL_PROVIDED",
    payload: { url, config}
  } );
};

// --- In-scene HTML panel with 4 buttons ---
const BTN_NORMAL = '#4a90d9';
const BTN_HOVER  = '#74b3ff';
const MENU_ITEMS = [
  { label: 'Laves Unit Cell', id: 'btn-a', url: 'https://raw.githubusercontent.com/vorth/vzome-sharing/main/2025/08/20/18-28-08-laves-unit-cell/laves-unit-cell.vZome' },
  { label: 'JK 4D CRF', id: 'btn-c', url: 'https://raw.githubusercontent.com/vorth/vzome-sharing/main/2026/01/08/04-16-34-229Z-Potentially-new-polytope/Potentially-new-polytope.vZome' },
  { label: 'C960', id: 'btn-b', url: 'https://gist.githubusercontent.com/vorth/2d880fe088bf3bf16a866d48e5057d43/raw/61eeec45fa2d7424c2e2fd3355fc12530256c7a6/C960-round.vZome' },
  { label: 'Ghee Beom Kim snub', id: 'btn-d', url: 'https://raw.githubusercontent.com/vorth/vzome-sharing/main/2025/12/31/02-49-18-356Z-Ghee-Beom-Kim-snub-design/Ghee-Beom-Kim-snub-design.vZome' },
];

// 2D on-screen menu (hidden during XR sessions)
const modelMenu = document.getElementById( 'model-menu' );
MENU_ITEMS.forEach( ( { label, url } ) => {
  const btn = document.createElement( 'button' );
  btn.textContent = label;
  btn.addEventListener( 'click', () => loadModel( url ) );
  modelMenu.appendChild( btn );
} );

const panel = document.createElement( 'div' );
panel.style.cssText = 'width:220px;background:#1a1a2e;padding:14px;border-radius:10px;font-family:sans-serif;';
MENU_ITEMS.forEach( ( { label, id, url } ) => {
  const btn = document.createElement( 'button' );
  btn.id = id;
  btn.textContent = label;
  btn.style.cssText = `display:block;width:100%;margin:5px 0;padding:8px 0;font-size:16px;cursor:pointer;border:none;border-radius:6px;background:${BTN_NORMAL};color:#fff;`;
  btn.addEventListener( 'click', () => loadModel( url ) );
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
htmlMesh.scale.setScalar( 2 );
interactiveGroup.add( htmlMesh );

const _panelAngle = 35 * Math.PI / 180;
const _panelDist = 1.3;
let _hoveredButton = null;
let _needsPanelPlacement = false;
renderer.xr.addEventListener( 'sessionstart', () => { _needsPanelPlacement = true; scene.add( interactiveGroup ); modelMenu.style.display = 'none'; } );
renderer.xr.addEventListener( 'sessionend', () => {
  interactiveGroup.removeFromParent();
  if ( _hoveredButton ) { _hoveredButton.style.background = BTN_NORMAL; _hoveredButton = null; }
  modelMenu.style.display = '';
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
  if ( _needsPanelPlacement && renderer.xr.isPresenting ) {
    const xrCamera = renderer.xr.getCamera();
    const _vPos = new THREE.Vector3();
    const _vQuat = new THREE.Quaternion();
    xrCamera.getWorldPosition( _vPos );
    xrCamera.getWorldQuaternion( _vQuat );
    // Viewer's forward direction projected onto horizontal plane, then rotated 25° right
    const _dir = new THREE.Vector3( 0, 0, -1 ).applyQuaternion( _vQuat );
    _dir.y = 0;
    _dir.normalize();
    _dir.applyAxisAngle( new THREE.Vector3( 0, 1, 0 ), -_panelAngle );
    interactiveGroup.position.copy( _vPos ).addScaledVector( _dir, _panelDist );
    // Face horizontally toward the viewer
    const _lookAt = new THREE.Vector3( _vPos.x, interactiveGroup.position.y, _vPos.z );
    interactiveGroup.lookAt( _lookAt );
    _needsPanelPlacement = false;
  }
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

subscribeFor( 'SCENE_RENDERED', ( payload ) => {
  console.log( 'SCENE_RENDERED payload:', payload );
  const shapes = payload?.scene?.shapes;
  if ( !shapes ) return;
  const GROUP_ID = loadingUrl;
  const STYLE_ID = "preview-shapes";

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
} );

loadModel( 'https://raw.githubusercontent.com/vorth/vzome-sharing/main/2025/12/31/02-49-18-356Z-Ghee-Beom-Kim-snub-design/Ghee-Beom-Kim-snub-design.vZome' );
