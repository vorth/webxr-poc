import {
  Fn,
  attribute,
  positionLocal,
  uniformArray,
  vec4
} from "three/tsl";
import { THREE } from "./scene.js";

export const INITIAL_SHAPE_CAPACITY = 64;


export function createSymmetryRenderer( scene )
{
  const colorMatrices = [];
  let colorPalette = null;

  const symmetryGroups = new Map();
  let activeGroupId = null;
  let discardInactiveShaders = false;

  function registerSymmetryGroup(groupId, orientations) {
    if (symmetryGroups.has(groupId)) {
      throw new Error(`Symmetry group '${groupId}' already exists.`);
    }
    if (!Array.isArray(orientations) || orientations.length === 0) {
      throw new Error("A symmetry group needs at least one orientation.");
    }

    const orientationMatrices = orientations.map((item) => {
      if (item instanceof THREE.Matrix4) {
        return item.clone();
      }
      if (item instanceof THREE.Euler) {
        return new THREE.Matrix4().makeRotationFromEuler(item);
      }
      throw new Error("Orientation must be a THREE.Euler or THREE.Matrix4.");
    });

    const group = {
      id: groupId,
      orientations: orientationMatrices,
      styles: new Map(),
      slots: new Set(),
      activeStyleId: null,
      instancesByShape: new Map(),
      nextInstanceId: 1,
      gpu: null
    };

    symmetryGroups.set(groupId, group);
    return group;
  }

  function registerStyle(groupId, styleId) {
    const group = getSymmetryGroup(groupId);
    if (group.styles.has(styleId)) {
      throw new Error(`Style '${styleId}' is already registered in group '${groupId}'.`);
    }
    group.styles.set(styleId, { id: styleId, geometries: new Map() });
    if (group.activeStyleId === null) {
      group.activeStyleId = styleId;
    }
  }

  function registerShape(groupId, styleId, slotId, geometry) {
    if (!(geometry instanceof THREE.BufferGeometry)) {
      throw new Error("Shape geometry must be a THREE.BufferGeometry.");
    }
    const group = getSymmetryGroup(groupId);
    const style = getStyle(group, styleId);
    if (style.geometries.has(slotId)) {
      throw new Error(`Geometry for slot '${slotId}' is already registered in style '${styleId}'.`);
    }

    style.geometries.set(slotId, geometry);
    group.slots.add(slotId);

    if (group.gpu) {
      // Add to the geometry cache for this slot/style
      let slotCache = group.gpu.cachedGeometries.get(slotId);
      if (!slotCache) {
        slotCache = new Map();
        group.gpu.cachedGeometries.set(slotId, slotCache);
      }
      slotCache.set(styleId, geometry.clone());

      // Create shape entry only if this is a brand-new slot
      if (!group.gpu.shapeEntries.has(slotId)) {
        const activeGeom = (group.activeStyleId && slotCache.get(group.activeStyleId))
          ?? slotCache.values().next().value;
        const entry = createShapeEntry(slotId, activeGeom, group.gpu.material);
        group.gpu.shapeEntries.set(slotId, entry);
        if (group.id === activeGroupId) {
          scene.add(entry.mesh);
        }
      }
    }
  }

  function switchSymmetryGroup(groupId, options = {}) {
    const {
      discardUnusedShaders = discardInactiveShaders
    } = options;
    const nextGroup = getSymmetryGroup(groupId);

    if (activeGroupId === groupId) {
      return;
    }

    if (activeGroupId !== null) {
      const previous = symmetryGroups.get(activeGroupId);
      clearGroupInstances(previous);
      setGroupMeshesCount(previous, 0);
    }

    ensureGroupGpu(nextGroup);
    ensureGroupHasActiveStyle(nextGroup);
    addGroupMeshesToScene(nextGroup);
    activeGroupId = groupId;

    if (discardUnusedShaders) {
      for (const group of symmetryGroups.values()) {
        if (group.id !== activeGroupId) {
          disposeGroupGpu(group);
        }
      }
    }
  }

  function setDiscardInactiveShaders(enabled) {
    discardInactiveShaders = Boolean(enabled);
  }

  function switchStyle(styleId) {
    const group = getActiveGroup();
    getStyle(group, styleId);
    if (group.activeStyleId === styleId) {
      return;
    }
    group.activeStyleId = styleId;
    if (group.gpu) {
      swapGeometriesForStyle(group, styleId);
    }
  }

  function swapGeometriesForStyle(group, styleId) {
    for (const [slotId, entry] of group.gpu.shapeEntries) {
      swapBaseGeometry(entry, slotId, styleId, group.gpu.cachedGeometries);
    }
  }

  // Move instanced attributes from the current mesh geometry to the cached geometry
  // for newStyleId, then point the mesh at that geometry.
  // No cloning and no disposal: the old cached geometry stays alive for future switches.
  function swapBaseGeometry(entry, slotId, newStyleId, cachedGeometries) {
    const slotCache = cachedGeometries.get(slotId);
    if (!slotCache) return;
    const newGeom = slotCache.get(newStyleId);
    if (!newGeom) return;
    const oldGeom = entry.mesh.geometry;
    if (oldGeom === newGeom) return;

    for (const name of ["orientationIndex", "instanceTranslation", "colorIndex", "highlightIntensity"]) {
      const attr = oldGeom.getAttribute(name);
      if (attr) {
        oldGeom.deleteAttribute(name);
        newGeom.setAttribute(name, attr);
      }
    }
    entry.mesh.geometry = newGeom;
    // oldGeom is still in the cache with only base vertex data, ready for the next switch back
  }

  function registerColor(colorInput) {
    const color = normalizeColorInput(colorInput);
    colorMatrices.push(color);
    colorPalette = uniformArray(colorMatrices);
    rebuildGpuForColorPaletteChange();
    return colorMatrices.length - 1;
  }

  function addInstance(styleId, shapeId, instanceOptions = {}) {
    const group = getActiveGroup();
    getStyle(group, styleId);
    ensureStyleIsActiveForInstances(group, styleId);
    const shapeMap = getOrCreateShapeInstanceMap(group, shapeId);

    const position = instanceOptions.position ?? new THREE.Vector3();
    const orientationIndex = normalizeOrientationIndex(group, instanceOptions.orientationIndex);
    const colorIndex = normalizeColorIndex(instanceOptions.colorIndex);
    const highlight = instanceOptions.highlight ?? 0;

    const id = group.nextInstanceId;
    group.nextInstanceId += 1;
    shapeMap.set(id, {
      position,
      orientationIndex,
      colorIndex,
      highlight
    });

    syncShapeInstances(group, shapeId);
    return id;
  }

  function removeInstance(styleId, shapeId, instanceId) {
    const group = getActiveGroup();
    const shapeMap = group.instancesByShape.get(shapeId);
    if (!shapeMap) {
      return false;
    }
    const removed = shapeMap.delete(instanceId);
    if (removed) {
      syncShapeInstances(group, shapeId);
    }
    return removed;
  }

  function removeAllInstances(styleId, shapeId) {
    const group = getActiveGroup();
    group.instancesByShape.delete(shapeId);
    syncShapeInstances(group, shapeId);
  }

  function clearActiveInstances() {
    const group = getActiveGroup();
    clearGroupInstances(group);
    setGroupMeshesCount(group, 0);
  }

  function rebuildGpuForColorPaletteChange() {
    for (const group of symmetryGroups.values()) {
      if (group.gpu) {
        disposeGroupGpu(group);
      }
    }

    if (activeGroupId === null) {
      return;
    }

    const group = getActiveGroup();
    ensureGroupGpu(group);
    addGroupMeshesToScene(group);
    syncAllInstancesForGroup(group);
  }

  function createMaterialForGroup(group) {
    const orientationUniform = uniformArray(group.orientations);
    const orientationIndexNode = attribute("orientationIndex", "float");
    const instanceTranslationNode = attribute("instanceTranslation", "vec3");
    const colorIndexNode = attribute("colorIndex", "float");

    const highlightIntensityNode = attribute("highlightIntensity", "float");

    const rotatedPositionNode = Fn(() => {
      const orientationMat = orientationUniform.element(orientationIndexNode.toInt());
      return orientationMat.mul(vec4(positionLocal, 1.0)).xyz.add(instanceTranslationNode);
    })();
    const indexedColorNode = colorPalette.element(colorIndexNode.toInt());

    const material = new THREE.MeshPhongNodeMaterial({
      shininess: 55,
      specular: new THREE.Color(0x7288a5)
    });
    material.positionNode = rotatedPositionNode;
    material.colorNode = indexedColorNode;
    material.emissiveNode = indexedColorNode.mul(highlightIntensityNode);
    return material;
  }

  // meshGeometry is a pre-cloned cached geometry; it is used directly (not cloned again)
  function createShapeEntry(slotId, meshGeometry, material) {
    const mesh = new THREE.InstancedMesh(meshGeometry, material, INITIAL_SHAPE_CAPACITY);
    const orientBuffer = new Float32Array(INITIAL_SHAPE_CAPACITY);
    const translationBuffer = new Float32Array(INITIAL_SHAPE_CAPACITY * 3);
    const colorIndexBuffer = new Float32Array(INITIAL_SHAPE_CAPACITY);
    const highlightBuffer = new Float32Array(INITIAL_SHAPE_CAPACITY);
    attachAttributes(mesh.geometry, orientBuffer, translationBuffer, colorIndexBuffer, highlightBuffer);
    initializeIdentityMatrices(mesh, INITIAL_SHAPE_CAPACITY);
    mesh.count = 0;

    return {
      slotId,
      capacity: INITIAL_SHAPE_CAPACITY,
      mesh,
      orientBuffer,
      translationBuffer,
      colorIndexBuffer,
      highlightBuffer
    };
  }

  function ensureGroupGpu(group) {
    if (group.gpu) {
      return;
    }

    const material = createMaterialForGroup(group);

    // Pre-clone one geometry per slot per style so style switches need no allocation
    const cachedGeometries = new Map();
    for (const slotId of group.slots) {
      const slotCache = new Map();
      for (const [styleId, style] of group.styles) {
        if (style.geometries.has(slotId)) {
          slotCache.set(styleId, style.geometries.get(slotId).clone());
        }
      }
      cachedGeometries.set(slotId, slotCache);
    }

    // Build shape entries using the active style's cached geometry
    const shapeEntries = new Map();
    for (const slotId of group.slots) {
      const slotCache = cachedGeometries.get(slotId);
      if (!slotCache) continue;
      const geom = (group.activeStyleId && slotCache.get(group.activeStyleId))
        ?? slotCache.values().next().value;
      if (geom) {
        shapeEntries.set(slotId, createShapeEntry(slotId, geom, material));
      }
    }

    group.gpu = { material, shapeEntries, cachedGeometries };
  }

  function addGroupMeshesToScene(group) {
    if (!group.gpu) {
      return;
    }
    for (const entry of group.gpu.shapeEntries.values()) {
      if (entry.mesh.parent !== scene) {
        scene.add(entry.mesh);
      }
    }
  }

  function setGroupMeshesCount(group, count) {
    if (!group || !group.gpu) {
      return;
    }
    for (const entry of group.gpu.shapeEntries.values()) {
      entry.mesh.count = count;
    }
  }

  function clearGroupInstances(group) {
    if (!group) {
      return;
    }
    group.instancesByShape.clear();
  }

  function syncShapeInstances(group, slotId) {
    if (!group.gpu) {
      return;
    }
    const entry = group.gpu.shapeEntries.get(slotId);
    if (!entry) {
      throw new Error(`Shape slot '${slotId}' is not registered for active group '${group.id}'.`);
    }

    const shapeMap = group.instancesByShape.get(slotId);
    const instances = shapeMap ? Array.from(shapeMap.values()) : [];
    ensureShapeCapacity(group, slotId, instances.length);

    const currentEntry = group.gpu.shapeEntries.get(slotId);
    currentEntry.mesh.count = instances.length;
    for (let i = 0; i < instances.length; i += 1) {
      const { position, orientationIndex, colorIndex, highlight = 0 } = instances[i];
      currentEntry.orientBuffer[i] = orientationIndex;
      const base = i * 3;
      currentEntry.translationBuffer[base] = position.x;
      currentEntry.translationBuffer[base + 1] = position.y;
      currentEntry.translationBuffer[base + 2] = position.z;
      currentEntry.colorIndexBuffer[i] = colorIndex;
      currentEntry.highlightBuffer[i] = highlight;
    }

    currentEntry.mesh.geometry.getAttribute("orientationIndex").needsUpdate = true;
    currentEntry.mesh.geometry.getAttribute("instanceTranslation").needsUpdate = true;
    currentEntry.mesh.geometry.getAttribute("colorIndex").needsUpdate = true;
    currentEntry.mesh.geometry.getAttribute("highlightIntensity").needsUpdate = true;
  }

  function ensureShapeCapacity(group, key, needed) {
    const entry = group.gpu.shapeEntries.get(key);
    if (needed <= entry.capacity) {
      return;
    }

    const expandedCapacity = Math.max(needed, entry.capacity * 2);
    const nextOrient = new Float32Array(expandedCapacity);
    const nextTranslation = new Float32Array(expandedCapacity * 3);
    const nextColor = new Float32Array(expandedCapacity);
    const nextHighlight = new Float32Array(expandedCapacity);
    nextOrient.set(entry.orientBuffer);
    nextTranslation.set(entry.translationBuffer);
    nextColor.set(entry.colorIndexBuffer);
    nextHighlight.set(entry.highlightBuffer);

    const previousMesh = entry.mesh;
    const previousGeometry = previousMesh.geometry;

    // Clone from the source geometry so the new cached geom has clean base vertex data
    const activeStyle = group.styles.get(group.activeStyleId);
    const sourceGeom = activeStyle ? activeStyle.geometries.get(entry.slotId) : null;
    const nextGeometry = sourceGeom ? sourceGeom.clone() : previousGeometry.clone();
    attachAttributes(nextGeometry, nextOrient, nextTranslation, nextColor, nextHighlight);

    // Update the geometry cache: replace the active style's entry with the new geometry
    const slotCache = group.gpu.cachedGeometries.get(entry.slotId);
    if (slotCache && group.activeStyleId) {
      slotCache.set(group.activeStyleId, nextGeometry);
    }

    const nextMesh = new THREE.InstancedMesh(nextGeometry, group.gpu.material, expandedCapacity);
    initializeIdentityMatrices(nextMesh, expandedCapacity);
    nextMesh.count = previousMesh.count;

    if (previousMesh.parent === scene) {
      scene.remove(previousMesh);
      scene.add(nextMesh);
    }
    // The old geometry is no longer in the cache; defer disposal to avoid destroying
    // buffers that the current frame's command buffer may still reference
    requestAnimationFrame(() => previousGeometry.dispose());

    group.gpu.shapeEntries.set(key, {
      ...entry,
      capacity: expandedCapacity,
      mesh: nextMesh,
      orientBuffer: nextOrient,
      translationBuffer: nextTranslation,
      colorIndexBuffer: nextColor,
      highlightBuffer: nextHighlight
    });
  }

  function attachAttributes(geometry, orientBuffer, translationBuffer, colorIndexBuffer, highlightBuffer) {
    geometry.setAttribute("orientationIndex", new THREE.InstancedBufferAttribute(orientBuffer, 1));
    geometry.setAttribute("instanceTranslation", new THREE.InstancedBufferAttribute(translationBuffer, 3));
    geometry.setAttribute("colorIndex", new THREE.InstancedBufferAttribute(colorIndexBuffer, 1));
    geometry.setAttribute("highlightIntensity", new THREE.InstancedBufferAttribute(highlightBuffer, 1));
  }

  function initializeIdentityMatrices(mesh, capacity) {
    const identity = new THREE.Matrix4();
    for (let i = 0; i < capacity; i += 1) {
      mesh.setMatrixAt(i, identity);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  function disposeGroupGpu(group) {
    if (!group.gpu) {
      return;
    }

    for (const entry of group.gpu.shapeEntries.values()) {
      if (entry.mesh.parent === scene) {
        scene.remove(entry.mesh);
      }
      // Geometry is owned by cachedGeometries; disposed below
    }
    for (const slotCache of group.gpu.cachedGeometries.values()) {
      for (const geom of slotCache.values()) {
        geom.dispose();
      }
    }
    group.gpu.material.dispose();
    group.gpu = null;
  }

  function syncAllInstancesForGroup(group) {
    for (const slotId of group.instancesByShape.keys()) {
      syncShapeInstances(group, slotId);
    }
  }

  function getSymmetryGroup(groupId) {
    const group = symmetryGroups.get(groupId);
    if (!group) {
      throw new Error(`Unknown symmetry group '${groupId}'.`);
    }
    return group;
  }

  function getStyle(group, styleId) {
    const style = group.styles.get(styleId);
    if (!style) {
      throw new Error(`Unknown style '${styleId}' in group '${group.id}'.`);
    }
    return style;
  }

  function getGroupIds() {
    return [...symmetryGroups.keys()];
  }

  function getActiveGroupId() {
    return activeGroupId;
  }

  function getActiveGroup() {
    if (activeGroupId === null) {
      throw new Error("No active symmetry group. Call switchSymmetryGroup() first.");
    }
    return getSymmetryGroup(activeGroupId);
  }

  function getOrCreateShapeInstanceMap(group, key) {
    let shapeMap = group.instancesByShape.get(key);
    if (!shapeMap) {
      shapeMap = new Map();
      group.instancesByShape.set(key, shapeMap);
    }
    return shapeMap;
  }

  function normalizeOrientationIndex(group, orientationIndex) {
    if (orientationIndex === undefined || orientationIndex === null) {
      return Math.floor(Math.random() * group.orientations.length);
    }
    if (!Number.isInteger(orientationIndex)) {
      throw new Error("orientationIndex must be an integer.");
    }
    if (orientationIndex < 0 || orientationIndex >= group.orientations.length) {
      throw new Error(`orientationIndex out of range for group '${group.id}'.`);
    }
    return orientationIndex;
  }

  function normalizeColorIndex(colorIndex) {
    if (colorIndex === undefined || colorIndex === null) {
      return Math.floor(Math.random() * colorMatrices.length);
    }
    if (!Number.isInteger(colorIndex)) {
      throw new Error("colorIndex must be an integer.");
    }
    if (colorIndex < 0 || colorIndex >= colorMatrices.length) {
      throw new Error("colorIndex out of range.");
    }
    return colorIndex;
  }

  function normalizeColorInput(colorInput) {
    if (colorInput instanceof THREE.Vector3) {
      return colorInput.clone();
    }
    if (colorInput instanceof THREE.Color) {
      return new THREE.Vector3(colorInput.r, colorInput.g, colorInput.b);
    }
    if (Array.isArray(colorInput) && colorInput.length === 3) {
      return new THREE.Vector3(colorInput[0], colorInput[1], colorInput[2]);
    }
    if (typeof colorInput === "object" && colorInput !== null && "r" in colorInput && "g" in colorInput && "b" in colorInput) {
      return new THREE.Vector3(colorInput.r, colorInput.g, colorInput.b);
    }
    if (typeof colorInput === "number" || typeof colorInput === "string") {
      const color = new THREE.Color(colorInput);
      return new THREE.Vector3(color.r, color.g, color.b);
    }
    throw new Error("registerColor expects a THREE.Color, THREE.Vector3, [r,g,b], {r,g,b}, number, or CSS color string.");
  }

  function ensureGroupHasActiveStyle(group) {
    if (group.activeStyleId !== null) {
      return;
    }
    const firstStyle = group.styles.keys().next();
    group.activeStyleId = firstStyle.done ? null : firstStyle.value;
  }

  function ensureStyleIsActiveForInstances(group, styleId) {
    if (group.activeStyleId === null) {
      group.activeStyleId = styleId;
      return;
    }
    if (group.activeStyleId === styleId) {
      return;
    }
    group.activeStyleId = styleId;
    if (group.gpu) {
      swapGeometriesForStyle(group, styleId);
    }
  }

  function setInstanceHighlight(shapeId, instanceId, intensity = 1) {
    const group = getActiveGroup();
    const shapeMap = group.instancesByShape.get(shapeId);
    if (!shapeMap || !shapeMap.has(instanceId)) {
      return false;
    }
    shapeMap.get(instanceId).highlight = intensity;
    syncShapeInstances(group, shapeId);
    return true;
  }

  function clearHighlights(shapeId) {
    const group = getActiveGroup();
    if (shapeId !== undefined) {
      const shapeMap = group.instancesByShape.get(shapeId);
      if (shapeMap) {
        for (const inst of shapeMap.values()) {
          inst.highlight = 0;
        }
        syncShapeInstances(group, shapeId);
      }
    } else {
      for (const [sid, shapeMap] of group.instancesByShape) {
        for (const inst of shapeMap.values()) {
          inst.highlight = 0;
        }
        syncShapeInstances(group, sid);
      }
    }
  }

  function listShapeKeys(group, styleId) {
    const keys = [];
    for (const slotId of group.slots) {
      keys.push({ styleId, shapeId: slotId });
    }
    return keys;
  }

  return {
    registerSymmetryGroup,
    registerStyle,
    registerShape,
    registerColor,
    switchSymmetryGroup,
    switchStyle,
    setDiscardInactiveShaders,
    addInstance,
    removeInstance,
    removeAllInstances,
    clearActiveInstances,
    setInstanceHighlight,
    clearHighlights,
    getGroupIds,
    getActiveGroupId,
    getActiveGroup,
    listShapeKeys,
  };
}
