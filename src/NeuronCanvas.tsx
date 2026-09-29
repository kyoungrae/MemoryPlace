import { useEffect, useLayoutEffect, useRef } from 'react';
import * as THREE from 'three';
import type { CameraState, Graph, GraphNode, Vec3 } from '../shared/types';

type Props = {
  graph: Graph;
  selectedId: string | null;
  linking: boolean;
  command: { id: number; type: 'fit' | 'focus' | 'in' | 'out'; nodeId?: string } | null;
  onSelect: (nodeId: string, anchor: { x: number; y: number }) => void;
  onLink: (sourceNodeId: string, targetNodeId: string) => void;
  onOpen: (nodeId: string) => void;
  onBackground: (anchor: { x: number; y: number } | null) => void;
  onAnchor: (nodeId: string, anchor: { x: number; y: number }) => void;
  onCommit: (node: GraphNode) => void;
  onCamera: (camera: CameraState) => void;
  onMetrics: (metrics: { frameP95: number; drawCalls: number; visibleNodes: number }) => void;
};

type Item = { id: string; title: string; position: Vec3; scale: number; color: string; node?: GraphNode; count: number };
type Pointer = { x: number; y: number; sx: number; sy: number; hitId: string | null };
type Asteroid = { sourceId: string; angle: number; orbitFactor: number; sizeFactor: number; fresh: boolean; color: string };
type AsteroidHit = { asteroid: Asteroid; index: number };
type MagneticTarget = { item: Item; strength: number };

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const vector = (value: Vec3) => new THREE.Vector3(value.x, value.y, value.z);
const wrapYaw = (yaw: number) => Math.atan2(Math.sin(yaw), Math.cos(yaw));
const hash = (value: string) => [...value].reduce((result, character) => (result * 31 + character.charCodeAt(0)) >>> 0, 17);

