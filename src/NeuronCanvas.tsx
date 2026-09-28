import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { CameraState, Graph, GraphNode, Vec3 } from '../shared/types';

type Props = {
  graph: Graph;
  selectedId: string | null;
  linking: boolean;
  command: { id: number; type: 'fit' | 'focus' | 'in' | 'out'; nodeId?: string } | null;
  onSelect: (nodeId: string) => void;
  onOpen: (nodeId: string) => void;
  onCommit: (node: GraphNode) => void;
  onCamera: (camera: CameraState) => void;
  onMetrics: (metrics: { frameP95: number; drawCalls: number; visibleNodes: number }) => void;
};

type Item = { id: string; title: string; position: Vec3; scale: number; color: string; node?: GraphNode; count: number };
type Pointer = { x: number; y: number; sx: number; sy: number; hitId: string | null };

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const vector = (value: Vec3) => new THREE.Vector3(value.x, value.y, value.z);

class NeuronEngine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(55, 1, 0.1, 2500);
  private raycaster = new THREE.Raycaster();
  private nodeMesh: THREE.InstancedMesh | null = null;
  private haloMesh: THREE.InstancedMesh | null = null;
  private lineMesh: THREE.LineSegments | null = null;
  private stars: THREE.Points;
  private items: Item[] = [];
  private itemById = new Map<string, number>();
  private lineEndpoints = new Map<string, number[]>();
  private nodes = new Map<string, GraphNode>();
  private graph: Graph;
  private selectedId: string | null = null;
  private pointers = new Map<number, Pointer>();
  private mode: 'rotate' | 'pan' | 'drag' | 'pinchCamera' | 'pinchNode' | null = null;
  private dragId: string | null = null;
  private dragPlane = new THREE.Plane();
  private dragOffset = new THREE.Vector3();
  private moved = false;
  private pinchStart = { distance: 1, cameraDistance: 1, nodeScale: 1, midpointX: 0, midpointY: 0 };
  private state: CameraState;
  private pendingFrame = 0;
  private frameTimes: number[] = [];
  private lastFrame = 0;
  private qualityScale = 1;
  private pointerActive = false;
  private labelContext: CanvasRenderingContext2D;
  private callbacks: Omit<Props, 'graph' | 'selectedId' | 'linking' | 'command'>;
  private linking = false;
  private resizeObserver: ResizeObserver;
  private tempObject = new THREE.Object3D();
  private tempColor = new THREE.Color();

  constructor(private canvas: HTMLCanvasElement, private labels: HTMLCanvasElement, graph: Graph, callbacks: NeuronEngine['callbacks']) {
    this.graph = graph;
    this.callbacks = callbacks;
    this.state = structuredClone(graph.board.cameraState);
    this.labelContext = labels.getContext('2d')!;
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x050b18, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene.fog = new THREE.FogExp2(0x080f20, 0.0028);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.35));
    const starPositions = new Float32Array(450 * 3);
    for (let i = 0; i < 450; i++) {
      const angle = i * 2.399963;
      const z = 1 - 2 * (i + 0.5) / 450;
      const radius = Math.sqrt(1 - z * z) * (260 + (i % 7) * 20);
      starPositions[i * 3] = Math.cos(angle) * radius;
      starPositions[i * 3 + 1] = Math.sin(angle) * radius;
      starPositions[i * 3 + 2] = z * radius;
    }
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    this.stars = new THREE.Points(starGeometry, new THREE.PointsMaterial({ color: 0x526d98, size: 0.6, sizeAttenuation: true, transparent: true, opacity: 0.65, depthWrite: false }));
    this.scene.add(this.stars);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement!);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('dblclick', this.onDoubleClick);
    canvas.addEventListener('contextmenu', this.preventContextMenu);
    this.setGraph(graph);
    this.resize();
  }

  setCallbacks(callbacks: NeuronEngine['callbacks']) { this.callbacks = callbacks; }
  setLinking(linking: boolean) { this.linking = linking; }
  setSelected(id: string | null) { this.selectedId = id; this.refreshColors(); this.invalidate(); }

  setGraph(graph: Graph) {
    const sameTopology = this.graph.edges === graph.edges && graph.nodes.length === this.nodes.size && graph.nodes.every(node => this.nodes.has(node.id));
    if (sameTopology && this.nodeMesh && !this.items.some(item => item.count > 1)) {
      let recolor = false;
      for (const node of graph.nodes) {
        const previous = this.nodes.get(node.id)!;
        const colorOrTitleChanged = node.color !== previous.color || node.title !== previous.title;
        if (node.x !== previous.x || node.y !== previous.y || node.z !== previous.z || node.scale !== previous.scale) this.updateNode(node.id, node);
        if (colorOrTitleChanged) {
          const item = this.items[this.itemById.get(node.id)!];
          item.color = node.color; item.title = node.title;
          recolor = true;
        }
        this.nodes.set(node.id, { ...node });
      }
      this.graph = graph;
      if (recolor) this.refreshColors();
      this.invalidate();
      return;
    }
    this.graph = graph;
    this.nodes = new Map(graph.nodes.map(node => [node.id, { ...node }]));
    this.buildGeometry();
    this.invalidate();
  }

  private makeItems(): Item[] {
    const all = [...this.nodes.values()];
    if (all.length < 1700 || this.state.distance < 100) return all.map(node => ({ id: node.id, title: node.title, position: node, scale: node.scale, color: node.color, node, count: 1 }));
    const cells = new Map<string, { x: number; y: number; z: number; nodes: GraphNode[] }>();
    const size = clamp(this.state.distance / 4, 18, 45);
    for (const node of all) {
      const key = `${Math.floor(node.x / size)}:${Math.floor(node.y / size)}:${Math.floor(node.z / size)}`;
      const cell = cells.get(key) ?? { x: 0, y: 0, z: 0, nodes: [] };
      cell.x += node.x; cell.y += node.y; cell.z += node.z; cell.nodes.push(node);
      cells.set(key, cell);
    }
    return [...cells].map(([key, cell]) => {
      if (cell.nodes.length === 1) {
        const node = cell.nodes[0];
        return { id: node.id, title: node.title, position: node, scale: node.scale, color: node.color, node, count: 1 };
      }
      return { id: `cluster:${key}`, title: `${cell.nodes.length}개의 생각`, position: { x: cell.x / cell.nodes.length, y: cell.y / cell.nodes.length, z: cell.z / cell.nodes.length }, scale: clamp(1.3 + Math.log2(cell.nodes.length) * 0.33, 1.5, 3.5), color: '#5b8eaa', count: cell.nodes.length };
    });
  }

  private disposeGraph() {
    for (const mesh of [this.nodeMesh, this.haloMesh, this.lineMesh]) {
      if (mesh) { this.scene.remove(mesh); mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); }
    }
    this.nodeMesh = null; this.haloMesh = null; this.lineMesh = null;
  }

  private buildGeometry() {
    this.disposeGraph();
    this.lineEndpoints.clear();
    this.items = this.makeItems();
    this.itemById = new Map(this.items.map((item, index) => [item.id, index]));
    if (!this.items.length) return;
    const geometry = new THREE.IcosahedronGeometry(1, 1);
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.nodeMesh = new THREE.InstancedMesh(geometry, material, this.items.length);
    this.nodeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.nodeMesh.frustumCulled = false;
    const haloGeometry = new THREE.SphereGeometry(1, 8, 6);
    const haloMaterial = new THREE.MeshBasicMaterial({ color: 0x69c5c5, transparent: true, opacity: 0.065, depthWrite: false, blending: THREE.AdditiveBlending });
    this.haloMesh = new THREE.InstancedMesh(haloGeometry, haloMaterial, this.items.length);
    this.haloMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.haloMesh.frustumCulled = false;
    this.items.forEach((item, index) => this.writeMatrix(index, item));
    this.nodeMesh.instanceMatrix.needsUpdate = true;
    this.haloMesh.instanceMatrix.needsUpdate = true;
    this.refreshColors();
    this.scene.add(this.haloMesh, this.nodeMesh);

    const groupByNode = new Map<string, string>();
    const size = clamp(this.state.distance / 4, 18, 45);
    for (const node of this.nodes.values()) {
      const key = `cluster:${Math.floor(node.x / size)}:${Math.floor(node.y / size)}:${Math.floor(node.z / size)}`;
      groupByNode.set(node.id, this.itemById.has(key) ? key : node.id);
    }
    const seen = new Set<string>();
    const positions: number[] = [], colors: number[] = [];
    for (const edge of this.graph.edges) {
      const aId = groupByNode.get(edge.sourceNodeId), bId = groupByNode.get(edge.targetNodeId);
      if (!aId || !bId || aId === bId) continue;
      const key = [aId, bId].sort().join(':');
      if (seen.has(key)) continue;
      seen.add(key);
      const a = this.items[this.itemById.get(aId)!].position, b = this.items[this.itemById.get(bId)!].position;
      const vertexIndex = positions.length / 3;
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
      if (aId === edge.sourceNodeId) this.lineEndpoints.set(aId, [...(this.lineEndpoints.get(aId) ?? []), vertexIndex]);
      if (bId === edge.targetNodeId) this.lineEndpoints.set(bId, [...(this.lineEndpoints.get(bId) ?? []), vertexIndex + 1]);
      const focused = edge.sourceNodeId === this.selectedId || edge.targetNodeId === this.selectedId;
      const tint = focused ? [0.33, 0.92, 0.82] : [0.14, 0.29, 0.41];
      colors.push(...tint, ...tint);
    }
    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    lineGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.lineMesh = new THREE.LineSegments(lineGeometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.76, depthWrite: false }));
    this.lineMesh.frustumCulled = false;
    this.scene.add(this.lineMesh);
  }

  private writeMatrix(index: number, item: Item) {
    this.tempObject.position.copy(vector(item.position));
    this.tempObject.scale.setScalar(item.scale * 0.88);
    this.tempObject.updateMatrix();
    this.nodeMesh?.setMatrixAt(index, this.tempObject.matrix);
    this.tempObject.scale.setScalar(item.scale * 2.8);
    this.tempObject.updateMatrix();
    this.haloMesh?.setMatrixAt(index, this.tempObject.matrix);
  }

  private refreshColors() {
    if (!this.nodeMesh) return;
    this.items.forEach((item, index) => {
      this.tempColor.set(item.id === this.selectedId ? '#e9fff7' : item.color);
      this.nodeMesh!.setColorAt(index, this.tempColor);
    });
    if (this.nodeMesh.instanceColor) this.nodeMesh.instanceColor.needsUpdate = true;
  }

  private updateNode(id: string, patch: Partial<GraphNode>) {
    const node = this.nodes.get(id);
    if (!node) return;
    Object.assign(node, patch);
    const index = this.itemById.get(id);
    if (index !== undefined) {
      const item = this.items[index];
      item.position = node; item.scale = node.scale;
      this.writeMatrix(index, item);
      if (this.nodeMesh) this.nodeMesh.instanceMatrix.needsUpdate = true;
      if (this.haloMesh) this.haloMesh.instanceMatrix.needsUpdate = true;
    }
    if (this.lineMesh && this.lineEndpoints.has(id)) {
      const positions = this.lineMesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (const vertexIndex of this.lineEndpoints.get(id)!) positions.setXYZ(vertexIndex, node.x, node.y, node.z);
      positions.needsUpdate = true;
    }
    this.invalidate();
  }

  private resize() {
    const rect = this.canvas.parentElement!.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const ratio = Math.min(window.devicePixelRatio || 1, window.innerWidth < 700 ? 1.5 : 2) * this.qualityScale;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(rect.width, rect.height, false);
    this.camera.aspect = rect.width / rect.height;
    this.camera.updateProjectionMatrix();
    this.labels.width = Math.round(rect.width * ratio);
    this.labels.height = Math.round(rect.height * ratio);
    this.labels.style.width = `${rect.width}px`;
    this.labels.style.height = `${rect.height}px`;
    this.labelContext.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.invalidate();
  }

  private updateCamera() {
    const { yaw, pitch, distance, target } = this.state;
    const cp = Math.cos(pitch);
    this.camera.position.set(target.x + Math.sin(yaw) * cp * distance, target.y + Math.sin(pitch) * distance, target.z + Math.cos(yaw) * cp * distance);
    this.camera.lookAt(target.x, target.y, target.z);
    this.camera.updateMatrixWorld();
  }

  private drawLabels() {
    const context = this.labelContext;
    const width = this.labels.clientWidth, height = this.labels.clientHeight;
    context.clearRect(0, 0, width, height);
    const selected = this.items.find(item => item.id === this.selectedId);
    const candidates = this.items.filter(item => item.count > 1 || item.id === this.selectedId || this.state.distance < 95)
      .map(item => ({ item, distance: this.camera.position.distanceTo(vector(item.position)) }))
      .sort((a, b) => (a.item === selected ? -1 : b.item === selected ? 1 : a.distance - b.distance))
      .slice(0, window.innerWidth < 700 ? 18 : 36);
    context.font = '12px system-ui, sans-serif';
    context.textAlign = 'center';
    for (const { item } of candidates) {
      const p = vector(item.position).project(this.camera);
      if (p.z < -1 || p.z > 1 || Math.abs(p.x) > 1.1 || Math.abs(p.y) > 1.1) continue;
      const x = (p.x + 1) * 0.5 * width, y = (-p.y + 1) * 0.5 * height;
      const label = item.title.length > 24 ? `${item.title.slice(0, 23)}…` : item.title;
      const boxWidth = Math.min(240, context.measureText(label).width + 20);
      context.fillStyle = item.id === this.selectedId ? 'rgba(5, 25, 33, .86)' : 'rgba(7, 16, 31, .76)';
      context.beginPath(); context.roundRect(x - boxWidth / 2, y + 12, boxWidth, 24, 7); context.fill();
      context.fillStyle = item.id === this.selectedId ? '#d8fff4' : '#b8ccd8';
      context.fillText(label, x, y + 28);
    }
  }

  private render = (time: number) => {
    this.pendingFrame = 0;
    this.updateCamera();
    this.renderer.render(this.scene, this.camera);
    this.drawLabels();
    if (this.pointerActive && this.lastFrame) {
      this.frameTimes.push(time - this.lastFrame);
      if (this.frameTimes.length > 100) this.frameTimes.shift();
      if (this.frameTimes.length === 100) {
        const ordered = [...this.frameTimes].sort((a, b) => a - b);
        const p95 = ordered[94];
        this.callbacks.onMetrics({ frameP95: Math.round(p95 * 10) / 10, drawCalls: this.renderer.info.render.calls, visibleNodes: this.items.length });
        if (p95 > 34 && this.qualityScale > 0.65) { this.qualityScale = 0.65; this.resize(); }
      }
    }
    this.lastFrame = time;
    if (this.pointerActive) this.invalidate();
  };
  private invalidate() { if (!this.pendingFrame) this.pendingFrame = requestAnimationFrame(this.render); }

  private pick(x: number, y: number): Item | null {
    if (!this.nodeMesh) return null;
    const rect = this.canvas.getBoundingClientRect();
    this.updateCamera();
    this.raycaster.setFromCamera(new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1), this.camera);
    const hit = this.raycaster.intersectObject(this.nodeMesh, false)[0];
    return hit?.instanceId === undefined ? null : this.items[hit.instanceId];
  }
  private pointOnPlane(x: number, y: number): THREE.Vector3 | null {
    const rect = this.canvas.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1), this.camera);
    return this.raycaster.ray.intersectPlane(this.dragPlane, new THREE.Vector3());
  }
  private projectedNode(id: string): { x: number; y: number } | null {
    const node = this.nodes.get(id);
    if (!node) return null;
    const p = vector(node).project(this.camera);
    const rect = this.canvas.getBoundingClientRect();
    return { x: rect.left + (p.x + 1) * rect.width / 2, y: rect.top + (-p.y + 1) * rect.height / 2 };
  }

  private onPointerDown = (event: PointerEvent) => {
    this.canvas.setPointerCapture(event.pointerId);
    const hit = this.pick(event.clientX, event.clientY);
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, sx: event.clientX, sy: event.clientY, hitId: hit?.id ?? null });
    this.pointerActive = true;
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const midpointX = (a.x + b.x) / 2, midpointY = (a.y + b.y) / 2;
      const selectedPoint = this.selectedId ? this.projectedNode(this.selectedId) : null;
      this.mode = selectedPoint && Math.hypot(midpointX - selectedPoint.x, midpointY - selectedPoint.y) < 110 ? 'pinchNode' : 'pinchCamera';
      this.pinchStart = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), cameraDistance: this.state.distance, nodeScale: this.selectedId ? this.nodes.get(this.selectedId)?.scale ?? 1 : 1, midpointX, midpointY };
      return;
    }
    this.moved = false;
    if (hit?.id.startsWith('cluster:')) {
      this.mode = null;
      this.state.target = { ...hit.position };
      this.state.distance = Math.max(35, this.state.distance * 0.55);
      this.buildGeometry(); this.invalidate(); this.callbacks.onCamera(structuredClone(this.state));
      return;
    }
    if (hit?.node) {
      if (this.linking) { this.mode = null; this.callbacks.onSelect(hit.id); return; }
      this.dragId = hit.id;
      this.mode = 'drag';
      this.selectedId = hit.id;
      this.refreshColors();
      this.callbacks.onSelect(hit.id);
      this.dragPlane.setFromNormalAndCoplanarPoint(this.camera.getWorldDirection(new THREE.Vector3()), vector(hit.position));
      const point = this.pointOnPlane(event.clientX, event.clientY);
      this.dragOffset.copy(point ? vector(hit.position).sub(point) : new THREE.Vector3());
      this.invalidate();
    } else { this.dragId = null; this.mode = event.button === 2 || event.shiftKey ? 'pan' : 'rotate'; }
  };
  private onPointerMove = (event: PointerEvent) => {
    const pointer = this.pointers.get(event.pointerId);
    if (!pointer) return;
    const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y;
    pointer.x = event.clientX; pointer.y = event.clientY;
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const ratio = Math.max(0.2, Math.hypot(a.x - b.x, a.y - b.y) / this.pinchStart.distance);
      if (this.mode === 'pinchNode' && this.selectedId) {
        this.updateNode(this.selectedId, { scale: clamp(this.pinchStart.nodeScale * ratio, 0.5, 3) });
      } else {
        this.state.distance = clamp(this.pinchStart.cameraDistance / ratio, 8, 700);
        const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
        this.pan(midX - this.pinchStart.midpointX, midY - this.pinchStart.midpointY);
        this.pinchStart.midpointX = midX; this.pinchStart.midpointY = midY;
        this.maybeRebuildClusters(); this.invalidate();
      }
      this.moved = true;
      return;
    }
    if (Math.hypot(pointer.x - pointer.sx, pointer.y - pointer.sy) > 3) this.moved = true;
    if (this.mode === 'drag' && this.dragId && this.moved && !this.linking) {
      const point = this.pointOnPlane(event.clientX, event.clientY);
      if (point) this.updateNode(this.dragId, { x: point.x + this.dragOffset.x, y: point.y + this.dragOffset.y, z: point.z + this.dragOffset.z });
    } else if (this.mode === 'rotate') {
      this.state.yaw -= dx * 0.005;
      this.state.pitch = clamp(this.state.pitch + dy * 0.005, -1.35, 1.35);
      this.invalidate();
    } else if (this.mode === 'pan') {
      this.pan(dx, dy); this.invalidate();
    }
  };
  private pan(dx: number, dy: number) {
    this.updateCamera();
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
    const scale = this.state.distance * 0.0018;
    this.state.target.x += (-right.x * dx + up.x * dy) * scale;
    this.state.target.y += (-right.y * dx + up.y * dy) * scale;
    this.state.target.z += (-right.z * dx + up.z * dy) * scale;
  }
  private onPointerUp = (event: PointerEvent) => {
    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.delete(event.pointerId);
    if (this.mode === 'drag' && this.dragId && this.moved && !this.linking) {
      const node = this.nodes.get(this.dragId);
      if (node) this.callbacks.onCommit({ ...node });
    }
    if (this.mode === 'pinchNode' && this.selectedId) {
      const node = this.nodes.get(this.selectedId);
      if (node) this.callbacks.onCommit({ ...node });
    }
    if (!this.pointers.size) {
      this.pointerActive = false;
      this.callbacks.onCamera(structuredClone(this.state));
      this.mode = null; this.dragId = null; this.lastFrame = 0;
    } else {
      this.mode = null;
    }
  };
  private onWheel = (event: WheelEvent) => {
    event.preventDefault();
    this.state.distance = clamp(this.state.distance * Math.exp(event.deltaY * 0.001), 8, 700);
    this.maybeRebuildClusters(); this.invalidate();
    this.callbacks.onCamera(structuredClone(this.state));
  };
  private onDoubleClick = (event: MouseEvent) => {
    const hit = this.pick(event.clientX, event.clientY);
    if (hit?.node) this.callbacks.onOpen(hit.id);
  };
  private preventContextMenu = (event: Event) => event.preventDefault();
  private maybeRebuildClusters() {
    if (this.nodes.size < 1700) return;
    const isClustered = this.items.some(item => item.count > 1);
    if (isClustered !== (this.state.distance >= 100)) this.buildGeometry();
  }

  run(command: NonNullable<Props['command']>) {
    if (command.type === 'in') this.state.distance = clamp(this.state.distance * 0.76, 8, 700);
    if (command.type === 'out') this.state.distance = clamp(this.state.distance * 1.32, 8, 700);
    if (command.type === 'focus' && command.nodeId) {
      const node = this.nodes.get(command.nodeId);
      if (node) { this.state.target = { x: node.x, y: node.y, z: node.z }; this.state.distance = clamp(this.state.distance, 22, 68); }
    }
    if (command.type === 'fit' && this.nodes.size) {
      const all = [...this.nodes.values()];
      const center = all.reduce((acc, node) => ({ x: acc.x + node.x / all.length, y: acc.y + node.y / all.length, z: acc.z + node.z / all.length }), { x: 0, y: 0, z: 0 });
      const radius = Math.max(18, ...all.map(node => Math.hypot(node.x - center.x, node.y - center.y, node.z - center.z)));
      this.state.target = center; this.state.distance = clamp(radius * 2.5, 35, 700);
    }
    this.maybeRebuildClusters(); this.invalidate(); this.callbacks.onCamera(structuredClone(this.state));
  }

  dispose() {
    this.resizeObserver.disconnect();
    cancelAnimationFrame(this.pendingFrame);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('dblclick', this.onDoubleClick);
    this.canvas.removeEventListener('contextmenu', this.preventContextMenu);
    this.disposeGraph();
    this.stars.geometry.dispose();
    (this.stars.material as THREE.Material).dispose();
    this.renderer.dispose();
  }
}

