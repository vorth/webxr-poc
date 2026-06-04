# Plan: SharedArrayBuffer Instance Protocol

## TL;DR
Replace the monolithic `SCENE_RENDERED` message with a SAB-based instance pool and lightweight incremental messages. The vzome remote Worker thread (separate from main thread) writes directly to a SharedArrayBuffer; the main thread reads it on each frame triggered by `postMessage` pings. worker.js (a main-thread trampoline) stays mostly unchanged.

---

## Context

- `worker.js` is a **main-thread module** that creates and wraps a `Worker` (the real vzome thread) via a CORS Blob trick. All `subscribeFor` callbacks run on the main thread.
- The vzome Worker **thread** is the right place to write to a SAB (it's on a separate thread).
- The current SCENE_RENDERED handler in main.js (lines 69–123) does all scene construction on the main thread in one shot.
- vzome engine already emits: `SHAPE_DEFINED`, `INSTANCE_ADDED`, `INSTANCE_REMOVED`, `SYMMETRY_CHANGED`, `SELECTION_TOGGLED`

---

## SAB Layout

### Header (32 bytes = Int32Array[8] at byte 0)
| Index | Field | Description |
|-------|-------|-------------|
| 0 | `version` | Incremented atomically after each write batch |
| 1 | `capacity` | Total instance slots |
| 2 | `activeCount` | Number of currently active slots |
| 3–7 | reserved | |

### Instance Pool (Float32Array starting at byte 32, stride = 8 floats = 32 bytes/slot)
| Float index | Field | Notes |
|-------------|-------|-------|
| 0 | posX | |
| 1 | posY | |
| 2 | posZ | |
| 3 | orientationIndex | Int encoded as float |
| 4 | colorIndex | Int encoded as float |
| 5 | highlightIntensity | 0.0 or 1.0 (or any float) |
| 6 | shapeIndex | Int encoded as float |
| 7 | flags | Bit 0 = active (1) or tombstone (0) |

Total size for N slots: 32 + N × 32 bytes  
(e.g., N=65536 → ~2 MB)

Constants (shared between vzome worker and main.js):
```
HEADER_BYTES = 32
SLOT_FLOATS = 8
SLOT_BYTES = 32
INITIAL_CAPACITY = 4096  // doubled on grow
```

---

## New Message Protocol

### Main thread → vzome worker (via worker.js passthrough)
| Type | Payload | When |
|------|---------|------|
| `SAB_INIT` | `{ sab, capacity }` | Once at startup (before any model loads) |
| `SELECTION_CHANGED` | `{ instanceId: string \| null }` | After GPU pick; drives highlight round-trip |

### vzome worker → main thread (replaces SCENE_RENDERED)
| Type | Payload | When |
|------|---------|------|
| `SAB_GROW` | `{ sab, capacity }` | Worker reallocated due to overflow |
| `SHAPE_DEFINED` | `{ shapeIndex, shapeId, vertices: Float32Array, faces: Uint32Array }` | On vzome `SHAPE_DEFINED` |
| `ORIENTATIONS_DEFINED` | `{ orientations: number[] }` (960 floats, 60×16 col-major) | On vzome `SYMMETRY_CHANGED` or initial load |
| `COLOR_DEFINED` | `{ colorIndex, r, g, b }` | When worker sees a new color |
| `SAB_DIRTY` | `{ slots?: number[] }` | After SAB write(s); null = full scan |
| `SCENE_CLEARED` | `{}` | Model unloaded / new URL begins |

---

## Phase 1: SAB Constants Module (new file)

Create `js/sab-constants.js` (importable by both main.js and the vzome worker module):
- `HEADER_BYTES`, `SLOT_FLOATS`, `SLOT_BYTES`, `INITIAL_CAPACITY`
- Slot field offsets: `POS_X=0`, `POS_Y=1`, `POS_Z=2`, `ORI_IDX=3`, `COL_IDX=4`, `HIGHLIGHT=5`, `SHAPE_IDX=6`, `FLAGS=7`
- Header offsets: `HDR_VERSION=0`, `HDR_CAPACITY=1`, `HDR_ACTIVE_COUNT=2`

## Phase 2: vzome Worker Changes (heavy)

The vzome worker (which runs the vZome engine) needs to:

1. **Accept `SAB_INIT { sab, capacity }`**: store typed array views, initialize `freeSlots` (all indices 0..capacity-1), reset maps.

2. **Maintain local state** (never in SAB):
   - `freeSlots: number[]` — stack of available slot indices
   - `instanceToSlot: Map<string, number>` — vzome instanceId → SAB slot
   - `colorMap: Map<string, number>` — hex string → colorIndex (assigned in order)
   - `shapeIdToIndex: Map<string, number>` — shapeId → shapeIndex
   - `colorList: {r,g,b}[]` — in-order

3. **Handle vzome `SHAPE_DEFINED`**: assign `shapeIndex`, post `SHAPE_DEFINED` to main thread (geometry message-passed, transferable TypedArrays if possible).

4. **Handle vzome `INSTANCE_ADDED`**:
   - Register color if new → post `COLOR_DEFINED`
   - Pop a free slot; if empty, grow SAB (double capacity), copy data, post `SAB_GROW`
   - Write 8 floats to slot
   - `Atomics.add(header, HDR_ACTIVE_COUNT, 1)`
   - `Atomics.add(header, HDR_VERSION, 1)` — acts as sequentially-consistent store fence
   - Post `SAB_DIRTY { slots: [slotIndex] }`

5. **Handle vzome `INSTANCE_REMOVED`**:
   - Look up slot; write `flags = 0` to slot
   - `Atomics.add(header, HDR_ACTIVE_COUNT, -1)`, bump version
   - Push slot back to `freeSlots`
   - Post `SAB_DIRTY { slots: [slotIndex] }`

6. **Handle vzome `SELECTION_TOGGLED`**: write `highlightIntensity` to slot, bump version, post `SAB_DIRTY`.

7. **Handle main thread `SELECTION_CHANGED`**: same as SELECTION_TOGGLED but from UI picking.

8. **Handle vzome `SYMMETRY_CHANGED`**: post `ORIENTATIONS_DEFINED`.

9. **On new URL load**: post `SCENE_CLEARED`, reset all state, clear SAB (zero all active flags), post `SAB_DIRTY`.

10. **Remove `SCENE_RENDERED`** sending.

**Note:** Need to verify whether instance `position` values from vzome are in vZome units needing × 0.008 scale (same as geometry vertices), or already in world units. Check current main.js SCENE_RENDERED handler and addInstance call.

## Phase 3: worker.js Changes (minimal)

The CORS trampoline only needs minor changes:
- `postMessage` forwarding already handles `SAB_INIT` and `SELECTION_CHANGED` (SAB is shared by reference, not transferred).
- Add `SAB_GROW`, `SHAPE_DEFINED`, `ORIENTATIONS_DEFINED`, `COLOR_DEFINED`, `SAB_DIRTY`, `SCENE_CLEARED` to the relay (they're auto-relayed since all messages are fanned out).
- `SCENE_RENDERED` no longer sent by vzome worker → nothing to suppress (old subscribers just stop firing).

## Phase 4: main.js Changes

Remove:
- The entire `subscribeFor('SCENE_RENDERED', ...)` handler (lines 69–123)
- `GROUP_ID` / `STYLE_ID` constants and the loadingUrl pattern
- `symmetryRenderer.getGroupIds()` guard in `loadModel`

Add:
1. **Allocate SAB on init** (before `loadModel`):
   ```js
   const sab = new SharedArrayBuffer(HEADER_BYTES + INITIAL_CAPACITY * SLOT_BYTES);
   postMessage({ type: "SAB_INIT", sab, capacity: INITIAL_CAPACITY });
   // Keep typed array views for reading:
   const headerInt32 = new Int32Array(sab);
   const poolFloat32 = new Float32Array(sab, HEADER_BYTES);
   let lastVersion = -1;
   ```

2. **Subscribe to `SAB_GROW`**: update `sab`, `headerInt32`, `poolFloat32` refs; call `symmetryRenderer.onSabGrow(sab, capacity)`.

3. **Subscribe to `SHAPE_DEFINED`**: call `symmetryRenderer.registerShape(shapeIndex, shapeId, geometry)` — build BufferGeometry from vertices/faces here (same triangulation logic as current handler).

4. **Subscribe to `ORIENTATIONS_DEFINED`**: call `symmetryRenderer.registerSymmetryGroup(...)`.

5. **Subscribe to `COLOR_DEFINED`**: call `symmetryRenderer.registerColor(colorIndex, r, g, b)`.

6. **Subscribe to `SCENE_CLEARED`**: call `symmetryRenderer.clearAll()`, reset `lastVersion`.

7. **Subscribe to `SAB_DIRTY { slots? }`**:
   ```js
   if (slots) {
     symmetryRenderer.syncSlotsFromSAB(slots);
   } else {
     symmetryRenderer.syncAllFromSAB();
   }
   ```

8. **Update picking handler**: instead of calling `symmetryRenderer.setInstanceHighlight(...)` directly, do:
   ```js
   const hit = await symmetryRenderer.pickAt(...);
   postMessage({ type: "SELECTION_CHANGED", instanceId: hit?.vzomeId ?? null });
   ```

## Phase 5: symmetry-renderer.js Changes

### Option A — Copy-on-dirty (simpler, current plan)

Each `SAB_DIRTY` ping triggers a JS-side copy from the SAB float pool into the per-attribute `Float32Array`s backing the `InstancedBufferAttribute`s. Three.js then uploads only the dirty range to the GPU.

- `syncSlotsFromSAB(slots[])` — reads each named slot from the SAB pool, disperses its fields into the separate SoA attribute arrays, sets `needsUpdate = true` on affected attributes.
- `syncAllFromSAB()` — full scan up to `highWaterMark`.

Pros: simple, works with existing attribute layout and TSL shader unchanged.  
Cons: JS copy still happens; attributes stay SoA (separate arrays per field).

### Option B — InterleavedBufferAttribute (zero-copy, preferred if feasible)

Wrap the SAB pool float array directly as a single `THREE.InterleavedBuffer`, then expose each field as an `InterleavedBufferAttribute` with the appropriate offset and stride. No JS copy ever; the worker's writes are immediately visible to the attribute upload path.

```js
import { InterleavedBuffer, InterleavedBufferAttribute } from 'three';

// On SAB_INIT / SAB_GROW:
const poolFloat32 = new Float32Array(sab, HEADER_BYTES);
const interleavedBuf = new InterleavedBuffer(poolFloat32, SLOT_FLOATS); // stride=8
interleavedBuf.setUsage(THREE.DynamicDrawUsage);

// Expose per-field attributes (offset in floats):
const attrPos        = new InterleavedBufferAttribute(interleavedBuf, 3, POS_X);
const attrOriIdx     = new InterleavedBufferAttribute(interleavedBuf, 1, ORI_IDX);
const attrColIdx     = new InterleavedBufferAttribute(interleavedBuf, 1, COL_IDX);
const attrHighlight  = new InterleavedBufferAttribute(interleavedBuf, 1, HIGHLIGHT);
// shapeIndex and flags are not GPU attributes — read on JS side only.
```

On `SAB_DIRTY`: just set `interleavedBuf.needsUpdate = true` (optionally with `updateRange` for partial uploads).  
On `SAB_GROW`: replace `interleavedBuf` with a new one wrapping the new SAB, reassign attributes, rebuild `InstancedMesh`es.

**Constraints to resolve before committing to Option B:**
1. `InterleavedBufferAttribute` is supported by `InstancedMesh` in Three.js r168+ (WebGL path). Verify it works with the TSL/WebGPU renderer path used here (`WebGPURenderer` with `forceWebGL: true`).
2. The SAB contains both active and tombstone slots. `InstancedMesh.count` controls how many instances are drawn — but with interleaved layout the slot indices are fixed. Inactive slots (flags bit 0 = 0) must be culled by moving them off-screen (e.g., write `posX = NaN` or a large sentinel) rather than by compacting the array, since we can't reorder slots.
3. Shapes live in separate `InstancedMesh`es (one per shape), but a single SAB contains instances of all shapes interleaved. Each mesh can only reference a contiguous sub-range, or each mesh needs its own `InterleavedBuffer` view filtered to its shape's slots. This may require per-shape sub-buffers or a different SAB layout (group all slots for a given shape together, with a per-shape base offset).

**If constraint 3 is a blocker**, a hybrid is possible: keep per-shape SoA `Float32Array` attribute arrays (as in Option A), but have `syncSlotsFromSAB` use typed array `set()` to copy only the dirty slots rather than field-by-field assignments — still fast without requiring interleaved layout.

### Common additions (both options)

- `registerShape(shapeIndex, shapeId, geometry)` — accepts numeric `shapeIndex`. Maps: `shapeIndexToId`, `shapeIdToIndex`.
- `registerColor(colorIndex, r, g, b)` — explicit-index variant.
- `registerSymmetryGroup(orientations[])` — simplified (no groupId).
- `slotToInstance: Map<slotIndex, { shapeId, rendererInstanceId, vzomeId }>` — for O(1) updates and picking reverse-lookup.
- `upsertInstanceAtSlot(slotIndex, ...)` / `removeInstanceAtSlot(slotIndex)`.
- `pickAt` returns `vzomeId` on hit.
- `clearAll()` — clears all instances and maps.
- `onSabGrow(sab, capacity)` — updates typed array views (and `InterleavedBuffer` if Option B).

## Phase 6: server.js — COOP/COEP Headers

`SharedArrayBuffer` requires cross-origin isolation. Add to every response in server.js:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```
Also needed: any cross-origin resources (vzome.com worker, Three.js CDN) must send `Cross-Origin-Resource-Policy: cross-origin` headers, or be proxied.

---

## Relevant Files
- `js/main.js` — remove SCENE_RENDERED handler (lines 69–123), add SAB init + new subscriptions, update picker
- `js/worker.js` — minimal changes (message relay is automatic)
- `js/symmetry-renderer.js` — add syncFromSAB, upsert/removeInstanceAtSlot, clearAll, slotToInstance map; choose Option A or B
- `js/scene.js` — no changes expected
- `server.js` — add COOP/COEP headers
- `js/sab-constants.js` — new file, shared constants

## Decisions
- SAB written by vzome Worker thread (not main thread), read by main thread — proper inter-thread use
- Per-instance data in SAB; geometry stays message-passed (variable-length, set once)
- Highlight is worker-owned (in SAB); main thread picking sends SELECTION_CHANGED → round-trip accepted
- One global SAB for all shapes (shapeIndex field in each slot distinguishes shape)
- Growth: double capacity on overflow, post SAB_GROW to main thread
- Initial capacity: `INITIAL_CAPACITY = 4096`
- All-float32 slot layout (simpler alignment than mixed int/float)
- `postMessage` + `Atomics.add(version)` for synchronization fence
- **Phase 5 option (A vs B) is undecided** — depends on verifying InterleavedBufferAttribute + TSL compat and resolving the per-shape sub-buffer question

## Further Considerations
1. **CORS/COEP for vzome.com resources**: the vzome worker and any CDN imports need proper cross-origin headers for SharedArrayBuffer to be available. The remote vzome worker at vzome.com must serve with `Cross-Origin-Resource-Policy`. This may be the hardest deployment constraint to solve.
2. **Scale factor 0.008**: verify whether INSTANCE position values need this scale applied in the worker (same as vertex positions) or whether they're already in world space.
3. **Multi-model caching**: the current multi-groupId support in symmetry-renderer allows fast switching between loaded models. With the new protocol, model switching goes through SCENE_CLEARED → re-send all instances. Consider whether to keep a per-model cache in the worker (e.g., keep the old SAB data and swap) or just reload.

## Verification
1. Load a model: confirm `SHAPE_DEFINED`, `COLOR_DEFINED`, `ORIENTATIONS_DEFINED`, `SAB_DIRTY` messages arrive in correct order; confirm instances render correctly.
2. Load a second model from the menu: confirm `SCENE_CLEARED` fires, old instances disappear, new ones appear.
3. Click on an instance: confirm `SELECTION_CHANGED` is sent to worker, highlight appears within 1 frame.
4. Open browser DevTools → Application → check `Cross-Origin Isolated` = true for SAB to work.
5. Check memory: compare SAB size to old SCENE_RENDERED JSON payload size for the C960 model.
6. Add/remove instance at runtime (manual test or via console): confirm SAB_DIRTY with slot list, only that instance updates.