class NeuronEngine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(55, 1, 0.1, 2500);
  private raycaster = new THREE.Raycaster();
  private nodeMesh: THREE.InstancedMesh | null = null;
  private haloMesh: THREE.InstancedMesh | null = null;
  private lineMesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial> | null = null;
  private lineMaterial: THREE.ShaderMaterial | null = null;
  private asteroidMesh: THREE.InstancedMesh | null = null;
  private asteroidMaterial: THREE.ShaderMaterial | null = null;
  private asteroidItems: Asteroid[] = [];
  private asteroidDegrees = new Map<string, number>();
  private linkPreview: THREE.Line | null = null;
  private linkAsteroidIndex: number | null = null;
  private linkSourceId: string | null = null;
  private magnetTargetId: string | null = null;
  private linkedTargets = new Set<string>();
  private stars: THREE.Points;
  private items: Item[] = [];
  private itemById = new Map<string, number>();
  private lineEndpoints = new Map<string, { index: number; endpoint: 'start' | 'end' }[]>();
  private linePairs: { sourceId: string; targetId: string }[] = [];
  private nodes = new Map<string, GraphNode>();
  private graph: Graph;
  private selectedId: string | null = null;
  private pointers = new Map<number, Pointer>();
  private mode: 'rotate' | 'pan' | 'drag' | 'linkDrag' | 'pinchCamera' | 'pinchNode' | null = null;
  private dragId: string | null = null;
  private dragPlane = new THREE.Plane();
  private dragOffset = new THREE.Vector3();
  private moved = false;
  private pinchStart = { distance: 1, cameraDistance: 1, nodeScale: 1, midpointX: 0, midpointY: 0 };
  private state: CameraState;
  private pendingFrame = 0;
  private animationTimer: number | null = null;
  private labelsDirty = true;
  private asteroidRevealStart: number | null = null;
  private frameTimes: number[] = [];
  private lastFrame = 0;
  private qualityScale = 1;
  private pointerActive = false;
  private wheelCommitTimer: ReturnType<typeof setTimeout> | null = null;
  private labelContext: CanvasRenderingContext2D;
  private callbacks: Omit<Props, 'graph' | 'selectedId' | 'linking' | 'command'>;
  private linking = false;
  private resizeObserver: ResizeObserver;
  private tempObject = new THREE.Object3D();
  private tempColor = new THREE.Color();
  private selectedColor = new THREE.Color('#ffffff');
  private magnetColor = new THREE.Color('#b9ffe0');

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
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.setGraph(graph);
    this.resize();
  }

  setCallbacks(callbacks: NeuronEngine['callbacks']) { this.callbacks = callbacks; }
  setLinking(linking: boolean) { this.linking = linking; }
  setSelected(id: string | null) {
    this.selectedId = id; this.refreshColors(); this.refreshLineColors(); this.refreshAsteroidColors(); this.invalidate();
    if (id) this.reportAnchor(id);
  }
  private reportAnchor(id: string) {
    this.updateCamera();
    const anchor = this.projectedNode(id);
    if (anchor) this.callbacks.onAnchor(id, anchor);
  }

  setGraph(graph: Graph) {
    const sameNodes = graph.nodes.length === this.nodes.size && graph.nodes.every(node => this.nodes.has(node.id));
    if (sameNodes && this.nodeMesh && !this.items.some(item => item.count > 1)) {
      const linksChanged = graph.edges.length !== this.graph.edges.length || graph.edges.some((edge, index) => {
        const previous = this.graph.edges[index];
        return edge.sourceNodeId !== previous.sourceNodeId || edge.targetNodeId !== previous.targetNodeId;
      });
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
      if (linksChanged) { this.buildLines(); this.buildAsteroids(); }
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
    for (const mesh of [this.nodeMesh, this.haloMesh]) {
      if (mesh) { this.scene.remove(mesh); mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); }
    }
    if (this.lineMesh) { this.scene.remove(this.lineMesh); this.lineMesh.geometry.dispose(); }
    if (this.asteroidMesh) { this.scene.remove(this.asteroidMesh); this.asteroidMesh.geometry.dispose(); }
    this.nodeMesh = null; this.haloMesh = null; this.lineMesh = null; this.asteroidMesh = null;
    this.asteroidRevealStart = null;
    this.asteroidItems = []; this.linkAsteroidIndex = null; this.linkSourceId = null;
    this.magnetTargetId = null; this.linkedTargets.clear();
    this.clearLinkPreview();
    this.lineEndpoints.clear(); this.linePairs = [];
  }

  private buildGeometry() {
    this.disposeGraph();
    this.items = this.makeItems();
    this.itemById = new Map(this.items.map((item, index) => [item.id, index]));
    this.lineEndpoints.clear();
    if (!this.items.length) return;
    const circleVertex = `
      varying vec2 vCircle;
      void main() {
        vec4 center = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        float radius = length((instanceMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
        center.xy += position.xy * radius;
        vCircle = position.xy;
        gl_Position = projectionMatrix * center;
      }
    `;
    const geometry = new THREE.PlaneGeometry(2, 2);
    geometry.setAttribute('planetSeed', new THREE.InstancedBufferAttribute(new Float32Array(this.items.map(item => (hash(item.id) % 997) / 997)), 1));
    const material = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: `attribute float planetSeed; varying vec3 vColor; varying float vSeed; ${circleVertex.replace('vCircle = position.xy;', 'vCircle = position.xy; vColor = instanceColor; vSeed = planetSeed;')}`,
      fragmentShader: `
        uniform float uTime;
        varying vec2 vCircle;
        varying vec3 vColor;
        varying float vSeed;
        vec2 turn(vec2 point, float angle) {
          float s = sin(angle), c = cos(angle);
          return vec2(point.x * c - point.y * s, point.x * s + point.y * c);
        }
        float stroke(float distance, float width) {
          return 1.0 - smoothstep(width, width + max(fwidth(distance), 0.002), abs(distance));
        }
        float orbit(vec2 point, vec2 radii) {
          return stroke(length(point / radii) - 1.0, 0.008);
        }
        float spark(vec2 point, vec2 center, float size) {
          return 1.0 - smoothstep(size, size + max(fwidth(point.x), 0.002), length(point - center));
        }
        void main() {
          vec2 point = vCircle;
          float r = length(point);
          float edge = max(fwidth(r), 0.001);
          float sphere = 1.0 - smoothstep(1.0 - edge, 1.0 + edge, r);
          if (sphere < 0.001) discard;
          vec3 normal = normalize(vec3(point, sqrt(max(0.0, 1.0 - min(r, 1.0) * min(r, 1.0)))));
          float light = 0.5 + 0.5 * dot(normal, normalize(vec3(-0.48, 0.62, 0.7)));
          float rim = exp(-pow((r - 0.975) * 41.0, 2.0)) * (0.28 + 0.22 * light);
          float reflection = exp(-dot(point - vec2(-0.45, 0.47), point - vec2(-0.45, 0.47)) * 5.0) * 0.24;
          vec2 aroundCore = point - vec2(0.03, -0.01);
          float shellDistance = length(aroundCore) - 0.57;
          float shellPulse = 0.82 + 0.18 * sin(uTime * 0.6 + vSeed * 6.283185);
          float shell = exp(-pow(shellDistance * 13.0, 2.0)) * 0.11 * shellPulse;
          float shellFill = (1.0 - smoothstep(-0.08, 0.07, shellDistance)) * 0.07;
          float detail = 1.0 - smoothstep(0.018, 0.052, fwidth(point.x));
          float filaments = 0.0, stars = 0.0;
          if (detail > 0.01) {
            float firstAngle = uTime * 0.23 + vSeed * 6.283185;
            float secondAngle = -uTime * 0.17 + vSeed * 6.283185 + 1.2;
            filaments = orbit(turn(aroundCore, firstAngle), vec2(0.72, 0.36)) * 0.18;
            filaments += orbit(turn(aroundCore, secondAngle), vec2(0.58, 0.46)) * 0.13;
            filaments *= detail;
            vec2 firstSpark = turn(vec2(0.72 * cos(uTime * 0.37), 0.36 * sin(uTime * 0.37)), -firstAngle);
            vec2 secondSpark = turn(vec2(0.58 * cos(-uTime * 0.29 + 2.1), 0.46 * sin(-uTime * 0.29 + 2.1)), -secondAngle);
            stars = (spark(aroundCore, firstSpark, 0.019) * 0.8 + spark(aroundCore, secondSpark, 0.015) * 0.6) * detail;
          }
          float coreDistance = length(point - vec2(0.03, -0.01));
          float corePattern = 0.5;
          if (detail > 0.01 && coreDistance < 0.3) corePattern += 0.25 * sin(point.x * 17.0 + vSeed * 8.0) + 0.25 * sin(point.y * 14.0 - vSeed * 7.0);
          float core = (1.0 - smoothstep(0.16, 0.24, coreDistance)) * (0.42 + corePattern * detail * 0.15);
          core += stroke(coreDistance - 0.235, 0.014) * 0.26;
          core += exp(-dot(point - vec2(-0.04, 0.06), point - vec2(-0.04, 0.06)) * 95.0) * 0.22;
          float alpha = sphere * clamp(0.045 + light * 0.06 + rim + reflection + shellFill + shell + filaments + stars + core, 0.0, 0.92);
          vec3 tint = mix(vec3(0.83, 0.89, 0.96), vColor, 0.53);
          vec3 color = mix(tint, vec3(1.0), clamp(rim + filaments + stars + core, 0.0, 1.0) * 0.35);
          gl_FragColor = vec4(color, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.nodeMesh = new THREE.InstancedMesh(geometry, material, this.items.length);
    this.nodeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.nodeMesh.frustumCulled = false;
    this.nodeMesh.renderOrder = 2;
    const haloGeometry = new THREE.PlaneGeometry(2, 2);
    const haloMaterial = new THREE.ShaderMaterial({
      vertexShader: `varying vec3 vColor; ${circleVertex.replace('vCircle = position.xy;', 'vCircle = position.xy; vColor = instanceColor;')}`,
      fragmentShader: `
        varying vec2 vCircle;
        varying vec3 vColor;
        void main() {
          float r = length(vCircle);
          float atmosphere = exp(-pow((r - 0.34) * 12.0, 2.0)) * 0.18;
          float haze = pow(max(0.0, 1.0 - r), 3.0) * 0.045;
          float alpha = atmosphere + haze;
          if (alpha < 0.001) discard;
          gl_FragColor = vec4(mix(vec3(0.84, 0.9, 1.0), vColor, 0.5), alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.haloMesh = new THREE.InstancedMesh(haloGeometry, haloMaterial, this.items.length);
    this.haloMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.haloMesh.frustumCulled = false;
    this.haloMesh.renderOrder = 0;
    this.items.forEach((item, index) => this.writeMatrix(index, item));
    this.nodeMesh.instanceMatrix.needsUpdate = true;
    this.haloMesh.instanceMatrix.needsUpdate = true;
    this.refreshColors();
    this.scene.add(this.haloMesh, this.nodeMesh);

    this.buildLines();
    this.buildAsteroids();
  }

  private buildLines() {
    if (this.lineMesh) {
      this.scene.remove(this.lineMesh);
      this.lineMesh.geometry.dispose();
      this.lineMesh = null;
    }
    this.lineEndpoints.clear();
    this.linePairs = [];
    const groupByNode = new Map<string, string>();
    const size = clamp(this.state.distance / 4, 18, 45);
    for (const node of this.nodes.values()) {
      const key = `cluster:${Math.floor(node.x / size)}:${Math.floor(node.y / size)}:${Math.floor(node.z / size)}`;
      groupByNode.set(node.id, this.itemById.has(key) ? key : node.id);
    }
    const seen = new Set<string>();
    const starts: number[] = [], ends: number[] = [], colors: number[] = [];
    for (const edge of this.graph.edges) {
      const aId = groupByNode.get(edge.sourceNodeId), bId = groupByNode.get(edge.targetNodeId);
      if (!aId || !bId || aId === bId) continue;
      const key = [aId, bId].sort().join(':');
      if (seen.has(key)) continue;
      seen.add(key);
      const a = this.items[this.itemById.get(aId)!].position, b = this.items[this.itemById.get(bId)!].position;
      const index = starts.length / 3;
      starts.push(a.x, a.y, a.z);
      ends.push(b.x, b.y, b.z);
      if (aId === edge.sourceNodeId) {
        const endpoints = this.lineEndpoints.get(aId) ?? [];
        endpoints.push({ index, endpoint: 'start' });
        this.lineEndpoints.set(aId, endpoints);
      }
      if (bId === edge.targetNodeId) {
        const endpoints = this.lineEndpoints.get(bId) ?? [];
        endpoints.push({ index, endpoint: 'end' });
        this.lineEndpoints.set(bId, endpoints);
      }
      this.linePairs.push({ sourceId: edge.sourceNodeId, targetId: edge.targetNodeId });
      const focused = edge.sourceNodeId === this.selectedId || edge.targetNodeId === this.selectedId;
      const tint = focused ? [0.33, 0.92, 0.82] : [0.14, 0.29, 0.41];
      colors.push(...tint);
    }
    if (!starts.length) return;
    const lineGeometry = new THREE.InstancedBufferGeometry();
    lineGeometry.setIndex([0, 1, 2, 0, 2, 3]);
    lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -0.5, -1, 0, 0.5, -1, 0, 0.5, 1, 0, -0.5, 1, 0,
    ], 3));
    lineGeometry.setAttribute('edgeStart', new THREE.InstancedBufferAttribute(new Float32Array(starts), 3).setUsage(THREE.DynamicDrawUsage));
    lineGeometry.setAttribute('edgeEnd', new THREE.InstancedBufferAttribute(new Float32Array(ends), 3).setUsage(THREE.DynamicDrawUsage));
    lineGeometry.setAttribute('edgeColor', new THREE.InstancedBufferAttribute(new Float32Array(colors), 3).setUsage(THREE.DynamicDrawUsage));
    lineGeometry.instanceCount = starts.length / 3;
    const rect = this.canvas.getBoundingClientRect();
    const lineMaterial = this.lineMaterial ?? new THREE.ShaderMaterial({
      uniforms: {
        uResolution: { value: new THREE.Vector2(rect.width || 1, rect.height || 1) },
        uNear: { value: this.camera.near + 0.01 },
        uWidth: { value: 1.65 },
      },
      vertexShader: `
        attribute vec3 edgeStart;
        attribute vec3 edgeEnd;
        attribute vec3 edgeColor;
        uniform vec2 uResolution;
        uniform float uNear;
        uniform float uWidth;
        varying float vAcross;
        varying vec3 vColor;
        void main() {
          vec4 a = modelViewMatrix * vec4(edgeStart, 1.0);
          vec4 b = modelViewMatrix * vec4(edgeEnd, 1.0);
          float nearZ = -uNear;
          if (a.z > nearZ && b.z > nearZ) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            vAcross = 0.0;
            vColor = edgeColor;
            return;
          }
          if (a.z > nearZ) a = mix(a, b, clamp((nearZ - a.z) / (b.z - a.z), 0.0, 1.0));
          if (b.z > nearZ) b = mix(b, a, clamp((nearZ - b.z) / (a.z - b.z), 0.0, 1.0));
          vec4 clipA = projectionMatrix * a;
          vec4 clipB = projectionMatrix * b;
          vec2 startPx = (clipA.xy / clipA.w + 1.0) * 0.5 * uResolution;
          vec2 endPx = (clipB.xy / clipB.w + 1.0) * 0.5 * uResolution;
          vec2 delta = endPx - startPx;
          vec2 tangent = delta / max(length(delta), 0.0001);
          vec2 normal = vec2(-tangent.y, tangent.x);
          float t = position.x + 0.5;
          float halfExtent = uWidth * 0.5 + 1.0;
          vec2 pixel = mix(startPx, endPx, t) + normal * position.y * halfExtent;
          vec2 ndc = pixel * 2.0 / uResolution - 1.0;
          float depth = mix(clipA.z / clipA.w, clipB.z / clipB.w, t);
          gl_Position = vec4(ndc, depth, 1.0);
          vAcross = position.y * halfExtent;
          vColor = edgeColor;
        }
      `,
      fragmentShader: `
        uniform float uWidth;
        varying float vAcross;
        varying vec3 vColor;
        void main() {
          float halfWidth = uWidth * 0.5;
          float smoothEdge = max(fwidth(vAcross), 0.45);
          float alpha = 1.0 - smoothstep(halfWidth - smoothEdge, halfWidth + smoothEdge, abs(vAcross));
          if (alpha < 0.001) discard;
          gl_FragColor = vec4(vColor, alpha * 0.76);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.lineMaterial = lineMaterial;
    lineMaterial.uniforms.uResolution.value.set(rect.width || 1, rect.height || 1);
    this.lineMesh = new THREE.Mesh(lineGeometry, lineMaterial);
    this.lineMesh.frustumCulled = false;
    this.lineMesh.renderOrder = 1;
    this.scene.add(this.lineMesh);
  }

  private refreshLineColors() {
    if (!this.lineMesh) return;
    const colors = this.lineMesh.geometry.getAttribute('edgeColor') as THREE.InstancedBufferAttribute;
    this.linePairs.forEach((edge, index) => {
      const focused = edge.sourceId === this.selectedId || edge.targetId === this.selectedId;
      colors.setXYZ(index, focused ? 0.33 : 0.14, focused ? 0.92 : 0.29, focused ? 0.82 : 0.41);
    });
    colors.needsUpdate = true;
  }

  private buildAsteroids() {
    if (this.asteroidMesh) {
      this.scene.remove(this.asteroidMesh);
      this.asteroidMesh.geometry.dispose();
      this.asteroidMesh = null;
    }
    this.asteroidItems = [];
    const degree = new Map<string, number>();
    for (const edge of this.graph.edges) {
      degree.set(edge.sourceNodeId, (degree.get(edge.sourceNodeId) ?? 0) + 1);
      degree.set(edge.targetNodeId, (degree.get(edge.targetNodeId) ?? 0) + 1);
    }
    for (const item of this.items) {
      if (!item.node) continue;
      const links = degree.get(item.id) ?? 0;
      const previousLinks = this.asteroidDegrees.get(item.id);
      this.asteroidItems.push({
        sourceId: item.id,
        angle: (hash(item.id) % 628) / 100,
        orbitFactor: 1.65,
        sizeFactor: 0.22,
        fresh: previousLinks !== undefined && links > previousLinks,
        color: item.color,
      });
    }
    this.asteroidDegrees = degree;
    if (!this.asteroidItems.length) return;
    const geometry = new THREE.PlaneGeometry(2, 2);
    geometry.setAttribute('asteroidFresh', new THREE.InstancedBufferAttribute(new Float32Array(this.asteroidItems.map(item => item.fresh ? 1 : 0)), 1));
    const material = this.asteroidMaterial ?? new THREE.ShaderMaterial({
      uniforms: { uReveal: { value: 1 } },
      vertexShader: `
        attribute float asteroidFresh;
        varying vec2 vCircle;
        varying vec3 vColor;
        varying float vFresh;
        void main() {
          vec4 center = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          float radius = length((instanceMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
          center.xy += position.xy * radius;
          vCircle = position.xy;
          vColor = instanceColor;
          vFresh = asteroidFresh;
          gl_Position = projectionMatrix * center;
        }
      `,
      fragmentShader: `
        varying vec2 vCircle;
        varying vec3 vColor;
        varying float vFresh;
        uniform float uReveal;
        void main() {
          float r = length(vCircle);
          float edge = max(fwidth(r), 0.001);
          float alpha = 1.0 - smoothstep(1.0 - edge, 1.0 + edge, r);
          if (alpha < 0.001) discard;
          float core = exp(-r * r * 5.0);
          vec3 color = mix(vec3(0.87, 0.93, 1.0), vColor, 0.52) * (0.78 + core * 0.25);
          gl_FragColor = vec4(color, alpha * 0.68 * mix(1.0, 0.55 + 0.45 * uReveal, vFresh));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.asteroidMaterial = material;
    this.asteroidRevealStart = this.asteroidItems.some(item => item.fresh) ? performance.now() : null;
    material.uniforms.uReveal.value = this.asteroidRevealStart === null ? 1 : 0;
    const mesh = new THREE.InstancedMesh(geometry, material, this.asteroidItems.length);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    this.asteroidMesh = mesh;
    this.asteroidItems.forEach((asteroid, index) => this.writeAsteroidMatrix(index, asteroid));
    mesh.instanceMatrix.needsUpdate = true;
    this.refreshAsteroidColors();
    this.scene.add(mesh);
  }

  private asteroidWorldPosition(asteroid: Asteroid, result: THREE.Vector3) {
    const source = this.nodes.get(asteroid.sourceId);
    if (!source) return result.set(0, 0, 0);
    const orbit = source.scale * asteroid.orbitFactor;
    return result.set(
      source.x + Math.cos(asteroid.angle) * orbit,
      source.y + Math.sin(asteroid.angle) * orbit,
      source.z + Math.sin(asteroid.angle * 1.7) * source.scale * 0.1,
    );
  }
  private writeAsteroidMatrix(index: number, asteroid: Asteroid, position?: THREE.Vector3) {
    this.tempObject.position.copy(position ?? this.asteroidWorldPosition(asteroid, new THREE.Vector3()));
    this.tempObject.scale.setScalar((this.nodes.get(asteroid.sourceId)?.scale ?? 1) * asteroid.sizeFactor);
    this.tempObject.updateMatrix();
    this.asteroidMesh?.setMatrixAt(index, this.tempObject.matrix);
  }

  private refreshAsteroidColors() {
    if (!this.asteroidMesh) return;
    this.asteroidItems.forEach((asteroid, index) => {
      this.tempColor.set(asteroid.color);
      if (asteroid.sourceId === this.selectedId) this.tempColor.lerp(this.selectedColor, 0.2);
      this.asteroidMesh!.setColorAt(index, this.tempColor);
    });
    if (this.asteroidMesh.instanceColor) this.asteroidMesh.instanceColor.needsUpdate = true;
  }

  private clearLinkPreview() {
    if (!this.linkPreview) return;
    this.scene.remove(this.linkPreview);
    this.linkPreview.geometry.dispose();
    (this.linkPreview.material as THREE.Material).dispose();
    this.linkPreview = null;
  }

  private updateLinkPreview(source: Vec3, target: THREE.Vector3) {
    if (!this.linkPreview) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute([source.x, source.y, source.z, target.x, target.y, target.z], 3));
      this.linkPreview = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: this.magnetTargetId ? 0xb9ffe0 : 0x8cffe0, transparent: true, opacity: this.magnetTargetId ? 1 : 0.8, depthWrite: false }));
      this.linkPreview.renderOrder = 4;
      this.scene.add(this.linkPreview);
      return;
    }
    const positions = this.linkPreview.geometry.getAttribute('position') as THREE.BufferAttribute;
    positions.setXYZ(0, source.x, source.y, source.z);
    positions.setXYZ(1, target.x, target.y, target.z);
    positions.needsUpdate = true;
    const material = this.linkPreview.material as THREE.LineBasicMaterial;
    material.color.setHex(this.magnetTargetId ? 0xb9ffe0 : 0x8cffe0);
    material.opacity = this.magnetTargetId ? 1 : 0.8;
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
      this.tempColor.set(item.color);
      if (item.id === this.magnetTargetId) this.tempColor.lerp(this.magnetColor, 0.65);
      else if (item.id === this.selectedId) this.tempColor.lerp(this.selectedColor, 0.25);
      this.nodeMesh!.setColorAt(index, this.tempColor);
      this.haloMesh?.setColorAt(index, this.tempColor);
    });
    if (this.nodeMesh.instanceColor) this.nodeMesh.instanceColor.needsUpdate = true;
    if (this.haloMesh?.instanceColor) this.haloMesh.instanceColor.needsUpdate = true;
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
    if (this.asteroidMesh) {
      this.asteroidItems.forEach((asteroid, asteroidIndex) => {
        if (asteroid.sourceId === id && asteroidIndex !== this.linkAsteroidIndex) this.writeAsteroidMatrix(asteroidIndex, asteroid);
      });
      this.asteroidMesh.instanceMatrix.needsUpdate = true;
    }
    if (this.lineMesh && this.lineEndpoints.has(id)) {
      const starts = this.lineMesh.geometry.getAttribute('edgeStart') as THREE.InstancedBufferAttribute;
      const ends = this.lineMesh.geometry.getAttribute('edgeEnd') as THREE.InstancedBufferAttribute;
      let movedStart = false, movedEnd = false;
      for (const { index, endpoint } of this.lineEndpoints.get(id)!) {
        const attribute = endpoint === 'start' ? starts : ends;
        attribute.setXYZ(index, node.x, node.y, node.z);
        attribute.addUpdateRange(index * 3, 3);
        if (endpoint === 'start') movedStart = true;
        else movedEnd = true;
      }
      if (movedStart) starts.needsUpdate = true;
      if (movedEnd) ends.needsUpdate = true;
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
    if (this.lineMesh) this.lineMesh.material.uniforms.uResolution.value.set(rect.width, rect.height);
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
    context.textAlign = 'center';
    for (const { item } of candidates) {
      const p = vector(item.position).project(this.camera);
      if (p.z < -1 || p.z > 1 || Math.abs(p.x) > 1.1 || Math.abs(p.y) > 1.1) continue;
      const x = (p.x + 1) * 0.5 * width, y = (-p.y + 1) * 0.5 * height;
      const depth = -vector(item.position).applyMatrix4(this.camera.matrixWorldInverse).z;
      const radius = item.scale * 0.88 * height / (2 * depth * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
      const prominent = radius >= 70;
      const labelY = y + Math.max(12, radius + 10);
      const label = item.title.length > 24 ? `${item.title.slice(0, 23)}…` : item.title;
      context.font = `${prominent ? 16 : 12}px system-ui, sans-serif`;
      const boxWidth = Math.min(240, Math.max(prominent ? 112 : 0, context.measureText(label).width + 20));
      const boxHeight = prominent ? 34 : 24;
      context.fillStyle = item.id === this.selectedId ? 'rgba(5, 25, 33, .86)' : 'rgba(7, 16, 31, .76)';
      context.beginPath(); context.roundRect(x - boxWidth / 2, labelY, boxWidth, boxHeight, prominent ? 10 : 7); context.fill();
      if (prominent) { context.strokeStyle = 'rgba(205, 221, 236, .34)'; context.lineWidth = 1; context.stroke(); }
      context.fillStyle = item.id === this.selectedId ? '#d8fff4' : '#b8ccd8';
      context.fillText(label, x, labelY + (prominent ? 22 : 16));
    }
  }

  private render = (time: number) => {
    this.pendingFrame = 0;
    this.updateCamera();
    const animateShells = Boolean(this.nodeMesh) && this.state.distance < 100
      && document.visibilityState === 'visible'
      && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (this.nodeMesh) (this.nodeMesh.material as THREE.ShaderMaterial).uniforms.uTime.value = animateShells ? time * 0.001 : 0;
    if (this.asteroidRevealStart !== null && this.asteroidMaterial) {
      const progress = Math.min(1, (time - this.asteroidRevealStart) / 350);
      this.asteroidMaterial.uniforms.uReveal.value = progress * (2 - progress);
      if (progress < 1) this.invalidate();
      else this.asteroidRevealStart = null;
    }
    this.renderer.render(this.scene, this.camera);
    if (this.labelsDirty) { this.drawLabels(); this.labelsDirty = false; }
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
    else if (animateShells && this.animationTimer === null) {
      this.animationTimer = window.setTimeout(() => {
        this.animationTimer = null;
        this.invalidate(false);
      }, window.innerWidth < 700 ? 42 : 26);
    }
  };
  private invalidate(labels = true) {
    if (labels) this.labelsDirty = true;
    if (!this.pendingFrame) this.pendingFrame = requestAnimationFrame(this.render);
  }
  private onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      if (this.animationTimer !== null) clearTimeout(this.animationTimer);
      this.animationTimer = null;
    } else this.invalidate(false);
  };

  private pick(x: number, y: number): Item | null {
    if (!this.nodeMesh) return null;
    const rect = this.canvas.getBoundingClientRect();
    this.updateCamera();
    const focal = 1 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const center = new THREE.Vector3();
    let nearest: Item | null = null;
    let nearestDepth = Infinity;
    for (const item of this.items) {
      center.set(item.position.x, item.position.y, item.position.z).applyMatrix4(this.camera.matrixWorldInverse);
      const depth = -center.z;
      if (depth <= this.camera.near || depth >= this.camera.far || depth >= nearestDepth) continue;
      const screenX = rect.left + (1 + center.x * focal / (this.camera.aspect * depth)) * rect.width / 2;
      const screenY = rect.top + (1 - center.y * focal / depth) * rect.height / 2;
      const radius = item.scale * 0.88 * focal * rect.height / (2 * depth);
      if (Math.hypot(screenX - x, screenY - y) <= Math.max(radius, 8)) {
        nearest = item;
        nearestDepth = depth;
      }
    }
    return nearest;
  }
  private pickAsteroid(x: number, y: number): AsteroidHit | null {
    if (!this.asteroidMesh) return null;
    const rect = this.canvas.getBoundingClientRect();
    this.updateCamera();
    const focal = 1 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const world = new THREE.Vector3();
    const view = new THREE.Vector3();
    let result: AsteroidHit | null = null;
    let nearestDepth = Infinity;
    this.asteroidItems.forEach((asteroid, index) => {
      this.asteroidWorldPosition(asteroid, world);
      view.copy(world).applyMatrix4(this.camera.matrixWorldInverse);
      const depth = -view.z;
      if (depth <= this.camera.near || depth >= this.camera.far || depth >= nearestDepth) return;
      const screenX = rect.left + (1 + view.x * focal / (this.camera.aspect * depth)) * rect.width / 2;
      const screenY = rect.top + (1 - view.y * focal / depth) * rect.height / 2;
      const radius = Math.max(10, (this.nodes.get(asteroid.sourceId)?.scale ?? 1) * asteroid.sizeFactor * focal * rect.height * 1.25 / depth);
      if (Math.hypot(screenX - x, screenY - y) <= radius) {
        result = { asteroid, index };
        nearestDepth = depth;
      }
    });
    return result;
  }
  private pickMagneticTarget(sourceId: string, x: number, y: number): MagneticTarget | null {
    const rect = this.canvas.getBoundingClientRect();
    this.updateCamera();
    const focal = 1 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const view = new THREE.Vector3();
    let nearest: MagneticTarget | null = null;
    let nearestScore = Infinity;
    for (const item of this.items) {
      if (!item.node || item.id === sourceId || this.linkedTargets.has(item.id)) continue;
      view.set(item.position.x, item.position.y, item.position.z).applyMatrix4(this.camera.matrixWorldInverse);
      const depth = -view.z;
      if (depth <= this.camera.near || depth >= this.camera.far) continue;
      const screenX = rect.left + (1 + view.x * focal / (this.camera.aspect * depth)) * rect.width / 2;
      const screenY = rect.top + (1 - view.y * focal / depth) * rect.height / 2;
      const radius = Math.max(8, item.scale * 0.88 * focal * rect.height / (2 * depth));
      const captureRadius = radius + 36 + (item.id === this.magnetTargetId ? 16 : 0);
      const distance = Math.hypot(screenX - x, screenY - y);
      if (distance > captureRadius) continue;
      const score = Math.max(0, distance - radius) + distance * 0.03;
      if (score >= nearestScore) continue;
      const pull = clamp((captureRadius - distance) / (captureRadius - radius), 0, 1);
      nearest = { item, strength: pull * pull * (3 - 2 * pull) };
      nearestScore = score;
    }
    return nearest;
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

  private startLinkDrag(hit: AsteroidHit, event: PointerEvent) {
    const source = this.nodes.get(hit.asteroid.sourceId);
    if (!source) return;
    this.mode = 'linkDrag';
    this.dragId = null;
    this.linkAsteroidIndex = hit.index;
    this.linkSourceId = hit.asteroid.sourceId;
    this.linkedTargets.clear();
    for (const edge of this.graph.edges) {
      if (edge.sourceNodeId === hit.asteroid.sourceId) this.linkedTargets.add(edge.targetNodeId);
      else if (edge.targetNodeId === hit.asteroid.sourceId) this.linkedTargets.add(edge.sourceNodeId);
    }
    this.selectedId = hit.asteroid.sourceId;
    this.refreshColors();
    this.refreshLineColors();
    this.refreshAsteroidColors();
    this.dragPlane.setFromNormalAndCoplanarPoint(this.camera.getWorldDirection(new THREE.Vector3()), this.asteroidWorldPosition(hit.asteroid, new THREE.Vector3()));
    this.moveLinkDrag(event.clientX, event.clientY);
  }
  private moveLinkDrag(x: number, y: number) {
    if (this.linkAsteroidIndex === null || !this.linkSourceId) return;
    const source = this.nodes.get(this.linkSourceId);
    const asteroid = this.asteroidItems[this.linkAsteroidIndex];
    const point = this.pointOnPlane(x, y);
    if (!source || !asteroid || !point) return;
    const magnetic = this.pickMagneticTarget(this.linkSourceId, x, y);
    const targetId = magnetic?.item.id ?? null;
    if (targetId !== this.magnetTargetId) {
      this.magnetTargetId = targetId;
      this.refreshColors();
    }
    if (magnetic) {
      const target = vector(magnetic.item.position);
      const towardSource = vector(source).sub(target).normalize();
      point.lerp(target.addScaledVector(towardSource, magnetic.item.scale * 0.88), magnetic.strength);
    }
    this.writeAsteroidMatrix(this.linkAsteroidIndex, asteroid, point);
    if (this.asteroidMesh) this.asteroidMesh.instanceMatrix.needsUpdate = true;
    this.updateLinkPreview(source, point);
    this.invalidate();
  }
  private finishLinkDrag(x: number, y: number, shouldLink: boolean) {
    const sourceId = this.linkSourceId;
    const target = sourceId && shouldLink ? this.pickMagneticTarget(sourceId, x, y)?.item ?? this.pick(x, y) : null;
    const canLink = !!sourceId && !!target?.node && target.id !== sourceId && !this.linkedTargets.has(target.id);
    this.linkAsteroidIndex = null;
    this.linkSourceId = null;
    this.magnetTargetId = null;
    this.linkedTargets.clear();
    this.clearLinkPreview();
    this.buildAsteroids();
    this.refreshColors();
    if (canLink && sourceId && target) this.callbacks.onLink(sourceId, target.id);
    this.invalidate();
  }

  private onPointerDown = (event: PointerEvent) => {
    this.canvas.setPointerCapture(event.pointerId);
    const hit = this.pick(event.clientX, event.clientY);
    const asteroidHit = event.ctrlKey ? null : this.pickAsteroid(event.clientX, event.clientY);
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, sx: event.clientX, sy: event.clientY, hitId: asteroidHit?.asteroid.sourceId ?? hit?.id ?? null });
    this.pointerActive = true;
    if (this.pointers.size === 2) {
      if (this.mode === 'linkDrag') this.finishLinkDrag(event.clientX, event.clientY, false);
      const [a, b] = [...this.pointers.values()];
      const midpointX = (a.x + b.x) / 2, midpointY = (a.y + b.y) / 2;
      const selectedPoint = this.selectedId ? this.projectedNode(this.selectedId) : null;
      this.mode = selectedPoint && Math.hypot(midpointX - selectedPoint.x, midpointY - selectedPoint.y) < 110 ? 'pinchNode' : 'pinchCamera';
      this.pinchStart = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), cameraDistance: this.state.distance, nodeScale: this.selectedId ? this.nodes.get(this.selectedId)?.scale ?? 1 : 1, midpointX, midpointY };
      return;
    }
    this.moved = false;
    if (event.ctrlKey) { this.dragId = null; this.mode = 'rotate'; return; }
    if (asteroidHit) { this.startLinkDrag(asteroidHit, event); return; }
    if (hit?.id.startsWith('cluster:')) {
      this.mode = null;
      this.state.target = { ...hit.position };
      this.state.distance = Math.max(35, this.state.distance * 0.55);
      this.buildGeometry(); this.invalidate(); this.callbacks.onCamera(structuredClone(this.state));
      return;
    }
    if (hit?.node) {
      const anchor = this.projectedNode(hit.id) ?? { x: event.clientX, y: event.clientY };
      if (this.linking) { this.mode = null; this.callbacks.onSelect(hit.id, anchor); return; }
      this.dragId = hit.id;
      this.mode = 'drag';
      this.selectedId = hit.id;
      this.refreshColors();
      this.refreshLineColors();
      this.callbacks.onSelect(hit.id, anchor);
      this.dragPlane.setFromNormalAndCoplanarPoint(this.camera.getWorldDirection(new THREE.Vector3()), vector(hit.position));
      const point = this.pointOnPlane(event.clientX, event.clientY);
      this.dragOffset.copy(point ? vector(hit.position).sub(point) : new THREE.Vector3());
      this.invalidate();
    } else { this.dragId = null; this.mode = 'pan'; }
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
    if (this.mode === 'linkDrag') { this.moveLinkDrag(event.clientX, event.clientY); return; }
    if (this.mode === 'rotate' && !event.ctrlKey) this.mode = 'pan';
    else if (this.mode === 'pan' && event.ctrlKey) this.mode = 'rotate';
    if (this.mode === 'drag' && this.dragId && this.moved && !this.linking) {
      const point = this.pointOnPlane(event.clientX, event.clientY);
      if (point) this.updateNode(this.dragId, { x: point.x + this.dragOffset.x, y: point.y + this.dragOffset.y, z: point.z + this.dragOffset.z });
    } else if (this.mode === 'rotate') {
      this.state.yaw = wrapYaw(this.state.yaw - dx * 0.005);
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
    const height = this.canvas.getBoundingClientRect().height || 1;
    const scale = 2 * this.state.distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) / height;
    this.state.target.x += (-right.x * dx + up.x * dy) * scale;
    this.state.target.y += (-right.y * dx + up.y * dy) * scale;
    this.state.target.z += (-right.z * dx + up.z * dy) * scale;
  }
  private onPointerUp = (event: PointerEvent) => {
    const pointer = this.pointers.get(event.pointerId);
    if (!pointer) return;
    const wasLinkDrag = this.mode === 'linkDrag';
    const backgroundClick = event.type === 'pointerup' && this.pointers.size === 1 && !this.moved && !pointer.hitId && !wasLinkDrag;
    if (wasLinkDrag) this.finishLinkDrag(event.clientX, event.clientY, event.type === 'pointerup');
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
      if (backgroundClick) this.callbacks.onBackground(this.selectedId ? this.projectedNode(this.selectedId) : null);
      else if (this.selectedId) this.reportAnchor(this.selectedId);
      this.callbacks.onCamera(structuredClone(this.state));
      this.mode = null; this.dragId = null; this.lastFrame = 0;
    } else {
      this.mode = null;
    }
  };
  private onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const scaleX = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? this.canvas.clientWidth : 1;
    const scaleY = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? this.canvas.clientHeight : 1;
    if (event.ctrlKey) {
      if (event.deltaY) {
        this.state.distance = clamp(this.state.distance * Math.exp(event.deltaY * scaleY * 0.001), 8, 700);
        this.maybeRebuildClusters();
      }
    } else {
      this.pan(-event.deltaX * scaleX, -event.deltaY * scaleY);
    }
    if (!event.deltaX && !event.deltaY) return;
    this.invalidate();
    if (this.wheelCommitTimer) clearTimeout(this.wheelCommitTimer);
    this.wheelCommitTimer = setTimeout(() => {
      this.wheelCommitTimer = null;
      if (this.selectedId) this.reportAnchor(this.selectedId);
      this.callbacks.onCamera(structuredClone(this.state));
    }, 120);
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
    this.maybeRebuildClusters(); this.invalidate();
    if (this.selectedId) this.reportAnchor(this.selectedId);
    this.callbacks.onCamera(structuredClone(this.state));
  }

  dispose() {
    this.resizeObserver.disconnect();
    cancelAnimationFrame(this.pendingFrame);
    if (this.animationTimer !== null) clearTimeout(this.animationTimer);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    if (this.wheelCommitTimer) {
      clearTimeout(this.wheelCommitTimer);
      this.callbacks.onCamera(structuredClone(this.state));
    }
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('dblclick', this.onDoubleClick);
    this.canvas.removeEventListener('contextmenu', this.preventContextMenu);
    this.disposeGraph();
    this.lineMaterial?.dispose();
    this.lineMaterial = null;
    this.asteroidMaterial?.dispose();
    this.asteroidMaterial = null;
    this.stars.geometry.dispose();
    (this.stars.material as THREE.Material).dispose();
    this.renderer.dispose();
  }
}