export function NeuronCanvas(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelsRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<NeuronEngine | null>(null);
  const callbacksRef = useRef({ onSelect: props.onSelect, onOpen: props.onOpen, onCommit: props.onCommit, onCamera: props.onCamera, onMetrics: props.onMetrics });
  callbacksRef.current = { onSelect: props.onSelect, onOpen: props.onOpen, onCommit: props.onCommit, onCamera: props.onCamera, onMetrics: props.onMetrics };

  useEffect(() => {
    const engine = new NeuronEngine(canvasRef.current!, labelsRef.current!, props.graph, callbacksRef.current);
    engineRef.current = engine;
    return () => { engine.dispose(); engineRef.current = null; };
    // Initial camera state belongs to the mounted board.
  }, [props.graph.board.id]);
  useEffect(() => { engineRef.current?.setGraph(props.graph); }, [props.graph.nodes, props.graph.edges, props.graph.board.id]);
  useEffect(() => { engineRef.current?.setSelected(props.selectedId); }, [props.selectedId]);
  useEffect(() => { engineRef.current?.setLinking(props.linking); }, [props.linking]);
  useEffect(() => { engineRef.current?.setCallbacks(callbacksRef.current); });
  useEffect(() => { if (props.command) engineRef.current?.run(props.command); }, [props.command]);

  return <div className="neuron-canvas"><canvas ref={canvasRef} aria-label="3D 뉴런 그래프" /><canvas ref={labelsRef} className="node-labels" aria-hidden="true" /></div>;
}
