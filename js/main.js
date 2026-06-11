import { THREE, setupRendering } from "./scene.js";
import { createWorker } from "./worker.js";


const app = document.getElementById("app");


const { symmetryRenderer, scene, renderer, camera, } = await setupRendering( app );

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

const MENU_ITEMS = [
  { label: 'Trussed Icosidodec', id: 'btn-a', url: 'https://raw.githubusercontent.com/vorth/vzome-sharing/main/2026/06/11/15-19-55-trussed-McCay-dome-4/trussed-McCay-dome-4.vZome' },
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

renderer.xr.addEventListener( 'sessionstart', () => { modelMenu.style.display = 'none'; } );
renderer.xr.addEventListener( 'sessionend', () => { modelMenu.style.display = ''; } );

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

renderer.domElement.addEventListener( 'pointerdown', async ( e ) => {
  const hit = await symmetryRenderer.pickAt( e.clientX, e.clientY, renderer, camera );
  symmetryRenderer.clearHighlights();
  if ( hit ) {
    symmetryRenderer.setInstanceHighlight( hit.shapeId, hit.instanceId, 1 );
  }
} );