export function NeuronCanvas(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelsRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<NeuronEngine | null>(null);
  const callbacksRef = useRef({ onSelect: props.onSelect, onLink: props.onLink, onOpen: props.onOpen, onBackground: props.onBackground, onAnchor: props.onAnchor, onCommit: props.onCommit, onCamera: props.onCamera, onMetrics: props.onMetrics });
  callbacksRef.current = { onSelect: props.onSelect, onLink: props.onLink, onOpen: props.onOpen, onBackground: props.onBackground, onAnchor: props.onAnchor, onCommit: props.onCommit, onCamera: props.onCamera, onMetrics: props.onMetrics };

  useEffect(() => {
    const engine = new NeuronEngine(canvasRef.current!, labelsRef.current!, props.graph, callbacksRef.current);
    engineRef.current = engine;
    return () => { engine.dispose(); engineRef.current = null; };
    // Initial camera state belongs to the mounted board.
  }, [props.graph.board.id]);
  useEffect(() => { engineRef.current?.setGraph(props.graph); }, [props.graph.nodes, props.graph.edges, props.graph.board.id]);
  useEffect(() => { engineRef.current?.setSelected(props.selectedId); }, [props.selectedId]);
  useEffect(() => { engineRef.current?.setLinking(props.linking); }, [props.linking]);
  useLayoutEffect(() => { engineRef.current?.setCallbacks(callbacksRef.current); });
  useEffect(() => { if (props.command) engineRef.current?.run(props.command); }, [props.command]);

  return <div className="neuron-canvas"><canvas ref={canvasRef} aria-label="3D 뉴런 그래프" /><canvas ref={labelsRef} className="node-labels" aria-hidden="true" /></div>;
}
