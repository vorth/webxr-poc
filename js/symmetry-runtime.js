import {
  Fn,
  attribute,
  positionLocal,
  uniformArray,
  vec4
} from "three/tsl";
import { THREE } from "./scene.js";

export const INITIAL_SHAPE_CAPACITY = 64;
export const RANDOM_INSTANCE_COUNT = 1000;

export function createSymmetryRuntime({ scene, hudDesc, groupSelectEl, styleSelectEl, randomInstanceCount = RANDOM_INSTANCE_COUNT })
{
  const colorMatrices = [
    new THREE.Vector3(0.2, 0.72, 0.98),
    new THREE.Vector3(0.96, 0.2, 0.16),
    new THREE.Vector3(0.88, 0.96, 0.32),
    new THREE.Vector3(0.7, 0.3, 1.0)
  ];
  const colorPalette = uniformArray(colorMatrices);

  const symmetryGroups = new Map();
  let activeGroupId = null;
  let discardInactiveShaders = false;

  function shapeKey(styleId, shapeId) {
    return `${styleId}::${shapeId}`;
  }

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
      activeStyleId: null,
      instancesByShape: new Map(),
      nextInstanceId: 1,
      gpu: null
    };

    symmetryGroups.set(groupId, group);
    refreshHudSelectors();
    return group;
  }

  function registerStyle(groupId, styleId) {
    const group = getSymmetryGroup(groupId);
    if (group.styles.has(styleId)) {
      throw new Error(`Style '${styleId}' is already registered in group '${groupId}'.`);
    }
    group.styles.set(styleId, { id: styleId, shapes: new Map() });
    if (group.activeStyleId === null) {
      group.activeStyleId = styleId;
    }
    refreshHudSelectors();
  }

  function registerShape(groupId, styleId, shapeId, geometry) {
    if (!(geometry instanceof THREE.BufferGeometry)) {
      throw new Error("Shape geometry must be a THREE.BufferGeometry.");
    }
    const group = getSymmetryGroup(groupId);
    const style = getStyle(group, styleId);
    if (style.shapes.has(shapeId)) {
      throw new Error(`Shape '${shapeId}' is already registered in style '${styleId}'.`);
    }

    style.shapes.set(shapeId, {
      id: shapeId,
      geometry
    });

    if (group.gpu) {
      const key = shapeKey(styleId, shapeId);
      const entry = createShapeEntry(styleId, shapeId, geometry, group.gpu.material);
      group.gpu.shapeEntries.set(key, entry);
      if (group.id === activeGroupId) {
        scene.add(entry.mesh);
      }
    }
  }

  function switchSymmetryGroup(groupId, options = {}) {
    const {
      discardUnusedShaders = discardInactiveShaders,
      autoPopulate = false,
      populateCount = randomInstanceCount
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
    updateHudForGroup(nextGroup);

    if (discardUnusedShaders) {
      for (const group of symmetryGroups.values()) {
        if (group.id !== activeGroupId) {
          disposeGroupGpu(group);
        }
      }
    }

    if (autoPopulate) {
      populateRandomInstances(populateCount);
    }

    refreshHudSelectors();
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
    clearGroupInstances(group);
    setGroupMeshesCount(group, 0);
    group.activeStyleId = styleId;
    updateHudForGroup(group);
    refreshHudSelectors();
  }

  function registerColor(colorInput) {
    const color = normalizeColorInput(colorInput);
    colorMatrices.push(color);
    rebuildGpuForColorPaletteChange();
    return colorMatrices.length - 1;
  }

  function addInstance(styleId, shapeId, instanceOptions = {}) {
    const group = getActiveGroup();
    getStyle(group, styleId);
    ensureStyleIsActiveForInstances(group, styleId);
    const key = shapeKey(styleId, shapeId);
    const shapeMap = getOrCreateShapeInstanceMap(group, key);

    const position = instanceOptions.position ?? new THREE.Vector3();
    const orientationIndex = normalizeOrientationIndex(group, instanceOptions.orientationIndex);
    const colorIndex = normalizeColorIndex(instanceOptions.colorIndex);

    const id = group.nextInstanceId;
    group.nextInstanceId += 1;
    shapeMap.set(id, {
      position,
      orientationIndex,
      colorIndex
    });

    syncShapeInstances(group, styleId, shapeId);
    return id;
  }

  function removeInstance(styleId, shapeId, instanceId) {
    const group = getActiveGroup();
    const key = shapeKey(styleId, shapeId);
    const shapeMap = group.instancesByShape.get(key);
    if (!shapeMap) {
      return false;
    }
    const removed = shapeMap.delete(instanceId);
    if (removed) {
      syncShapeInstances(group, styleId, shapeId);
    }
    return removed;
  }

  function removeAllInstances(styleId, shapeId) {
    const group = getActiveGroup();
    const key = shapeKey(styleId, shapeId);
    group.instancesByShape.delete(key);
    syncShapeInstances(group, styleId, shapeId);
  }

  function clearActiveInstances() {
    const group = getActiveGroup();
    clearGroupInstances(group);
    setGroupMeshesCount(group, 0);
  }

  function populateRandomInstances(count) {
    const group = getActiveGroup();
    ensureGroupHasActiveStyle(group);
    if (!group.activeStyleId) {
      return;
    }
    const keys = listShapeKeys(group, group.activeStyleId);
    if (keys.length === 0) {
      return;
    }

    for (let i = 0; i < count; i += 1) {
      const selection = keys[Math.floor(Math.random() * keys.length)];
      addInstance(selection.styleId, selection.shapeId, {
        position: randomPosition()
      });
    }
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
    return material;
  }

  function createShapeEntry(styleId, shapeId, sourceGeometry, material) {
    const meshGeometry = sourceGeometry.clone();
    const mesh = new THREE.InstancedMesh(meshGeometry, material, INITIAL_SHAPE_CAPACITY);
    const orientBuffer = new Float32Array(INITIAL_SHAPE_CAPACITY);
    const translationBuffer = new Float32Array(INITIAL_SHAPE_CAPACITY * 3);
    const colorIndexBuffer = new Float32Array(INITIAL_SHAPE_CAPACITY);
    attachAttributes(mesh.geometry, orientBuffer, translationBuffer, colorIndexBuffer);
    initializeIdentityMatrices(mesh, INITIAL_SHAPE_CAPACITY);
    mesh.count = 0;

    return {
      styleId,
      shapeId,
      capacity: INITIAL_SHAPE_CAPACITY,
      mesh,
      orientBuffer,
      translationBuffer,
      colorIndexBuffer
    };
  }

  function ensureGroupGpu(group) {
    if (group.gpu) {
      return;
    }

    const material = createMaterialForGroup(group);
    const shapeEntries = new Map();
    for (const [styleId, style] of group.styles) {
      for (const [shapeId, shape] of style.shapes) {
        const key = shapeKey(styleId, shapeId);
        shapeEntries.set(key, createShapeEntry(styleId, shapeId, shape.geometry, material));
      }
    }

    group.gpu = {
      material,
      shapeEntries
    };
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

  function syncShapeInstances(group, styleId, shapeId) {
    if (!group.gpu) {
      return;
    }
    const key = shapeKey(styleId, shapeId);
    const entry = group.gpu.shapeEntries.get(key);
    if (!entry) {
      throw new Error(`Shape '${shapeId}' in style '${styleId}' is not registered for active group '${group.id}'.`);
    }

    const shapeMap = group.instancesByShape.get(key);
    const instances = shapeMap ? Array.from(shapeMap.values()) : [];
    ensureShapeCapacity(group, key, instances.length);

    const currentEntry = group.gpu.shapeEntries.get(key);
    currentEntry.mesh.count = instances.length;
    for (let i = 0; i < instances.length; i += 1) {
      const { position, orientationIndex, colorIndex } = instances[i];
      currentEntry.orientBuffer[i] = orientationIndex;
      const base = i * 3;
      currentEntry.translationBuffer[base] = position.x;
      currentEntry.translationBuffer[base + 1] = position.y;
      currentEntry.translationBuffer[base + 2] = position.z;
      currentEntry.colorIndexBuffer[i] = colorIndex;
    }

    currentEntry.mesh.geometry.getAttribute("orientationIndex").needsUpdate = true;
    currentEntry.mesh.geometry.getAttribute("instanceTranslation").needsUpdate = true;
    currentEntry.mesh.geometry.getAttribute("colorIndex").needsUpdate = true;
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
    nextOrient.set(entry.orientBuffer);
    nextTranslation.set(entry.translationBuffer);
    nextColor.set(entry.colorIndexBuffer);

    const previousMesh = entry.mesh;
    const previousGeometry = previousMesh.geometry;
    const nextGeometry = previousGeometry.clone();
    const nextMesh = new THREE.InstancedMesh(nextGeometry, group.gpu.material, expandedCapacity);
    initializeIdentityMatrices(nextMesh, expandedCapacity);
    nextMesh.count = previousMesh.count;
    attachAttributes(nextGeometry, nextOrient, nextTranslation, nextColor);

    if (previousMesh.parent === scene) {
      scene.remove(previousMesh);
      scene.add(nextMesh);
    }
    previousGeometry.dispose();

    group.gpu.shapeEntries.set(key, {
      ...entry,
      capacity: expandedCapacity,
      mesh: nextMesh,
      orientBuffer: nextOrient,
      translationBuffer: nextTranslation,
      colorIndexBuffer: nextColor
    });
  }

  function attachAttributes(geometry, orientBuffer, translationBuffer, colorIndexBuffer) {
    geometry.setAttribute("orientationIndex", new THREE.InstancedBufferAttribute(orientBuffer, 1));
    geometry.setAttribute("instanceTranslation", new THREE.InstancedBufferAttribute(translationBuffer, 3));
    geometry.setAttribute("colorIndex", new THREE.InstancedBufferAttribute(colorIndexBuffer, 1));
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
      entry.mesh.geometry.dispose();
    }
    group.gpu.material.dispose();
    group.gpu = null;
  }

  function syncAllInstancesForGroup(group) {
    for (const key of group.instancesByShape.keys()) {
      const { styleId, shapeId } = parseShapeKey(key);
      syncShapeInstances(group, styleId, shapeId);
    }
  }

  function parseShapeKey(key) {
    const [styleId, shapeId] = key.split("::");
    return { styleId, shapeId };
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
    clearGroupInstances(group);
    setGroupMeshesCount(group, 0);
    group.activeStyleId = styleId;
    updateHudForGroup(group);
  }

  function updateHudForGroup(group) {
    if (hudDesc) {
      const styleText = group.activeStyleId ? `active style '${group.activeStyleId}'` : "no active style";
      hudDesc.textContent = `${group.id}: ${group.orientations.length} orientations, ${styleText}`;
    }
  }

  function refreshHudSelectors() {
    if (groupSelectEl) {
      const previous = groupSelectEl.value;
      groupSelectEl.innerHTML = "";
      for (const groupId of symmetryGroups.keys()) {
        const option = document.createElement("option");
        option.value = groupId;
        option.textContent = groupId;
        groupSelectEl.appendChild(option);
      }
      if (activeGroupId && symmetryGroups.has(activeGroupId)) {
        groupSelectEl.value = activeGroupId;
      } else if (previous && symmetryGroups.has(previous)) {
        groupSelectEl.value = previous;
      }
    }

    if (!styleSelectEl) {
      return;
    }

    styleSelectEl.innerHTML = "";
    const group = activeGroupId ? symmetryGroups.get(activeGroupId) : null;
    if (!group) {
      styleSelectEl.disabled = true;
      return;
    }

    for (const styleId of group.styles.keys()) {
      const option = document.createElement("option");
      option.value = styleId;
      option.textContent = styleId;
      styleSelectEl.appendChild(option);
    }
    styleSelectEl.disabled = group.styles.size === 0;
    if (group.activeStyleId && group.styles.has(group.activeStyleId)) {
      styleSelectEl.value = group.activeStyleId;
    }
  }

  function randomPosition() {
    return new THREE.Vector3(
      THREE.MathUtils.randFloatSpread(36),
      THREE.MathUtils.randFloatSpread(10),
      THREE.MathUtils.randFloatSpread(36)
    );
  }

  function listShapeKeys(group, styleId) {
    const keys = [];
    const style = group.styles.get(styleId);
    if (!style) {
      return keys;
    }
    for (const shapeId of style.shapes.keys()) {
      keys.push({ styleId, shapeId });
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
    populateRandomInstances,
    refreshHudSelectors
  };
}
